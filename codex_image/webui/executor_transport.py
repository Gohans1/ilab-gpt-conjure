from __future__ import annotations

import asyncio
import errno
import http.client
import os
import ssl
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncContextManager, Callable
from urllib import error as urllib_error

from codex_image.client import CodexImagesImageClient, ImageResult, OpenAIImagesImageClient, OpenAIResponsesImageClient
from codex_image.prompt_guard import build_guarded_prompt

from .storage import TaskStorage

DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS = 600.0
DEFAULT_API_MODE = "images"
DEFAULT_API_IMAGES_CONCURRENCY = 4
MIN_API_IMAGES_CONCURRENCY = 1
MAX_API_IMAGES_CONCURRENCY = 32
MAX_TRANSIENT_IMAGE_REQUEST_ATTEMPTS = 3
TRANSIENT_IMAGE_RETRY_BASE_DELAY_SECONDS = 0.5
TRANSIENT_IMAGE_RETRY_MAX_DELAY_SECONDS = 2.0
PROMPT_FIDELITY_MODES = {"strict", "original", "off"}
DEFAULT_PROMPT_FIDELITY = "strict"


def _normalize_api_mode(value: Any) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in {"images", "responses"} else DEFAULT_API_MODE


def _normalize_api_images_concurrency(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = DEFAULT_API_IMAGES_CONCURRENCY
    return min(MAX_API_IMAGES_CONCURRENCY, max(MIN_API_IMAGES_CONCURRENCY, parsed))


def _image_request_timeout_seconds() -> float:
    raw = os.getenv("CODEX_IMAGE_REQUEST_TIMEOUT_SECONDS", "").strip()
    if not raw:
        return DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS
    try:
        parsed = float(raw)
    except ValueError:
        return DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS
    return parsed if parsed > 0 else DEFAULT_IMAGE_REQUEST_TIMEOUT_SECONDS


def _normalize_prompt_fidelity(value: Any) -> str:
    mode = str(value or DEFAULT_PROMPT_FIDELITY).strip().lower()
    if mode == "raw":
        return "original"
    return mode if mode in PROMPT_FIDELITY_MODES else DEFAULT_PROMPT_FIDELITY


def _direct_images_transport(auth_source: str, api_mode: str | None) -> bool:
    return auth_source in {"api", "codex"} and _normalize_api_mode(api_mode) == "images"


def _prompt_for_transport(prompt: str, *, auth_source: str, api_mode: str | None, prompt_fidelity: str, instructions: str) -> str:
    if _direct_images_transport(auth_source, api_mode) and _normalize_prompt_fidelity(prompt_fidelity) == "strict":
        return build_guarded_prompt(prompt, instructions)
    return prompt


def _instructions_for_transport(*, auth_source: str, api_mode: str | None, instructions: str) -> str | None:
    if not instructions:
        return None
    if _direct_images_transport(auth_source, api_mode):
        return None
    return instructions


@asynccontextmanager
async def _noop_request_context():
    yield


def _format_elapsed_seconds(seconds: float) -> str:
    return f"{max(0.0, seconds):.2f}".rstrip("0").rstrip(".")


def _exception_chain(exc: BaseException) -> list[BaseException]:
    chain: list[BaseException] = []
    pending: list[BaseException] = [exc]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        chain.append(current)
        reason = current.reason if isinstance(current, urllib_error.URLError) else None
        for nested in (reason, current.__cause__, current.__context__):
            if isinstance(nested, BaseException):
                pending.append(nested)
    return chain


def _is_retryable_transient_image_error(exc: BaseException) -> bool:
    chain = _exception_chain(exc)
    message = "\n".join(str(item).lower() for item in chain)
    if (
        "http 502" in message
        and (
            "upstream_error" in message
            or "upstream service temporarily unavailable" in message
        )
    ):
        return True

    retryable_types = (
        ssl.SSLEOFError,
        ConnectionResetError,
        ConnectionAbortedError,
        BrokenPipeError,
        http.client.RemoteDisconnected,
    )
    retryable_errnos = {
        errno.ECONNABORTED,
        errno.ECONNRESET,
        errno.EPIPE,
    }
    for item in chain:
        if isinstance(item, retryable_types):
            return True
        if isinstance(item, OSError) and item.errno in retryable_errnos:
            return True

    return any(
        marker in message
        for marker in (
            "unexpected_eof_while_reading",
            "eof occurred in violation of protocol",
            "connection reset by peer",
            "connection aborted",
            "remote end closed connection without response",
            "remote disconnected",
            "broken pipe",
        )
    )


def _transient_image_retry_delay_seconds(failed_attempt: int) -> float:
    exponent = max(0, int(failed_attempt) - 1)
    return min(
        TRANSIENT_IMAGE_RETRY_MAX_DELAY_SECONDS,
        TRANSIENT_IMAGE_RETRY_BASE_DELAY_SECONDS * (2**exponent),
    )


def _image_request_attempts(value: Any, default: int = 1) -> int:
    try:
        attempts = int(getattr(value, "_image_request_attempts", default))
    except (TypeError, ValueError):
        attempts = default
    return max(1, attempts)


async def _call_image_client_once(
    method: Callable[..., ImageResult],
    *,
    timeout_seconds: float | None,
    kwargs: dict[str, Any],
) -> ImageResult:
    call = asyncio.create_task(asyncio.to_thread(method, **kwargs))
    if timeout_seconds is None:
        return await call
    started_at = time.monotonic()
    try:
        return await asyncio.wait_for(call, timeout=timeout_seconds)
    except TimeoutError as exc:
        if call.done() and not call.cancelled():
            raise
        elapsed = _format_elapsed_seconds(time.monotonic() - started_at)
        raise TimeoutError(
            f"Image request timed out after {elapsed}s (timeout limit {timeout_seconds:g}s)"
        ) from exc


async def _call_image_client(
    request_context: Callable[[dict[str, Any]], AsyncContextManager[None]] | None,
    params: dict[str, Any],
    method: Callable[..., ImageResult],
    timeout_seconds: float | None = None,
    **kwargs: Any,
) -> ImageResult:
    for attempt in range(1, MAX_TRANSIENT_IMAGE_REQUEST_ATTEMPTS + 1):
        context = request_context(params) if request_context is not None else _noop_request_context()
        try:
            async with context:
                result = await _call_image_client_once(
                    method,
                    timeout_seconds=timeout_seconds,
                    kwargs=kwargs,
                )
        except Exception as exc:
            try:
                setattr(exc, "_image_request_attempts", attempt)
            except Exception:
                pass
            if (
                attempt >= MAX_TRANSIENT_IMAGE_REQUEST_ATTEMPTS
                or not _is_retryable_transient_image_error(exc)
            ):
                raise
            await asyncio.sleep(_transient_image_retry_delay_seconds(attempt))
            continue
        setattr(result, "_image_request_attempts", attempt)
        return result
    raise RuntimeError("Image request retry loop completed without a result")


def _direct_images_concurrent_enabled(client: Any, auth_source: str, api_mode: str | None) -> bool:
    declared = getattr(client, "direct_images_concurrent", None)
    if isinstance(declared, bool):
        return declared
    image_client_classes: tuple[type[Any], ...] = (OpenAIImagesImageClient, CodexImagesImageClient)
    api_responses_client_classes: tuple[type[Any], ...] = (OpenAIResponsesImageClient,)
    try:
        from . import executor as executor_module

        image_client_classes = (
            getattr(executor_module, "OpenAIImagesImageClient", OpenAIImagesImageClient),
            getattr(executor_module, "CodexImagesImageClient", CodexImagesImageClient),
        )
        api_responses_client_classes = (
            getattr(executor_module, "OpenAIResponsesImageClient", OpenAIResponsesImageClient),
        )
    except Exception:
        image_client_classes = (OpenAIImagesImageClient, CodexImagesImageClient)
        api_responses_client_classes = (OpenAIResponsesImageClient,)
    mode = _normalize_api_mode(api_mode)
    if auth_source == "api" and mode == "responses":
        return isinstance(client, api_responses_client_classes)
    return auth_source in {"api", "codex"} and mode == "images" and isinstance(client, image_client_classes)


def _debug_sse_path(storage: TaskStorage, task_id: str) -> Path | None:
    enabled = os.getenv("CODEX_IMAGE_DEBUG_SSE", "").strip().lower()
    if enabled not in {"1", "true", "yes", "on"}:
        return None
    return storage.debug_sse_path(task_id)


def _is_usage_limit_error(exc: BaseException) -> bool:
    message = str(exc).lower()
    return (
        "usage_limit_reached" in message
        or "usage limit" in message
        or "insufficient_user_quota" in message
        or "余额不足" in message
        or "预扣费额度失败" in message
    )


def _parse_optional_int(value: str | None) -> int | None:
    if value in (None, ""):
        return None
    return int(value)


def _normalize_compression(output_format: str, value: str | None) -> int | None:
    if output_format.lower() == "png":
        return None
    return _parse_optional_int(value)
