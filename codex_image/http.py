from __future__ import annotations

import os
import socket
import ssl
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Mapping, Protocol
from urllib import error, request
from urllib.parse import urlsplit

DEFAULT_REQUEST_TIMEOUT_SECONDS = 600.0
MAX_HTTP_RESPONSE_BYTES = 320 * 1024 * 1024
MAX_HTTP_ERROR_BODY_BYTES = 2 * 1024 * 1024
_CREDENTIAL_HEADER_NAMES = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "x-goog-api-key",
        "x-api-key",
        "api-key",
    }
)


class HTTPResponseTooLarge(RuntimeError):
    pass


def _request_timeout_seconds(value: float | None = None) -> float:
    if value is not None:
        return float(value)
    raw = os.getenv("CODEX_IMAGE_REQUEST_TIMEOUT_SECONDS", "").strip()
    if not raw:
        return DEFAULT_REQUEST_TIMEOUT_SECONDS
    try:
        parsed = float(raw)
    except ValueError:
        return DEFAULT_REQUEST_TIMEOUT_SECONDS
    return parsed if parsed > 0 else DEFAULT_REQUEST_TIMEOUT_SECONDS


def _format_elapsed_seconds(seconds: float) -> str:
    return f"{max(0.0, seconds):.2f}".rstrip("0").rstrip(".")


@lru_cache(maxsize=1)
def _https_ssl_context() -> ssl.SSLContext | None:
    if os.getenv("SSL_CERT_FILE") or os.getenv("SSL_CERT_DIR"):
        return ssl.create_default_context()

    try:
        import certifi  # type: ignore[import-not-found]
    except Exception:
        return None

    ca_file = Path(certifi.where())
    if not ca_file.is_file():
        return None
    return ssl.create_default_context(cafile=str(ca_file))


@dataclass
class HTTPResponse:
    status: int
    body: bytes
    headers: dict[str, str]


class Transport(Protocol):
    def request(
        self,
        *,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes,
    ) -> HTTPResponse: ...


def _response_header(headers: object, name: str) -> str:
    getter = getattr(headers, "get", None)
    if callable(getter):
        value = getter(name)
        if value is None:
            value = getter(name.lower())
        return str(value or "")
    return ""


def _read_response_body(
    response: object,
    *,
    status: int,
    max_response_bytes: int,
) -> bytes:
    if max_response_bytes <= 0:
        raise ValueError("max_response_bytes must be positive")
    is_success = 200 <= status < 300
    limit = max_response_bytes if is_success else MAX_HTTP_ERROR_BODY_BYTES
    headers = getattr(response, "headers", {})
    declared_length = _response_header(headers, "Content-Length").strip()
    if is_success and declared_length.isdigit() and int(declared_length) > limit:
        raise HTTPResponseTooLarge(
            f"HTTP response exceeded the {limit}-byte limit"
        )
    payload = response.read(limit + 1)
    if len(payload) <= limit:
        return payload
    if is_success:
        raise HTTPResponseTooLarge(
            f"HTTP response exceeded the {limit}-byte limit"
        )
    return payload[:limit]


def _same_origin(left: str, right: str) -> bool:
    left_url = urlsplit(left)
    right_url = urlsplit(right)
    return (
        left_url.scheme.lower(),
        (left_url.hostname or "").lower(),
        left_url.port or (443 if left_url.scheme.lower() == "https" else 80),
    ) == (
        right_url.scheme.lower(),
        (right_url.hostname or "").lower(),
        right_url.port or (443 if right_url.scheme.lower() == "https" else 80),
    )


class _SameOriginRedirectHandler(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        if not _same_origin(req.full_url, newurl):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class UrllibTransport:
    def __init__(
        self,
        *,
        timeout: float | None = None,
        proxy_map: Mapping[str, str] | None = None,
    ) -> None:
        self.timeout = _request_timeout_seconds(timeout)
        self.proxy_map = None if proxy_map is None else dict(proxy_map)

    def request(
        self,
        *,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes,
    ) -> HTTPResponse:
        return self.request_bounded(
            method=method,
            url=url,
            headers=headers,
            body=body,
            max_response_bytes=MAX_HTTP_RESPONSE_BYTES,
        )

    def request_bounded(
        self,
        *,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes,
        max_response_bytes: int,
    ) -> HTTPResponse:
        if any(str(name).lower() in _CREDENTIAL_HEADER_NAMES for name in headers):
            return self.request_same_origin_redirects_bounded(
                method=method,
                url=url,
                headers=headers,
                body=body,
                max_response_bytes=max_response_bytes,
            )
        req = request.Request(url=url, data=body, headers=headers, method=method)
        started_at = time.monotonic()
        try:
            context = _https_ssl_context() if url.lower().startswith("https://") else None
            if self.proxy_map is None:
                response_context = request.urlopen(req, timeout=self.timeout, context=context)
            else:
                handlers: list[object] = [request.ProxyHandler(self.proxy_map)]
                if context is not None:
                    handlers.append(request.HTTPSHandler(context=context))
                response_context = request.build_opener(*handlers).open(req, timeout=self.timeout)
            with response_context as response:
                status = getattr(response, "status", response.getcode())
                return HTTPResponse(
                    status=status,
                    body=_read_response_body(
                        response,
                        status=status,
                        max_response_bytes=max_response_bytes,
                    ),
                    headers=dict(response.headers.items()),
                )
        except error.HTTPError as exc:
            return HTTPResponse(
                status=exc.code,
                body=_read_response_body(
                    exc,
                    status=exc.code,
                    max_response_bytes=max_response_bytes,
                ),
                headers=dict(exc.headers.items()),
            )
        except socket.timeout as exc:
            elapsed = _format_elapsed_seconds(time.monotonic() - started_at)
            raise TimeoutError(f"HTTP request timed out after {elapsed}s (timeout limit {self.timeout:g}s)") from exc
        except error.URLError as exc:
            if isinstance(exc.reason, (socket.timeout, TimeoutError)):
                elapsed = _format_elapsed_seconds(time.monotonic() - started_at)
                raise TimeoutError(
                    f"HTTP request timed out after {elapsed}s (timeout limit {self.timeout:g}s): {exc.reason}"
                ) from exc
            raise

    def request_same_origin_redirects(
        self,
        *,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes,
    ) -> HTTPResponse:
        return self.request_same_origin_redirects_bounded(
            method=method,
            url=url,
            headers=headers,
            body=body,
            max_response_bytes=MAX_HTTP_RESPONSE_BYTES,
        )

    def request_same_origin_redirects_bounded(
        self,
        *,
        method: str,
        url: str,
        headers: dict[str, str],
        body: bytes,
        max_response_bytes: int,
    ) -> HTTPResponse:
        req = request.Request(url=url, data=body, headers=headers, method=method)
        handlers: list[object] = []
        if self.proxy_map is not None:
            handlers.append(request.ProxyHandler(self.proxy_map))
        handlers.append(_SameOriginRedirectHandler())
        context = _https_ssl_context() if url.lower().startswith("https://") else None
        if context is not None:
            handlers.append(request.HTTPSHandler(context=context))
        opener = request.build_opener(*handlers)
        started_at = time.monotonic()
        try:
            with opener.open(req, timeout=self.timeout) as response:
                status = getattr(response, "status", response.getcode())
                return HTTPResponse(
                    status=status,
                    body=_read_response_body(
                        response,
                        status=status,
                        max_response_bytes=max_response_bytes,
                    ),
                    headers=dict(response.headers.items()),
                )
        except error.HTTPError as exc:
            return HTTPResponse(
                status=exc.code,
                body=_read_response_body(
                    exc,
                    status=exc.code,
                    max_response_bytes=max_response_bytes,
                ),
                headers=dict(exc.headers.items()),
            )
        except socket.timeout as exc:
            elapsed = _format_elapsed_seconds(time.monotonic() - started_at)
            raise TimeoutError(
                f"HTTP request timed out after {elapsed}s (timeout limit {self.timeout:g}s)"
            ) from exc
        except error.URLError as exc:
            if isinstance(exc.reason, (socket.timeout, TimeoutError)):
                elapsed = _format_elapsed_seconds(time.monotonic() - started_at)
                raise TimeoutError(
                    f"HTTP request timed out after {elapsed}s (timeout limit {self.timeout:g}s): {exc.reason}"
                ) from exc
            raise
