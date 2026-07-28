from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
import os
from pathlib import Path
import re
import tempfile
import threading
from typing import Callable, Literal
import uuid
import zipfile

from .storage import TaskStorage
from .task_outputs import (
    ExportableTaskOutput,
    exportable_task_outputs,
)


HistoryExportMode = Literal[
    "images_only",
    "images_with_prompts",
]
HISTORY_EXPORT_MODES = frozenset(
    {"images_only", "images_with_prompts"}
)
_SAFE_TASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_SAFE_IMAGE_SUFFIX = re.compile(r"^\.[A-Za-z0-9]{1,12}$")
_TEMP_PREFIX = "ilab-conjure-history-export-"


class HistoryExportError(ValueError):
    safe_detail = "History export failed"


class HistoryExportTaskNotFoundError(HistoryExportError):
    def __init__(self, task_ids: list[str]) -> None:
        self.task_ids = tuple(task_ids)
        self.safe_detail = (
            "Task not found: " + ", ".join(self.task_ids)
        )
        super().__init__(self.safe_detail)


class HistoryExportValidationError(HistoryExportError):
    def __init__(
        self,
        task_ids: list[str] | tuple[str, ...] = (),
        *,
        detail: str = "Selected tasks cannot be exported",
    ) -> None:
        self.task_ids = tuple(task_ids)
        suffix = (
            ": " + ", ".join(self.task_ids)
            if self.task_ids
            else ""
        )
        self.safe_detail = detail + suffix
        super().__init__(self.safe_detail)


class HistoryExportNotFoundError(HistoryExportError):
    safe_detail = "Export not found or expired"


@dataclass(frozen=True)
class PendingHistoryExport:
    export_id: str
    path: Path
    filename: str
    created_at: datetime
    task_count: int
    image_count: int


@dataclass(frozen=True)
class HistoryExportResult:
    export_id: str
    download_url: str
    filename: str
    task_count: int
    image_count: int


@dataclass(frozen=True)
class PlannedTaskExport:
    task_id: str
    original_prompt: str
    outputs: tuple[ExportableTaskOutput, ...]


class HistoryExportService:
    def __init__(
        self,
        storage: TaskStorage,
        *,
        temp_root: Path | str | None = None,
        now: Callable[[], datetime] | None = None,
        ttl: timedelta = timedelta(hours=1),
    ) -> None:
        self.storage = storage
        self.temp_root = (
            Path(temp_root)
            if temp_root is not None
            else Path(tempfile.gettempdir())
            / "ilab-conjure-history-exports"
        )
        self.temp_root.mkdir(
            parents=True,
            exist_ok=True,
            mode=0o700,
        )
        try:
            self.temp_root.chmod(0o700)
        except OSError:
            pass
        self._now = now or (lambda: datetime.now(UTC))
        self.ttl = ttl
        self._pending: dict[str, PendingHistoryExport] = {}
        self._lock = threading.Lock()
        self.cleanup_expired()

    def create(
        self,
        task_ids: list[str],
        *,
        mode: HistoryExportMode | str,
    ) -> HistoryExportResult:
        self.cleanup_expired()
        if mode not in HISTORY_EXPORT_MODES:
            raise HistoryExportValidationError(
                detail="Invalid history export mode"
            )
        normalized = self._normalize_task_ids(task_ids)
        plans = self._plan_tasks(normalized)
        image_count = sum(
            len(task.outputs) for task in plans
        )
        created_at = self._current_time()
        filename = (
            "iLab-CONJURE-export-"
            f"{created_at.strftime('%Y%m%d-%H%M%S')}.zip"
        )
        file_descriptor, partial_name = tempfile.mkstemp(
            prefix=_TEMP_PREFIX,
            suffix=".partial",
            dir=self.temp_root,
        )
        os.close(file_descriptor)
        partial_path = Path(partial_name)
        final_path = partial_path.with_suffix(".zip")
        try:
            self._write_archive(
                partial_path,
                plans,
                mode=mode,
            )
            os.replace(partial_path, final_path)
        except Exception:
            partial_path.unlink(missing_ok=True)
            final_path.unlink(missing_ok=True)
            raise

        export_id = uuid.uuid4().hex
        pending = PendingHistoryExport(
            export_id=export_id,
            path=final_path,
            filename=filename,
            created_at=created_at,
            task_count=len(plans),
            image_count=image_count,
        )
        with self._lock:
            self._pending[export_id] = pending
        return HistoryExportResult(
            export_id=export_id,
            download_url=(
                f"/api/task-history/exports/{export_id}"
            ),
            filename=filename,
            task_count=pending.task_count,
            image_count=pending.image_count,
        )

    def claim(self, export_id: str) -> PendingHistoryExport:
        clean_id = str(export_id or "").strip()
        with self._lock:
            pending = self._pending.pop(clean_id, None)
        if pending is None or not pending.path.is_file():
            if pending is not None:
                self.remove_file(pending.path)
            raise HistoryExportNotFoundError(
                HistoryExportNotFoundError.safe_detail
            )
        return pending

    def remove_file(self, path: Path | str) -> None:
        candidate = Path(path)
        try:
            candidate.resolve(strict=False).relative_to(
                self.temp_root.resolve(strict=False)
            )
        except ValueError:
            return
        if not candidate.name.startswith(_TEMP_PREFIX):
            return
        candidate.unlink(missing_ok=True)

    def cleanup_expired(self) -> None:
        cutoff = self._current_time() - self.ttl
        expired_paths: list[Path] = []
        with self._lock:
            for export_id, pending in list(
                self._pending.items()
            ):
                if pending.created_at <= cutoff:
                    expired_paths.append(pending.path)
                    self._pending.pop(export_id, None)
        for path in expired_paths:
            self.remove_file(path)

        cutoff_timestamp = cutoff.timestamp()
        try:
            candidates = list(
                self.temp_root.glob(f"{_TEMP_PREFIX}*")
            )
        except OSError:
            return
        for path in candidates:
            if path.suffix not in {".zip", ".partial"}:
                continue
            try:
                expired = path.stat().st_mtime <= cutoff_timestamp
            except OSError:
                continue
            if expired:
                self.remove_file(path)

    def _normalize_task_ids(
        self,
        task_ids: list[str],
    ) -> list[str]:
        normalized = list(
            dict.fromkeys(
                task_id
                for value in task_ids
                if (
                    task_id := str(value or "").strip()
                )
            )
        )
        if not normalized:
            raise HistoryExportValidationError(
                detail="At least one task id is required"
            )
        if len(normalized) > 300:
            raise HistoryExportValidationError(
                detail=(
                    "At most 300 tasks can be exported at once"
                )
            )
        invalid = [
            task_id
            for task_id in normalized
            if not self._safe_task_id(task_id)
        ]
        if invalid:
            raise HistoryExportValidationError(
                invalid,
                detail="Invalid task id",
            )
        return normalized

    def _plan_tasks(
        self,
        task_ids: list[str],
    ) -> tuple[PlannedTaskExport, ...]:
        plans: list[PlannedTaskExport] = []
        missing: list[str] = []
        invalid: list[str] = []
        seen_real_ids: set[str] = set()
        for requested_task_id in task_ids:
            try:
                metadata = self.storage.read_metadata(
                    requested_task_id
                )
            except (FileNotFoundError, OSError, ValueError):
                missing.append(requested_task_id)
                continue
            real_task_id = str(
                metadata.get("task_id") or requested_task_id
            ).strip()
            if (
                not self._safe_task_id(real_task_id)
                or real_task_id in seen_real_ids
            ):
                invalid.append(requested_task_id)
                continue
            try:
                outputs = exportable_task_outputs(
                    self.storage,
                    real_task_id,
                    metadata,
                )
            except (ValueError, OSError):
                invalid.append(requested_task_id)
                continue
            if (
                not outputs
                or any(
                    not output.path.is_file()
                    or not _SAFE_IMAGE_SUFFIX.fullmatch(
                        output.path.suffix
                    )
                    for output in outputs
                )
            ):
                invalid.append(requested_task_id)
                continue
            seen_real_ids.add(real_task_id)
            plans.append(
                PlannedTaskExport(
                    task_id=real_task_id,
                    original_prompt=str(
                        metadata.get("prompt") or ""
                    ),
                    outputs=tuple(outputs),
                )
            )
        if missing:
            raise HistoryExportTaskNotFoundError(missing)
        if invalid:
            raise HistoryExportValidationError(invalid)
        return tuple(plans)

    def _write_archive(
        self,
        path: Path,
        tasks: tuple[PlannedTaskExport, ...],
        *,
        mode: HistoryExportMode | str,
    ) -> None:
        with zipfile.ZipFile(path, mode="w") as archive:
            for task in tasks:
                for output in task.outputs:
                    stem = f"image-{output.slot_index:02d}"
                    image_name = (
                        f"{task.task_id}/{stem}"
                        f"{output.path.suffix.lower()}"
                    )
                    archive.write(
                        output.path,
                        arcname=image_name,
                        compress_type=zipfile.ZIP_STORED,
                    )
                    if mode != "images_with_prompts":
                        continue
                    prompt = (
                        output.revised_prompt
                        if output.revised_prompt.strip()
                        else task.original_prompt
                        if task.original_prompt.strip()
                        else ""
                    )
                    archive.writestr(
                        f"{task.task_id}/{stem}.txt",
                        prompt.encode("utf-8"),
                        compress_type=zipfile.ZIP_DEFLATED,
                    )

    def _safe_task_id(self, task_id: str) -> bool:
        return bool(
            task_id
            and task_id not in {".", ".."}
            and _SAFE_TASK_ID.fullmatch(task_id)
        )

    def _current_time(self) -> datetime:
        value = self._now()
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)
