from __future__ import annotations

import json
import math
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .auth import load_auth_state, refresh_auth_state
from .http import Transport, UrllibTransport

CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CODEX_USAGE_TIMEOUT_SECONDS = 15.0
CODEX_QUOTA_CACHE_TTL_SECONDS = 30.0

_WINDOW_DEFINITIONS = (
    ("primary_window", "Session", 5 * 60 * 60),
    ("secondary_window", "Weekly", 7 * 24 * 60 * 60),
)

_cache_lock = threading.Lock()
_cached_result: dict[str, Any] | None = None
_cached_at = 0.0


def _unavailable(reason: str) -> dict[str, Any]:
    return {
        "available": False,
        "status": "unavailable",
        "reason": reason,
        "remaining_percent": None,
        "windows": [],
        "fetched_at": None,
    }


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        number = float(value)
    except (OverflowError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _iso_timestamp(value: Any) -> str | None:
    number = _finite_number(value)
    if number is not None:
        try:
            return datetime.fromtimestamp(number, tz=UTC).isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC).isoformat()


def _window_payload(raw: Any, label: str, default_seconds: int) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    used = _finite_number(raw.get("used_percent"))
    if used is None:
        return None
    used = max(0.0, min(100.0, used))
    window_seconds = _finite_number(raw.get("limit_window_seconds"))
    if window_seconds is None or window_seconds <= 0:
        window_seconds = default_seconds
    return {
        "label": label,
        "used_percent": used,
        "remaining_percent": int(round(100.0 - used)),
        "reset_at": _iso_timestamp(raw.get("reset_at")),
        "window_seconds": int(window_seconds),
    }


def _usage_request(state: Any, transport: Transport):
    headers = {
        "Authorization": f"Bearer {state.access_token}",
        "Accept": "application/json",
        "User-Agent": "codex-cli",
    }
    if state.account_id:
        headers["ChatGPT-Account-Id"] = state.account_id
    return transport.request(
        method="GET",
        url=CODEX_USAGE_URL,
        headers=headers,
        body=b"",
    )


def fetch_codex_quota(
    *,
    auth_path: str | Path | None = None,
    transport: Transport | None = None,
) -> dict[str, Any]:
    try:
        state = load_auth_state(auth_path)
    except FileNotFoundError:
        return _unavailable("auth-file-missing")
    except (AttributeError, OSError, TypeError, ValueError):
        return _unavailable("auth-file-invalid")

    if not state.access_token:
        return _unavailable("auth-missing")

    client = transport or UrllibTransport(timeout=CODEX_USAGE_TIMEOUT_SECONDS)
    try:
        response = _usage_request(state, client)
        if response.status == 401 and state.refresh_token:
            state = refresh_auth_state(state, transport=client)
            response = _usage_request(state, client)
    except (AttributeError, OSError, OverflowError, RuntimeError, TimeoutError, TypeError, ValueError):
        return _unavailable("auth-refresh-failed")

    if response.status == 401:
        return _unavailable("auth-required")
    if response.status == 429:
        return _unavailable("rate-limited")
    if response.status < 200 or response.status >= 300:
        return _unavailable("quota-unavailable")

    try:
        payload = json.loads(response.body.decode("utf-8"))
    except (UnicodeError, ValueError):
        return _unavailable("quota-invalid")
    if not isinstance(payload, dict):
        return _unavailable("quota-invalid")

    rate_limit = payload.get("rate_limit")
    if not isinstance(rate_limit, dict):
        return _unavailable("quota-data-unavailable")

    windows = []
    for key, label, default_seconds in _WINDOW_DEFINITIONS:
        window = _window_payload(rate_limit.get(key), label, default_seconds)
        if window is not None:
            windows.append(window)
    if not windows:
        return _unavailable("quota-data-unavailable")

    return {
        "available": True,
        "status": "available",
        "reason": None,
        "remaining_percent": min(window["remaining_percent"] for window in windows),
        "windows": windows,
        "fetched_at": datetime.now(UTC).isoformat(),
    }


def get_codex_quota() -> dict[str, Any]:
    global _cached_result, _cached_at

    now = time.monotonic()
    with _cache_lock:
        if (
            _cached_result is not None
            and now - _cached_at < CODEX_QUOTA_CACHE_TTL_SECONDS
        ):
            return dict(_cached_result)

    result = fetch_codex_quota()
    if result["available"]:
        with _cache_lock:
            _cached_result = dict(result)
            _cached_at = time.monotonic()
    return result
