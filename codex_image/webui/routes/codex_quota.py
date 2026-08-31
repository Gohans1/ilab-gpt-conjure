from __future__ import annotations

from typing import Any

from fastapi import FastAPI

from codex_image.codex_quota import get_codex_quota
from codex_image.webui.context import WebUIContext


def register_codex_quota_routes(app: FastAPI, ctx: WebUIContext) -> None:
    del ctx

    @app.get("/api/codex/quota")
    def codex_quota() -> dict[str, Any]:
        return get_codex_quota()
