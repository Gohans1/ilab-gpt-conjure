from __future__ import annotations

import hashlib
import io
import json
import os
import re
import threading
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Literal

from fastapi import UploadFile

from .atomic_files import _fsync_parent, atomic_write_text
from .reference_file_policy import REFERENCE_FILE_TYPES, ReferenceFileFamily
from .storage_utils import utc_now


MAX_REFERENCE_FILE_BYTES = 50 * 1024 * 1024
MAX_REFERENCE_FILES_TOTAL_BYTES = 50 * 1024 * 1024

@dataclass(frozen=True)
class ValidatedReferenceFile:
    asset_id: str
    filename: str
    mime_type: str
    family: ReferenceFileFamily
    data: bytes
    size_bytes: int
    detail: Literal["auto"] | None


@dataclass(frozen=True)
class ReferenceFileRestore:
    record: dict[str, Any]
    created: bool
    version: int
    restore_token: str | None = None

_COMPOUND_FILE_SIGNATURE = bytes.fromhex("d0cf11e0a1b11ae1")
_DISALLOWED_TEXT_MAGIC = (
    b"MZ",
    b"\x7fELF",
    b"PK\x03\x04",
    b"PK\x05\x06",
    b"PK\x07\x08",
    b"Rar!",
    b"7z\xbc\xaf\x27\x1c",
    b"\x1f\x8b",
    b"BZh",
    b"\xfd7zXZ\x00",
    b"\xfe\xed\xfa\xce",
    b"\xfe\xed\xfa\xcf",
    b"\xce\xfa\xed\xfe",
    b"\xcf\xfa\xed\xfe",
)
_ASSET_ID_RE = re.compile(r"[0-9a-f]{64}")


def validate_reference_file(
    filename: str,
    data: bytes,
    content_type: str | None,
    *,
    max_bytes: int = MAX_REFERENCE_FILE_BYTES,
) -> ValidatedReferenceFile:
    """Validate one native Responses reference file and return normalized metadata plus bytes."""
    if not data:
        raise ValueError("reference_file_empty")
    if len(data) >= max_bytes:
        raise ValueError("reference_file_too_large")

    display_filename = _display_filename(filename)
    suffix = Path(display_filename).suffix.lower()
    file_type = REFERENCE_FILE_TYPES.get(suffix)
    if file_type is None:
        raise ValueError("reference_file_type_unsupported")

    supplied_mime = str(content_type or "").split(";", 1)[0].strip().lower()
    if (
        supplied_mime
        and supplied_mime != "application/octet-stream"
        and supplied_mime not in file_type.accepted_mime_types
    ):
        raise ValueError("reference_file_type_mismatch")

    _validate_file_content(data, file_type.validation)
    return ValidatedReferenceFile(
        asset_id=hashlib.sha256(data).hexdigest(),
        filename=display_filename,
        mime_type=file_type.mime_type,
        family=file_type.family,
        data=data,
        size_bytes=len(data),
        detail="auto" if file_type.family == "pdf" else None,
    )


def validate_reference_file_total(
    files: Iterable[ValidatedReferenceFile | dict[str, Any]],
    *,
    max_total_bytes: int = MAX_REFERENCE_FILES_TOTAL_BYTES,
) -> None:
    seen: set[str] = set()
    total = 0
    for file in files:
        record = reference_file_task_record(file)
        asset_id = str(record.get("id") or "")
        if asset_id in seen:
            continue
        seen.add(asset_id)
        total += int(record.get("size_bytes") or 0)
    if total > max_total_bytes:
        raise ValueError("reference_files_total_too_large")


def reference_file_task_record(file: ValidatedReferenceFile | dict[str, Any]) -> dict[str, Any]:
    if isinstance(file, ValidatedReferenceFile):
        asset_id = file.asset_id
        filename = file.filename
        mime_type = file.mime_type
        family = file.family
        size_bytes = file.size_bytes
        detail = file.detail
    elif isinstance(file, dict):
        asset_id = str(file.get("asset_id") or file.get("id") or "")
        filename = str(file.get("filename") or file.get("last_filename") or file.get("first_filename") or "")
        mime_type = str(file.get("mime_type") or file.get("last_mime_type") or "")
        family = str(file.get("family") or file.get("last_family") or "")
        size_bytes = file.get("size_bytes")
        detail = file.get("detail")
    else:
        raise ValueError("reference_file_invalid")

    if not _ASSET_ID_RE.fullmatch(asset_id):
        raise ValueError("reference_file_invalid")
    try:
        normalized_size = int(size_bytes)
    except (TypeError, ValueError) as exc:
        raise ValueError("reference_file_invalid") from exc
    if not filename or not mime_type or family not in {"pdf", "spreadsheet", "document", "text"} or normalized_size < 0:
        raise ValueError("reference_file_invalid")
    return {
        "id": asset_id,
        "filename": filename,
        "mime_type": mime_type,
        "family": family,
        "size_bytes": normalized_size,
        "detail": "auto" if family == "pdf" else detail if detail == "auto" else None,
    }


def dedupe_reference_file_records(items: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for item in items:
        record = reference_file_task_record(item)
        asset_id = record["id"]
        if asset_id in seen:
            continue
        seen.add(asset_id)
        result.append(record)
    return result


async def read_reference_file_uploads(
    files: list[UploadFile],
    *,
    max_file_bytes: int = MAX_REFERENCE_FILE_BYTES,
    max_total_bytes: int = MAX_REFERENCE_FILES_TOTAL_BYTES,
    chunk_size: int = 1024 * 1024,
) -> list[ValidatedReferenceFile]:
    if max_file_bytes <= 0 or max_total_bytes < 0 or chunk_size <= 0:
        raise ValueError("reference_file_invalid")
    validated: list[ValidatedReferenceFile] = []
    seen_asset_ids: set[str] = set()
    total_bytes = 0
    try:
        for upload in files:
            data = bytearray()
            while True:
                if len(data) >= max_file_bytes:
                    raise ValueError("reference_file_too_large")
                read_size = min(chunk_size, max_file_bytes - len(data))
                chunk = await upload.read(read_size)
                if not chunk:
                    break
                data.extend(chunk)
            item = validate_reference_file(
                upload.filename or "file",
                bytes(data),
                upload.content_type,
                max_bytes=max_file_bytes,
            )
            if item.asset_id in seen_asset_ids:
                continue
            if total_bytes + item.size_bytes > max_total_bytes:
                raise ValueError("reference_files_total_too_large")
            seen_asset_ids.add(item.asset_id)
            validated.append(item)
            total_bytes += item.size_bytes
        return validated
    finally:
        for upload in files:
            try:
                await upload.close()
            except Exception:
                pass


class ReferenceFileStorage:
    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()
        self._lock = threading.RLock()
        self._restore_versions: dict[str, int] = {}

    def create_or_touch(self, file: ValidatedReferenceFile) -> dict[str, Any]:
        if not isinstance(file, ValidatedReferenceFile):
            raise ValueError("reference_file_invalid")
        expected_id = hashlib.sha256(file.data).hexdigest()
        expected_size = len(file.data)
        if file.asset_id != expected_id or file.size_bytes != expected_size:
            raise ValueError("reference_file_invalid")
        with self._lock:
            self._invalidate_restore_ownership(file.asset_id)
            self._restore_versions[file.asset_id] = self._restore_versions.get(file.asset_id, 0) + 1
            data_path, metadata_path = self._item_paths(file.asset_id)
            data_path.parent.mkdir(parents=True, exist_ok=True)
            if data_path.exists():
                self._verify_blob(data_path, expected_id=expected_id, expected_size=expected_size)
            else:
                self._write_blob(data_path, file.data)
            try:
                metadata = self._read_metadata(file.asset_id, require_data=True)
            except (FileNotFoundError, OSError, ValueError):
                now = utc_now()
                metadata = {
                    "id": file.asset_id,
                    "sha256": file.asset_id,
                    "size_bytes": file.size_bytes,
                    "first_filename": file.filename,
                    "last_filename": file.filename,
                    "last_mime_type": file.mime_type,
                    "last_family": file.family,
                    "detail": file.detail,
                    "created_at": now,
                    "last_used_at": now,
                    "used_count": 1,
                }
                self._write_metadata(metadata_path, metadata)
                return metadata
            return self._touch_metadata(
                metadata,
                filename=file.filename,
                mime_type=file.mime_type,
                family=file.family,
            )

    def restore_validated(self, file: ValidatedReferenceFile) -> ReferenceFileRestore:
        uploads = self._validated_unique_uploads([file])
        if len(uploads) != 1:
            raise ValueError("reference_file_invalid")
        with self._lock:
            asset_id = file.asset_id
            version = self._restore_versions.get(asset_id, 0) + 1
            self._restore_versions[asset_id] = version
            data_path, metadata_path = self._item_paths(asset_id)
            if data_path.exists() or metadata_path.exists():
                metadata = self._read_verified_metadata(asset_id)
                self._invalidate_restore_ownership(asset_id)
                return ReferenceFileRestore(
                    reference_file_task_record({
                        **metadata,
                        "filename": file.filename,
                        "mime_type": file.mime_type,
                        "family": file.family,
                    }),
                    False,
                    version,
                    None,
                )
            staged_blob: Path | None = None
            staged_metadata: Path | None = None
            try:
                staged_blob = self._stage_bytes(data_path, file.data)
                metadata = self._new_metadata(file, touched_at=utc_now())
                staged_metadata = self._stage_metadata(metadata_path, metadata)
                self._publish_staged(staged_blob, data_path)
                staged_blob = None
                try:
                    self._publish_staged(staged_metadata, metadata_path)
                    staged_metadata = None
                except Exception:
                    data_path.unlink(missing_ok=True)
                    raise
            except Exception as exc:
                data_path.unlink(missing_ok=True)
                metadata_path.unlink(missing_ok=True)
                if staged_blob is not None:
                    staged_blob.unlink(missing_ok=True)
                if staged_metadata is not None:
                    staged_metadata.unlink(missing_ok=True)
                try:
                    data_path.parent.rmdir()
                except OSError:
                    pass
                raise ValueError("reference_file_invalid") from exc
            restore_token = uuid.uuid4().hex
            atomic_write_text(self._restore_token_path(asset_id), restore_token, mode=0o600)
            return ReferenceFileRestore(reference_file_task_record(file), True, version, restore_token)

    def rollback_restore(self, handle: ReferenceFileRestore) -> bool:
        if not isinstance(handle, ReferenceFileRestore) or not handle.created:
            return False
        asset_id = str(handle.record.get("id") or "")
        with self._lock:
            if not self.restore_identity_matches(handle):
                return False
            try:
                metadata = self._read_verified_metadata(asset_id)
            except (FileNotFoundError, OSError, ValueError):
                return False
            if metadata.get("sha256") != asset_id:
                return False
            self.delete_created(asset_id)
            self._restore_versions.pop(asset_id, None)
            return True

    def restore_identity_matches(self, handle: ReferenceFileRestore) -> bool:
        if not isinstance(handle, ReferenceFileRestore) or not handle.created or not handle.restore_token:
            return False
        asset_id = str(handle.record.get("id") or "")
        try:
            return self._restore_token_path(asset_id).read_text(encoding="utf-8") == handle.restore_token
        except OSError:
            return False

    def restore_target_exists(self, handle: ReferenceFileRestore) -> bool:
        asset_id = str(handle.record.get("id") or "")
        try:
            data_path, metadata_path = self._item_paths(asset_id)
        except ValueError:
            return True
        return any((
            data_path.exists(),
            metadata_path.exists(),
            self._restore_token_path(asset_id).exists(),
        ))

    def release_restore_ownership(self, handle: ReferenceFileRestore) -> bool:
        if not isinstance(handle, ReferenceFileRestore) or not handle.created or not handle.restore_token:
            return True
        with self._lock:
            path = self._restore_token_path(str(handle.record.get("id") or ""))
            try:
                current = path.read_text(encoding="utf-8")
            except FileNotFoundError:
                return True
            except OSError:
                return False
            if current != handle.restore_token:
                return True
            try:
                path.unlink()
                _fsync_parent(path)
            except OSError:
                return False
            return True

    def _invalidate_restore_ownership(self, asset_id: str) -> None:
        path = self._restore_token_path(asset_id)
        try:
            path.unlink()
        except FileNotFoundError:
            return
        _fsync_parent(path)

    def touch(
        self,
        asset_id: str,
        *,
        filename: str | None = None,
        mime_type: str | None = None,
        family: str | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            self._invalidate_restore_ownership(asset_id)
            metadata = self._read_metadata(asset_id, require_data=True)
            return self._touch_metadata(metadata, filename=filename, mime_type=mime_type, family=family)

    def commit_batch(
        self,
        uploads: Iterable[ValidatedReferenceFile],
        selected_asset_ids: Iterable[str],
    ) -> list[dict[str, Any]]:
        upload_items = self._validated_unique_uploads(uploads)
        selected_ids = list(dict.fromkeys(str(value or "").strip() for value in selected_asset_ids))
        with self._lock:
            selected_records: list[dict[str, Any]] = []
            selected_metadata: dict[str, dict[str, Any]] = {}
            try:
                for asset_id in selected_ids:
                    metadata = self._read_verified_metadata(asset_id)
                    selected_metadata[asset_id] = metadata
                    selected_records.append(self._task_record_from_metadata(metadata))
            except (FileNotFoundError, OSError, ValueError) as exc:
                raise ValueError("reference_file_missing") from exc

            task_records = dedupe_reference_file_records(
                [reference_file_task_record(upload) for upload in upload_items] + selected_records
            )
            validate_reference_file_total(task_records)

            upload_by_id = {upload.asset_id: upload for upload in upload_items}
            staged_blobs: list[tuple[Path, Path]] = []
            staged_metadata: list[tuple[Path, Path]] = []
            new_blob_paths: set[Path] = set()
            original_metadata: dict[Path, bytes | None] = {}
            touched_metadata: dict[str, dict[str, Any]] = {}
            touched_at = utc_now()
            try:
                for record in task_records:
                    asset_id = str(record["id"])
                    self._invalidate_restore_ownership(asset_id)
                    upload = upload_by_id.get(asset_id)
                    data_path, metadata_path = self._item_paths(asset_id)
                    if upload is not None:
                        if data_path.exists():
                            self._verify_blob(
                                data_path,
                                expected_id=asset_id,
                                expected_size=upload.size_bytes,
                            )
                            metadata = self._read_metadata(asset_id, require_data=True)
                            updated = self._updated_metadata(
                                metadata,
                                filename=upload.filename,
                                mime_type=upload.mime_type,
                                family=upload.family,
                                touched_at=touched_at,
                            )
                        else:
                            updated = self._new_metadata(upload, touched_at=touched_at)
                            staged_blob = self._stage_bytes(data_path, upload.data)
                            staged_blobs.append((staged_blob, data_path))
                            new_blob_paths.add(data_path)
                    else:
                        metadata = selected_metadata[asset_id]
                        updated = self._updated_metadata(
                            metadata,
                            filename=None,
                            mime_type=None,
                            family=None,
                            touched_at=touched_at,
                        )
                    original_metadata[metadata_path] = (
                        metadata_path.read_bytes() if metadata_path.exists() else None
                    )
                    staged_item_metadata = self._stage_metadata(metadata_path, updated)
                    staged_metadata.append((staged_item_metadata, metadata_path))
                    touched_metadata[asset_id] = updated

                try:
                    for asset_id in selected_ids:
                        self._read_verified_metadata(asset_id)
                except (FileNotFoundError, OSError, ValueError) as exc:
                    raise ValueError("reference_file_missing") from exc

                for staged_path, final_path in staged_blobs:
                    self._publish_staged(staged_path, final_path)
                for staged_path, final_path in staged_metadata:
                    self._publish_staged(staged_path, final_path)
            except Exception as exc:
                self._rollback_batch(
                    staged_blobs=staged_blobs,
                    staged_metadata=staged_metadata,
                    new_blob_paths=new_blob_paths,
                    original_metadata=original_metadata,
                )
                if isinstance(exc, ValueError) and str(exc) == "reference_file_missing":
                    raise
                raise ValueError("reference_file_invalid") from exc
            finally:
                self._cleanup_staged_paths(staged_blobs, staged_metadata)

            return [
                reference_file_task_record(
                    {
                        **touched_metadata[str(record["id"])],
                        "filename": record["filename"],
                        "mime_type": record["mime_type"],
                        "family": record["family"],
                        "detail": record.get("detail"),
                    }
                )
                for record in task_records
            ]

    def list_recent(self, limit: int = 20) -> list[dict[str, Any]]:
        if limit <= 0 or not self.root.exists():
            return []
        items: list[dict[str, Any]] = []
        with self._lock:
            for metadata_path in self.root.glob("*/*.json"):
                asset_id = metadata_path.stem
                try:
                    metadata = self._read_metadata(asset_id, require_data=True)
                except (FileNotFoundError, OSError, ValueError):
                    continue
                items.append(metadata)
        return sorted(
            items,
            key=lambda item: (str(item.get("last_used_at") or ""), str(item.get("id") or "")),
            reverse=True,
        )[:limit]

    def read_item(self, asset_id: str) -> dict[str, Any]:
        with self._lock:
            return self._read_metadata(asset_id, require_data=True)

    def file_path(self, asset_id: str) -> Path:
        with self._lock:
            data_path, _ = self._item_paths(asset_id)
            if not data_path.is_file():
                raise FileNotFoundError(asset_id)
            return data_path

    def verified_file_path(self, asset_id: str, *, expected_size: int | None = None) -> Path:
        with self._lock:
            data_path, _ = self._item_paths(asset_id)
            metadata = self._read_metadata(asset_id, require_data=True)
            stored_size = metadata.get("size_bytes")
            if isinstance(stored_size, bool) or not isinstance(stored_size, int) or stored_size < 0:
                raise ValueError("reference_file_invalid")
            if expected_size is not None and expected_size != stored_size:
                raise ValueError("reference_file_invalid")
            self._verify_blob(data_path, expected_id=asset_id, expected_size=stored_size)
            return data_path

    def delete_created(self, asset_id: str) -> None:
        """Remove one caller-journaled newly created item, never a directory tree."""
        with self._lock:
            data_path, metadata_path = self._item_paths(asset_id)
            data_path.unlink(missing_ok=True)
            metadata_path.unlink(missing_ok=True)
            self._restore_token_path(asset_id).unlink(missing_ok=True)
            try:
                data_path.parent.rmdir()
            except OSError:
                pass

    def _restore_token_path(self, asset_id: str) -> Path:
        data_path, _ = self._item_paths(asset_id)
        return data_path.parent / ".restore-owner"

    def _touch_metadata(
        self,
        metadata: dict[str, Any],
        *,
        filename: str | None,
        mime_type: str | None,
        family: str | None,
    ) -> dict[str, Any]:
        asset_id = str(metadata.get("id") or "")
        _, metadata_path = self._item_paths(asset_id)
        updated = self._updated_metadata(
            metadata,
            filename=filename,
            mime_type=mime_type,
            family=family,
            touched_at=utc_now(),
        )
        self._write_metadata(metadata_path, updated)
        return updated

    def _updated_metadata(
        self,
        metadata: dict[str, Any],
        *,
        filename: str | None,
        mime_type: str | None,
        family: str | None,
        touched_at: str,
    ) -> dict[str, Any]:
        updated = dict(metadata)
        if filename is not None:
            updated["last_filename"] = _display_filename(filename)
        if mime_type is not None:
            updated["last_mime_type"] = str(mime_type)
        if family is not None:
            if family not in {"pdf", "spreadsheet", "document", "text"}:
                raise ValueError("reference_file_invalid")
            updated["last_family"] = family
            updated["detail"] = "auto" if family == "pdf" else None
        updated["last_used_at"] = touched_at
        try:
            used_count = int(updated.get("used_count") or 0)
        except (TypeError, ValueError):
            used_count = 0
        updated["used_count"] = used_count + 1
        return updated

    @staticmethod
    def _new_metadata(file: ValidatedReferenceFile, *, touched_at: str) -> dict[str, Any]:
        return {
            "id": file.asset_id,
            "sha256": file.asset_id,
            "size_bytes": file.size_bytes,
            "first_filename": file.filename,
            "last_filename": file.filename,
            "last_mime_type": file.mime_type,
            "last_family": file.family,
            "detail": file.detail,
            "created_at": touched_at,
            "last_used_at": touched_at,
            "used_count": 1,
        }

    def _read_verified_metadata(self, asset_id: str) -> dict[str, Any]:
        metadata = self._read_metadata(asset_id, require_data=True)
        size_bytes = metadata.get("size_bytes")
        if isinstance(size_bytes, bool) or not isinstance(size_bytes, int) or size_bytes < 0:
            raise ValueError("reference_file_invalid")
        data_path, _ = self._item_paths(asset_id)
        self._verify_blob(data_path, expected_id=asset_id, expected_size=size_bytes)
        self._task_record_from_metadata(metadata)
        return metadata

    @staticmethod
    def _task_record_from_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
        return reference_file_task_record(
            {
                **metadata,
                "filename": metadata.get("last_filename"),
                "mime_type": metadata.get("last_mime_type"),
                "family": metadata.get("last_family"),
            }
        )

    @staticmethod
    def _validated_unique_uploads(
        uploads: Iterable[ValidatedReferenceFile],
    ) -> list[ValidatedReferenceFile]:
        result: list[ValidatedReferenceFile] = []
        seen: set[str] = set()
        for upload in uploads:
            if not isinstance(upload, ValidatedReferenceFile):
                raise ValueError("reference_file_invalid")
            if upload.asset_id != hashlib.sha256(upload.data).hexdigest() or upload.size_bytes != len(upload.data):
                raise ValueError("reference_file_invalid")
            reference_file_task_record(upload)
            if upload.asset_id not in seen:
                seen.add(upload.asset_id)
                result.append(upload)
        return result

    @staticmethod
    def _stage_bytes(final_path: Path, data: bytes) -> Path:
        final_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = final_path.with_name(f".{final_path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(data)
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        return temporary

    @staticmethod
    def _stage_metadata(final_path: Path, metadata: dict[str, Any]) -> Path:
        final_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = final_path.with_name(f".{final_path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        return temporary

    @staticmethod
    def _publish_staged(staged_path: Path, final_path: Path) -> None:
        staged_path.replace(final_path)

    def _rollback_batch(
        self,
        *,
        staged_blobs: list[tuple[Path, Path]],
        staged_metadata: list[tuple[Path, Path]],
        new_blob_paths: set[Path],
        original_metadata: dict[Path, bytes | None],
    ) -> None:
        for path in new_blob_paths:
            path.unlink(missing_ok=True)
        for path, original in original_metadata.items():
            if original is None:
                path.unlink(missing_ok=True)
            else:
                self._restore_bytes(path, original)
        self._cleanup_staged_paths(staged_blobs, staged_metadata)
        for path in [*new_blob_paths, *original_metadata]:
            try:
                path.parent.rmdir()
            except OSError:
                pass

    @staticmethod
    def _restore_bytes(path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.rollback.tmp")
        try:
            temporary.write_bytes(data)
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _cleanup_staged_paths(
        staged_blobs: list[tuple[Path, Path]],
        staged_metadata: list[tuple[Path, Path]],
    ) -> None:
        for staged_path, _ in [*staged_blobs, *staged_metadata]:
            staged_path.unlink(missing_ok=True)

    def _read_metadata(self, asset_id: str, *, require_data: bool) -> dict[str, Any]:
        data_path, metadata_path = self._item_paths(asset_id)
        if require_data and not data_path.is_file():
            raise FileNotFoundError(asset_id)
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("reference_file_invalid") from exc
        if not isinstance(metadata, dict) or metadata.get("id") != asset_id or metadata.get("sha256") != asset_id:
            raise ValueError("reference_file_invalid")
        return metadata

    def _write_metadata(self, path: Path, metadata: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8")
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def _write_blob(self, path: Path, data: bytes) -> None:
        temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(data)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _verify_blob(path: Path, *, expected_id: str, expected_size: int) -> None:
        if path.stat().st_size != expected_size:
            raise ValueError("reference_file_invalid")
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected_id:
            raise ValueError("reference_file_invalid")

    def _item_paths(self, asset_id: str) -> tuple[Path, Path]:
        if not _ASSET_ID_RE.fullmatch(asset_id or ""):
            raise ValueError("Invalid reference file id")
        shard = self.root / asset_id[:2]
        data_path = (shard / f"{asset_id}.bin").resolve()
        metadata_path = (shard / f"{asset_id}.json").resolve()
        for path in (data_path, metadata_path):
            try:
                path.relative_to(self.root)
            except ValueError as exc:
                raise ValueError("Invalid reference file path") from exc
        return data_path, metadata_path


def resolve_reference_file_ids(
    storage: ReferenceFileStorage,
    asset_ids: Iterable[str],
    *,
    touch: bool,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for asset_id in dict.fromkeys(str(value or "").strip() for value in asset_ids):
        metadata = storage.touch(asset_id) if touch else storage.read_item(asset_id)
        records.append(
            reference_file_task_record(
                {
                    **metadata,
                    "filename": metadata.get("last_filename"),
                    "mime_type": metadata.get("last_mime_type"),
                    "family": metadata.get("last_family"),
                }
            )
        )
    return records


def store_reference_file_uploads(
    storage: ReferenceFileStorage,
    uploads: Iterable[ValidatedReferenceFile],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen: set[str] = set()
    for upload in uploads:
        if upload.asset_id in seen:
            continue
        seen.add(upload.asset_id)
        storage.create_or_touch(upload)
        records.append(reference_file_task_record(upload))
    return records


def _display_filename(filename: str) -> str:
    final_component = str(filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = "".join(character for character in final_component if ord(character) >= 32 and ord(character) != 127).strip()
    if not cleaned:
        raise ValueError("reference_file_invalid")
    if len(cleaned) <= 255:
        return cleaned
    suffix = Path(cleaned).suffix
    if suffix and len(suffix) < 255:
        stem_length = 255 - len(suffix)
        stem = cleaned[: -len(suffix)][:stem_length].rstrip()
        if stem:
            return f"{stem}{suffix}"
    return cleaned[:255].rstrip()


def _validate_file_content(data: bytes, validation: str) -> None:
    if validation == "pdf":
        if not data.startswith(b"%PDF-"):
            raise ValueError("reference_file_invalid")
        return
    if validation.startswith("ooxml-"):
        expected_prefix = {
            "ooxml-word": "word/",
            "ooxml-ppt": "ppt/",
            "ooxml-sheet": "xl/",
        }[validation]
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                names = archive.namelist()
                valid = any(name.startswith(expected_prefix) for name in names)
        except (OSError, zipfile.BadZipFile):
            valid = False
        if not valid:
            raise ValueError("reference_file_invalid")
        return
    if validation == "odt":
        expected_mimetype = b"application/vnd.oasis.opendocument.text"
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                mimetype_info = archive.getinfo("mimetype")
                if mimetype_info.file_size != len(expected_mimetype):
                    raise ValueError("reference_file_invalid")
                with archive.open(mimetype_info) as source:
                    mimetype = source.read(len(expected_mimetype) + 1)
        except ValueError:
            raise
        except (KeyError, OSError, RuntimeError, NotImplementedError, zipfile.BadZipFile):
            raise ValueError("reference_file_invalid") from None
        if mimetype != expected_mimetype:
            raise ValueError("reference_file_invalid")
        return
    if validation == "compound":
        if not data.startswith(_COMPOUND_FILE_SIGNATURE):
            raise ValueError("reference_file_invalid")
        return
    if validation == "rtf":
        if not data.startswith(b"{\\rtf"):
            raise ValueError("reference_file_invalid")
        return
    if validation == "text":
        if b"\x00" in data or any(data.startswith(magic) for magic in _DISALLOWED_TEXT_MAGIC):
            raise ValueError("reference_file_invalid")
        try:
            data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise ValueError("reference_file_invalid") from exc
        return
    raise ValueError("reference_file_invalid")
