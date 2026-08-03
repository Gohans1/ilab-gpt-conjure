from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Literal, Mapping, cast
from urllib.parse import urlsplit, urlunsplit

from codex_image.httpx_transport import HttpxTransport

from .schemas import DEFAULT_WEBUI_NETWORK_EGRESS_SETTINGS_PATH

NetworkEgressMode = Literal["system", "direct", "custom"]
NetworkEgressRoute = Literal["system", "direct", "proxy"]

_DEFAULT_SETTINGS = {"mode": "system", "custom_proxy_url": ""}
_VALID_MODES = frozenset({"system", "direct", "custom"})


def _normalize_proxy_url(value: Any) -> str:
    candidate = str(value or "").strip()
    if not candidate:
        return ""

    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Custom proxy URL is invalid") from exc

    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise ValueError("Custom proxy URL must use http or https")
    if not parsed.hostname:
        raise ValueError("Custom proxy URL must include a host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Custom proxy URL must not include credentials")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ValueError("Custom proxy URL must be an origin without a path, query, or fragment")

    hostname = parsed.hostname
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    netloc = hostname
    if port is not None:
        netloc = f"{netloc}:{port}"
    return urlunsplit((scheme, netloc, "", "", ""))


def _normalize_settings(
    payload: Mapping[str, Any],
    *,
    current: Mapping[str, str] | None = None,
) -> dict[str, str]:
    baseline = current or _DEFAULT_SETTINGS
    mode = str(payload.get("mode", baseline["mode"]) or "").strip().lower()
    if mode not in _VALID_MODES:
        raise ValueError("Network egress mode must be system, direct, or custom")

    custom_proxy_url = _normalize_proxy_url(
        payload.get("custom_proxy_url", baseline.get("custom_proxy_url", ""))
    )
    if mode == "custom" and not custom_proxy_url:
        raise ValueError("Custom proxy URL is required in custom mode")
    return {
        "mode": mode,
        "custom_proxy_url": custom_proxy_url,
    }


@dataclass(frozen=True)
class NetworkEgressSnapshot:
    mode: NetworkEgressMode
    route: NetworkEgressRoute
    proxy_map: Mapping[str, str] | None

    def task_metadata(self) -> dict[str, str]:
        return {
            "mode": self.mode,
            "route": self.route,
        }


class NetworkEgressSettings:
    def __init__(self, path: Path | str = DEFAULT_WEBUI_NETWORK_EGRESS_SETTINGS_PATH) -> None:
        self.path = Path(path)

    def read(self) -> dict[str, str]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return dict(_DEFAULT_SETTINGS)
        if not isinstance(payload, dict):
            return dict(_DEFAULT_SETTINGS)
        try:
            return _normalize_settings(payload)
        except ValueError:
            return dict(_DEFAULT_SETTINGS)

    def write(self, payload: Mapping[str, Any]) -> dict[str, str]:
        clean = _normalize_settings(payload, current=self.read())
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                delete=False,
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
            ) as tmp:
                tmp_path = tmp.name
                tmp.write(json.dumps(clean, indent=2, ensure_ascii=False))
                tmp.flush()
                os.fsync(tmp.fileno())
            os.replace(tmp_path, self.path)
            tmp_path = None
        finally:
            if tmp_path is not None:
                try:
                    Path(tmp_path).unlink()
                except FileNotFoundError:
                    pass
        return dict(clean)


class NetworkEgressManager:
    def __init__(self, settings: NetworkEgressSettings | None = None) -> None:
        self.settings = settings or NetworkEgressSettings()

    def snapshot(self, payload: Mapping[str, Any] | None = None) -> NetworkEgressSnapshot:
        clean = self.settings.read() if payload is None else _normalize_settings(payload)
        mode = cast(NetworkEgressMode, clean["mode"])
        if mode == "system":
            return NetworkEgressSnapshot(mode=mode, route="system", proxy_map=None)
        if mode == "direct":
            return NetworkEgressSnapshot(
                mode=mode,
                route="direct",
                proxy_map=MappingProxyType({}),
            )

        proxy_url = clean["custom_proxy_url"]
        return NetworkEgressSnapshot(
            mode=mode,
            route="proxy",
            proxy_map=MappingProxyType({"http": proxy_url, "https": proxy_url}),
        )

    @staticmethod
    def transport(snapshot: NetworkEgressSnapshot) -> HttpxTransport:
        return HttpxTransport(proxy_map=snapshot.proxy_map)
