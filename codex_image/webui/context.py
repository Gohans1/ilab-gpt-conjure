from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
import re
import threading
from typing import Any, Callable

from fastapi import FastAPI

from .history_export import HistoryExportService
from .instance_lock import WebUIInstanceLock
from .network_egress import NetworkEgressManager, NetworkEgressSettings
from .provider_settings import ProviderSettings
from .queue import QueueManager
from .reference_files import ReferenceFileStorage
from .settings_store import AuthSettings, ColorPaletteSettings, PromptSnippetSettings, PromptTemplateSettings, WebUISettings
from .storage import GalleryStorage, QueueStorage, ReferenceAssetStorage, SQLiteQueueStorage, TaskStorage

ClientFactory = Callable[[], Any]
AuthChecker = Callable[[], bool]


@dataclass
class QueueWorkerHealth:
    status: str = "healthy"
    consecutive_failures: int = 0
    last_error_type: str | None = None
    last_error_at: str | None = None
    _failure_counts: dict[str, int] = field(default_factory=dict, repr=False)
    _error_types: dict[str, str] = field(default_factory=dict, repr=False)
    _error_times: dict[str, str] = field(default_factory=dict, repr=False)
    _lock: threading.RLock = field(default_factory=threading.RLock, repr=False)

    def record_failure(
        self,
        error: BaseException,
        *,
        channel_id: str | None = None,
    ) -> int:
        key = str(channel_id or "__queue__")
        error_type = _safe_exception_type(error)
        error_at = datetime.now(UTC).isoformat()
        with self._lock:
            count = self._failure_counts.get(key, 0) + 1
            self._failure_counts[key] = count
            self._error_types[key] = error_type
            self._error_times[key] = error_at
            self._refresh(error_type=error_type, error_at=error_at)
            return count

    def record_success(self, *, channel_id: str | None = None) -> None:
        key = str(channel_id or "__queue__")
        with self._lock:
            self._failure_counts.pop(key, None)
            self._error_types.pop(key, None)
            self._error_times.pop(key, None)
            self._refresh()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "status": self.status,
                "consecutive_failures": self.consecutive_failures,
                "last_error_type": self.last_error_type,
                "last_error_at": self.last_error_at,
            }

    def _refresh(
        self,
        *,
        error_type: str | None = None,
        error_at: str | None = None,
    ) -> None:
        self.consecutive_failures = max(self._failure_counts.values(), default=0)
        self.status = (
            "unhealthy"
            if self.consecutive_failures >= 3
            else "degraded"
            if self.consecutive_failures
            else "healthy"
        )
        if not self._failure_counts:
            self.last_error_type = None
            self.last_error_at = None
            return
        if error_type is not None and error_at is not None:
            self.last_error_type = error_type
            self.last_error_at = error_at
            return
        latest_key = max(
            self._error_times,
            key=lambda key: self._error_times[key],
        )
        self.last_error_type = self._error_types[latest_key]
        self.last_error_at = self._error_times[latest_key]


def _safe_exception_type(error: BaseException) -> str:
    raw = str(type(error).__name__ or "Exception")
    safe = re.sub(r"[^A-Za-z0-9_]", "_", raw)[:80]
    return safe or "Exception"


@dataclass
class WebUIContext:
    app: FastAPI
    storage: TaskStorage
    gallery_storage: GalleryStorage
    reference_asset_storage: ReferenceAssetStorage
    reference_file_storage: ReferenceFileStorage
    queue_storage: QueueStorage | SQLiteQueueStorage
    webui_settings: WebUISettings
    auth_settings: AuthSettings
    api_settings: ProviderSettings
    network_egress_settings: NetworkEgressSettings
    network_egress_manager: NetworkEgressManager
    color_settings: ColorPaletteSettings
    prompt_snippet_settings: PromptSnippetSettings
    prompt_template_settings: PromptTemplateSettings
    history_export_service: HistoryExportService
    client_factory: ClientFactory
    auth_checker: AuthChecker
    input_root: Path
    output_root: Path
    gallery_root: Path
    reference_asset_root: Path
    reference_file_root: Path
    source_data_root: Path
    auto_start_queue: bool
    instance_lock: WebUIInstanceLock | None = None
    queue_manager: QueueManager | None = None
    queue_worker_health: QueueWorkerHealth = field(default_factory=QueueWorkerHealth)
    active_task_ids: set[str] = field(default_factory=set)
    running_worker_tasks: dict[str, Any] = field(default_factory=dict)
    api_request_semaphores: dict[str, dict[str, Any]] = field(default_factory=dict)
    api_task_slot_reservations: dict[str, dict[str, Any]] = field(default_factory=dict)
    responses_file_unsupported_keys: set[tuple[str, str, str, str]] = field(default_factory=set)
    route_helpers: dict[str, Any] = field(default_factory=dict)

    def install_on_app_state(self) -> None:
        self.app.state.ctx = self
        self.app.state.storage = self.storage
        self.app.state.gallery_storage = self.gallery_storage
        self.app.state.reference_asset_storage = self.reference_asset_storage
        self.app.state.reference_file_storage = self.reference_file_storage
        self.app.state.queue_storage = self.queue_storage
        self.app.state.webui_settings = self.webui_settings
        self.app.state.input_root = self.input_root
        self.app.state.output_root = self.output_root
        self.app.state.gallery_root = self.gallery_root
        self.app.state.reference_asset_root = self.reference_asset_root
        self.app.state.reference_file_root = self.reference_file_root
        self.app.state.source_data_root = self.source_data_root
        self.app.state.auto_start_queue = self.auto_start_queue
        self.app.state.webui_instance_lock = self.instance_lock
        self.app.state.auth_settings = self.auth_settings
        self.app.state.api_settings = self.api_settings
        self.app.state.network_egress_settings = self.network_egress_settings
        self.app.state.network_egress_manager = self.network_egress_manager
        self.app.state.prompt_template_settings = self.prompt_template_settings
        self.app.state.history_export_service = self.history_export_service
        self.app.state.client_factory = self.client_factory
        self.app.state.auth_checker = self.auth_checker
        self.app.state.active_task_ids = self.active_task_ids
        self.app.state.queue_worker_health = self.queue_worker_health
        self.app.state.running_worker_tasks = self.running_worker_tasks
        self.app.state.api_request_semaphores = self.api_request_semaphores
        self.app.state.api_task_slot_reservations = self.api_task_slot_reservations
        self.app.state.responses_file_unsupported_keys = self.responses_file_unsupported_keys
        self.app.state.route_helpers = self.route_helpers
        if self.queue_manager is not None:
            self.app.state.queue_manager = self.queue_manager
