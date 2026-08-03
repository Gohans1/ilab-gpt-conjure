from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from codex_image.webui.context import WebUIContext
from codex_image.webui.history_backup_plan import BackupExportScope
from codex_image.webui.history_query import HistoryFilter
from codex_image.webui.resource_limits import HISTORY_BACKUP_UPLOAD_CHUNK_BYTES


_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_SAFE_TASK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_CONTROL_JSON_BYTES = 1024 * 1024
_MAX_SELECTED_TASK_IDS = 100_000
_MAX_FILTER_TAG_IDS = 1_000
_PUBLIC_EXPORT_STATUS_ERRORS = frozenset({
    "backup_export_capacity_unavailable",
    "backup_export_executor_unavailable",
    "backup_export_failed",
    "backup_export_insufficient_space",
    "backup_export_interrupted",
    "backup_export_manifest_too_large",
    "metadata_contains_sensitive_fields",
    "request_contains_sensitive_fields",
    "backup_plan_invalid",
    "backup_plan_private_mode_failed",
    "backup_plan_unreadable",
    "backup_scope_invalid",
    "backup_source_changed",
    "backup_source_missing",
    "backup_source_path_invalid",
    "backup_source_unreadable",
})


class _ExactModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class HistoryFilterPayload(_ExactModel):
    q: str = ""
    month: str = ""
    mode: str = ""
    status: str = ""
    prompt_mode: str = ""
    size: str = ""
    quality: str = ""
    ratio: str = ""
    orientation: str = ""
    backend: str = ""
    provider: str = ""
    archived: bool | None = None
    favorite: bool | None = None
    tag_ids: list[str] = Field(default_factory=list)
    untagged: bool = False
    sort: Literal["newest", "oldest"] = "newest"

    @field_validator("tag_ids")
    @classmethod
    def validate_tag_ids(cls, values: list[str]) -> list[str]:
        if len(values) > _MAX_FILTER_TAG_IDS:
            raise ValueError("backup_filter_tag_ids_too_many")
        if any(not _SAFE_TASK_ID_RE.fullmatch(value.strip()) for value in values):
            raise ValueError("backup_filter_tag_id_invalid")
        return values

    @model_validator(mode="after")
    def validate_tags(self) -> HistoryFilterPayload:
        if self.untagged and any(str(item or "").strip() for item in self.tag_ids):
            raise ValueError("backup_filter_untagged_with_tags")
        return self

    def to_domain(self) -> HistoryFilter:
        return HistoryFilter(
            q=self.q,
            month=self.month,
            mode=self.mode,
            status=self.status,
            prompt_mode=self.prompt_mode,
            size=self.size,
            quality=self.quality,
            ratio=self.ratio,
            orientation=self.orientation,
            backend=self.backend,
            provider=self.provider,
            archived=self.archived,
            favorite=self.favorite,
            tag_ids=tuple(self.tag_ids),
            untagged=self.untagged,
            sort=self.sort,
        )


class CreateBackupExportRequest(_ExactModel):
    scope: Literal["selected", "filtered", "all"]
    task_ids: list[str] = Field(default_factory=list)
    filters: HistoryFilterPayload | None = None

    @field_validator("task_ids")
    @classmethod
    def validate_task_ids(cls, values: list[str]) -> list[str]:
        if len(values) > _MAX_SELECTED_TASK_IDS:
            raise ValueError("backup_scope_task_ids_too_many")
        if any(not _SAFE_TASK_ID_RE.fullmatch(value.strip()) for value in values):
            raise ValueError("backup_scope_task_id_invalid")
        return values

    @model_validator(mode="after")
    def validate_scope(self) -> CreateBackupExportRequest:
        task_ids = tuple(dict.fromkeys(item.strip() for item in self.task_ids if item.strip()))
        provided = self.model_fields_set
        if (
            self.scope == "selected"
            and task_ids
            and "task_ids" in provided
            and "filters" not in provided
        ):
            return self
        if (
            self.scope == "filtered"
            and "task_ids" not in provided
            and self.filters is not None
            and "filters" in provided
        ):
            return self
        if self.scope == "all" and "task_ids" not in provided and "filters" not in provided:
            return self
        raise ValueError("backup_scope_invalid")

    def to_domain(self) -> BackupExportScope:
        if self.scope == "selected":
            return BackupExportScope.selected(self.task_ids)
        if self.scope == "filtered" and self.filters is not None:
            return BackupExportScope.filtered(self.filters.to_domain())
        return BackupExportScope.all()


class CreateBackupImportRequest(_ExactModel):
    filename: str = Field(min_length=1, max_length=255)
    size_bytes: int = Field(ge=1)


class OneTimeBackupDownloadResponse(FileResponse):
    def __init__(self, path: Path, *, filename: str) -> None:
        self._claimed_path = path
        super().__init__(path, media_type="application/zip", filename=filename)

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            _unlink_claimed_file(self._claimed_path)


def register_history_backup_routes(app: FastAPI, ctx: WebUIContext) -> None:
    @app.post("/api/task-history/backup-exports")
    async def create_backup_export(request: Request) -> dict[str, Any]:
        payload = await _validated_json_body(request, CreateBackupExportRequest)
        _require_accepting_jobs(ctx)
        try:
            job = ctx.history_backup_export_service.create(payload.to_domain())
        except (ValueError, OSError) as exc:
            raise _service_http_error(exc) from None
        return _export_job_payload(job)

    @app.post("/api/task-history/backup-exports/estimate")
    async def estimate_backup_export(request: Request) -> dict[str, Any]:
        payload = await _validated_json_body(request, CreateBackupExportRequest)
        try:
            summary = ctx.history_backup_export_service.estimate(payload.to_domain())
        except (ValueError, OSError) as exc:
            raise _service_http_error(exc) from None
        return {
            "scope": payload.scope,
            "total_tasks": summary.selected_count,
            "eligible_tasks": summary.eligible_count,
            "excluded_nonterminal": summary.excluded_nonterminal,
        }

    @app.get("/api/task-history/backup-exports/{job_id}")
    def get_backup_export(job_id: str) -> dict[str, Any]:
        job = ctx.history_backup_export_service.get(job_id)
        if job is None or job.status == "expired":
            raise _safe_http_error(404, "backup_export_not_found")
        return _export_job_payload(job)

    @app.delete("/api/task-history/backup-exports/{job_id}")
    def cancel_backup_export(job_id: str) -> dict[str, Any]:
        job = ctx.history_backup_export_service.get(job_id)
        if job is None or job.status == "expired":
            raise _safe_http_error(404, "backup_export_not_found")
        try:
            cancelled = ctx.history_backup_export_service.cancel(job_id)
        except (ValueError, OSError) as exc:
            raise _service_http_error(exc) from None
        if cancelled:
            current = ctx.history_backup_export_service.get(job_id)
            return _export_job_payload(current or job)
        try:
            discarded = ctx.history_backup_export_service.discard(job_id)
        except (ValueError, OSError) as exc:
            raise _service_http_error(exc) from None
        if discarded is None:
            raise _safe_http_error(409, "backup_export_lifecycle_conflict")
        return _export_job_payload(discarded)

    @app.get("/api/task-history/backup-exports/{job_id}/download", response_model=None)
    def download_backup_export(job_id: str) -> FileResponse:
        job = ctx.history_backup_export_service.get(job_id)
        if job is None or job.status == "expired":
            raise _safe_http_error(404, "backup_export_not_found")
        claimed: Path | None = None
        try:
            claimed = ctx.history_backup_export_service.claim_download(job_id)
            return OneTimeBackupDownloadResponse(
                claimed,
                filename=_attachment_filename(job.created_at),
            )
        except (ValueError, OSError) as exc:
            if claimed is not None:
                _unlink_claimed_file(claimed)
            raise _service_http_error(exc) from None
        except Exception:
            if claimed is not None:
                _unlink_claimed_file(claimed)
            raise

    @app.post("/api/task-history/backup-imports")
    async def create_backup_import(request: Request) -> dict[str, Any]:
        payload = await _validated_json_body(request, CreateBackupImportRequest)
        _require_accepting_jobs(ctx)
        try:
            session = ctx.history_backup_import_service.create(payload.filename, payload.size_bytes)
        except (ValueError, OSError) as exc:
            raise _service_http_error(exc) from None
        return _import_session_payload(session)

    @app.put("/api/task-history/backup-imports/{session_id}/chunks")
    async def append_backup_import_chunk(session_id: str, request: Request) -> dict[str, Any]:
        _require_accepting_jobs(ctx)
        offset = _integer_header(request, "x-chunk-offset")
        digest = request.headers.get("x-chunk-sha256", "")
        if not _SHA256_RE.fullmatch(digest):
            raise _safe_http_error(422, "backup_import_chunk_hash_invalid")
        declared_length = _integer_header(request, "content-length")
        if declared_length <= 0:
            raise _safe_http_error(422, "backup_import_chunk_length_invalid")
        if declared_length > HISTORY_BACKUP_UPLOAD_CHUNK_BYTES:
            raise _safe_http_error(413, "backup_import_chunk_too_large")
        chunk = await _bounded_chunk_body(
            request,
            HISTORY_BACKUP_UPLOAD_CHUNK_BYTES,
            overflow_code="backup_import_chunk_too_large",
        )
        if len(chunk) != declared_length:
            raise _safe_http_error(422, "backup_import_chunk_length_mismatch")
        try:
            session = ctx.history_backup_import_service.append_chunk(
                session_id,
                offset,
                chunk,
                digest.lower(),
            )
        except (ValueError, OSError) as exc:
            raise _service_http_error(exc) from None
        return _import_session_payload(session)

    @app.get("/api/task-history/backup-imports/{session_id}")
    def get_backup_import(session_id: str) -> dict[str, Any]:
        snapshot = ctx.history_backup_import_service.get_snapshot(session_id)
        if snapshot is None:
            raise _safe_http_error(404, "backup_import_not_found")
        return {
            **_import_session_payload(snapshot.session),
            "result": asdict(snapshot.result) if snapshot.result is not None else None,
        }

    @app.delete("/api/task-history/backup-imports/{session_id}")
    def cancel_backup_import(session_id: str) -> dict[str, Any]:
        session = ctx.history_backup_import_service.get(session_id)
        if session is None:
            raise _safe_http_error(404, "backup_import_not_found")
        try:
            cancelled = ctx.history_backup_import_service.cancel(session_id)
        except (ValueError, OSError) as exc:
            raise _service_http_error(exc) from None
        if not cancelled:
            raise _safe_http_error(507, "backup_io_error")
        return {"session_id": session_id, "status": "cancelled"}

    @app.post("/api/task-history/backup-imports/{session_id}/validate")
    def validate_backup_import(session_id: str) -> dict[str, Any]:
        _require_accepting_jobs(ctx)
        if ctx.history_backup_import_service.get(session_id) is None:
            raise _safe_http_error(404, "backup_import_not_found")
        try:
            preview = ctx.history_backup_import_service.validate(session_id)
        except (ValueError, OSError) as exc:
            raise _service_http_error(exc) from None
        return asdict(preview)

    @app.post("/api/task-history/backup-imports/{session_id}/restore")
    def restore_backup_import(session_id: str) -> dict[str, Any]:
        _require_accepting_jobs(ctx)
        if ctx.history_backup_import_service.get(session_id) is None:
            raise _safe_http_error(404, "backup_import_not_found")
        try:
            result = ctx.history_backup_import_service.restore(session_id)
        except (ValueError, OSError) as exc:
            raise _service_http_error(exc) from None
        return asdict(result)


def shutdown_history_backup_services(ctx: WebUIContext) -> None:
    ctx.history_backup_accepting_jobs = False
    ctx.app.state.history_backup_accepting_jobs = False
    ctx.history_backup_export_service.close()
    ctx.history_backup_import_service.close()


async def _validated_json_body(request: Request, model: type[_ExactModel]) -> Any:
    try:
        declared = request.headers.get("content-length")
        if declared is not None and int(declared) > _CONTROL_JSON_BYTES:
            raise _safe_http_error(413, "backup_request_too_large")
        body = await _bounded_chunk_body(
            request,
            _CONTROL_JSON_BYTES,
            overflow_code="backup_request_too_large",
        )
        raw = json.loads(body)
        return model.model_validate(raw)
    except HTTPException:
        raise
    except (ValidationError, ValueError, TypeError, json.JSONDecodeError):
        raise _safe_http_error(422, "backup_request_invalid") from None


async def _bounded_chunk_body(
    request: Request,
    maximum: int,
    *,
    overflow_code: str,
) -> bytes:
    body = bytearray()
    async for piece in request.stream():
        if not piece:
            continue
        if len(body) + len(piece) > maximum:
            raise _safe_http_error(413, overflow_code)
        body.extend(piece)
    return bytes(body)


def _integer_header(request: Request, name: str) -> int:
    value = request.headers.get(name)
    try:
        number = int(value or "")
    except ValueError:
        raise _safe_http_error(422, f"backup_import_{name.replace('-', '_')}_invalid") from None
    if number < 0:
        raise _safe_http_error(422, f"backup_import_{name.replace('-', '_')}_invalid")
    return number


def _require_accepting_jobs(ctx: WebUIContext) -> None:
    if not ctx.history_backup_accepting_jobs:
        raise _safe_http_error(409, "backup_lifecycle_conflict")


def _import_session_payload(session: Any) -> dict[str, Any]:
    payload = asdict(session)
    if payload.get("error_code") == "backup_import_insufficient_space":
        payload["error_code"] = "backup_space_insufficient"
    return {**payload, "upload_chunk_bytes": HISTORY_BACKUP_UPLOAD_CHUNK_BYTES}


def _export_job_payload(job: Any) -> dict[str, Any]:
    payload = asdict(job)
    code = payload.get("error_code")
    if code is not None and code not in _PUBLIC_EXPORT_STATUS_ERRORS:
        payload["error_code"] = "backup_export_failed"
        payload["error_message"] = "backup_export_failed"
    elif payload.get("error_message") != code:
        payload["error_message"] = None
    if payload.get("error_code") == "backup_export_insufficient_space":
        payload["error_code"] = "backup_space_insufficient"
        payload["error_message"] = "backup_space_insufficient"
    return payload


def _service_http_error(error: BaseException) -> HTTPException:
    if isinstance(error, OSError):
        return _safe_http_error(507, "backup_io_error")
    code = str(error) if isinstance(error, ValueError) else ""
    status = _ERROR_STATUS_BY_CODE.get(code)
    if status is None:
        return _safe_http_error(500, "backup_internal_error")
    public_code = (
        "backup_space_insufficient"
        if code in {"backup_export_insufficient_space", "backup_import_insufficient_space"}
        else code
    )
    return _safe_http_error(status, public_code)


_ERROR_STATUS_BY_CODE = {
    "history_task_not_found": 404,
    "backup_export_not_found": 404,
    "backup_export_file_missing": 404,
    "backup_import_not_found": 404,
    "backup_export_expired": 404,
    "backup_export_not_ready": 409,
    "backup_export_lifecycle_conflict": 409,
    "backup_import_upload_incomplete": 409,
    "backup_import_not_validated": 409,
    "backup_import_already_validated": 409,
    "backup_import_lifecycle_conflict": 409,
    "backup_import_offset_invalid": 409,
    "backup_import_chunk_retry_mismatch": 409,
    "backup_import_upload_state_invalid": 409,
    "backup_import_size_invalid": 413,
    "backup_import_upload_too_large": 413,
    "backup_import_upload_overflow": 413,
    "backup_import_chunk_too_large": 413,
    "backup_import_manifest_too_large": 413,
    "backup_export_manifest_too_large": 413,
    "backup_import_member_too_large": 413,
    "backup_import_expanded_too_large": 413,
    "backup_export_capacity_unavailable": 507,
    "backup_export_insufficient_space": 507,
    "backup_import_capacity_unavailable": 507,
    "backup_import_insufficient_space": 507,
    "backup_export_claim_persist_failed": 507,
    "backup_import_restore_rollback_incomplete": 507,
    "backup_import_upload_unreadable": 507,
    "backup_import_restore_interrupted": 507,
    "backup_import_restore_plan_invalid": 507,
    "backup_import_restore_storage_unavailable": 507,
    "backup_plan_unreadable": 507,
    "backup_plan_private_mode_failed": 507,
    "backup_source_unreadable": 507,
    "backup_io_error": 507,
    "backup_request_invalid": 422,
    "backup_import_filename_invalid": 422,
    "backup_import_chunk_invalid": 422,
    "backup_import_chunk_hash_mismatch": 422,
    "backup_import_chunk_length_invalid": 422,
    "backup_import_chunk_length_mismatch": 422,
    "backup_import_chunk_hash_invalid": 422,
    "backup_import_compression_ratio_too_high": 422,
    "backup_import_compression_unsupported": 422,
    "backup_import_duplicate_member_path": 422,
    "backup_import_encrypted_forbidden": 422,
    "backup_import_manifest_missing": 422,
    "backup_import_member_changed": 422,
    "backup_import_member_hash_mismatch": 422,
    "backup_import_member_missing": 422,
    "backup_import_member_path_invalid": 422,
    "backup_import_member_size_mismatch": 422,
    "backup_import_member_undeclared": 422,
    "backup_import_special_file_forbidden": 422,
    "backup_import_symlink_forbidden": 422,
    "backup_import_task_required_json_invalid": 422,
    "backup_import_task_required_json_missing": 422,
    "backup_import_too_many_entries": 422,
    "backup_import_zip_invalid": 422,
    "backup_manifest_aggregate_counts_invalid": 422,
    "backup_manifest_duplicate_member_path": 422,
    "backup_manifest_duplicate_task_id": 422,
    "backup_manifest_file_required_invalid": 422,
    "backup_manifest_file_size_invalid": 422,
    "backup_manifest_fingerprint_invalid": 422,
    "backup_manifest_format_unsupported": 422,
    "backup_manifest_invalid": 422,
    "backup_manifest_invalid_json": 422,
    "backup_manifest_member_path_invalid": 422,
    "backup_manifest_source_index_invalid": 422,
    "backup_manifest_task_id_invalid": 422,
    "backup_manifest_unknown_required_role": 422,
    "backup_manifest_version_unsupported": 422,
    "backup_member_filename_invalid": 422,
    "backup_member_role_invalid": 422,
    "backup_plan_invalid": 422,
    "metadata_contains_sensitive_fields": 422,
    "request_contains_sensitive_fields": 422,
    "backup_scope_invalid": 422,
    "backup_source_missing": 422,
    "backup_source_path_invalid": 422,
}


def _safe_http_error(status_code: int, code: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": code})


def _unlink_claimed_file(path: Path) -> None:
    try:
        if path.is_file() or path.is_symlink():
            path.unlink(missing_ok=True)
    except OSError:
        return


def _attachment_filename(created_at: str) -> str:
    try:
        value = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        if value.tzinfo is None:
            raise ValueError
        stamp = value.astimezone(timezone.utc).strftime("%Y%m%d-%H%M%S")
    except (AttributeError, TypeError, ValueError):
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"iLab-CONJURE-backup-{stamp}.zip"
