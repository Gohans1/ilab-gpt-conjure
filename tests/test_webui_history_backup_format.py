from __future__ import annotations

import copy
import hashlib
import json
import unittest

from codex_image.webui.history_backup_format import (
    BACKUP_FORMAT,
    BACKUP_FORMAT_VERSION,
    canonical_task_fingerprint,
    parse_backup_manifest,
    safe_backup_member_path,
)


def _valid_manifest() -> dict[str, object]:
    return {
        "format": "ilab-conjure-task-backup",
        "version": 1,
        "created_at": "2026-08-01T12:00:00+00:00",
        "app_version": "1.2.3",
        "scope": {"kind": "selected", "task_ids": ["task-001"]},
        "task_count": 1,
        "file_count": 3,
        "uncompressed_bytes": 32,
        "tasks": [
            {
                "task_id": "task-001",
                "created_at": "2026-08-01T11:00:00+00:00",
                "fingerprint": "sha256:" + "a" * 64,
                "files": [
                    {
                        "path": "tasks/task-001/source/metadata.json",
                        "role": "metadata",
                        "required": True,
                        "size_bytes": 10,
                        "sha256": "b" * 64,
                    },
                    {
                        "path": "tasks/task-001/source/request.json",
                        "role": "request",
                        "required": True,
                        "size_bytes": 12,
                        "sha256": "c" * 64,
                    },
                    {
                        "path": "tasks/task-001/outputs/output-0001.png",
                        "role": "output",
                        "required": False,
                        "size_bytes": 10,
                        "sha256": "d" * 64,
                        "source_index": 1,
                    },
                ],
            }
        ],
    }


def _payload(manifest: dict[str, object]) -> bytes:
    return json.dumps(manifest).encode("utf-8")


class HistoryBackupManifestTests(unittest.TestCase):
    def test_parses_valid_v1_manifest_into_immutable_records(self) -> None:
        manifest = parse_backup_manifest(_payload(_valid_manifest()))

        self.assertEqual(manifest.format, "ilab-conjure-task-backup")
        self.assertEqual(manifest.version, 1)
        self.assertEqual(manifest.tasks[0].files[0].role, "metadata")
        self.assertEqual(manifest.tasks[0].files[2].source_index, 1)
        with self.assertRaises(AttributeError):
            manifest.task_count = 2  # type: ignore[misc]

    def test_rejects_unsafe_or_inconsistent_manifest_data(self) -> None:
        cases: tuple[tuple[str, str, object], ...] = (
            ("duplicate task id", "tasks", [_valid_manifest()["tasks"][0], _valid_manifest()["tasks"][0]]),
            (
                "duplicate member path",
                "tasks",
                [
                    {
                        **_valid_manifest()["tasks"][0],
                        "files": [
                            _valid_manifest()["tasks"][0]["files"][0],
                            {
                                **_valid_manifest()["tasks"][0]["files"][1],
                                "path": "tasks/task-001/source/metadata.json",
                            },
                        ],
                    }
                ],
            ),
            ("absolute member path", "tasks.0.files.0.path", "/metadata.json"),
            ("parent member path", "tasks.0.files.0.path", "tasks/task-001/source/../metadata.json"),
            ("backslash member path", "tasks.0.files.0.path", "tasks\\task-001\\source\\metadata.json"),
            ("control character member path", "tasks.0.files.0.path", "tasks/task-001/source/meta\n.json"),
            ("invalid SHA-256", "tasks.0.files.0.sha256", "not-a-digest"),
            ("negative file size", "tasks.0.files.0.size_bytes", -1),
            ("incorrect task count", "task_count", 2),
            ("incorrect file count", "file_count", 2),
            ("incorrect byte total", "uncompressed_bytes", 31),
            ("unknown required role", "tasks.0.files.0.role", "future_required_role"),
            ("future version", "version", 2),
        )

        for label, field, value in cases:
            with self.subTest(label=label):
                invalid = copy.deepcopy(_valid_manifest())
                if field == "tasks":
                    invalid["tasks"] = value
                    if label == "duplicate task id":
                        invalid["task_count"] = 2
                        invalid["file_count"] = 6
                        invalid["uncompressed_bytes"] = 64
                elif field.startswith("tasks.0.files.0."):
                    key = field.rsplit(".", 1)[1]
                    invalid["tasks"][0]["files"][0][key] = value
                else:
                    invalid[field] = value
                with self.assertRaises(ValueError):
                    parse_backup_manifest(_payload(invalid))

    def test_ignores_unknown_optional_fields_and_optional_future_roles(self) -> None:
        manifest_payload = _valid_manifest()
        manifest_payload["unknown_top_level"] = {"ignored": True}
        manifest_payload["tasks"][0]["unknown_task_field"] = "ignored"
        manifest_payload["tasks"][0]["files"].append(
            {
                "path": "tasks/task-001/inputs/images/future_optional_role-0001.bin",
                "role": "future_optional_role",
                "required": False,
                "size_bytes": 5,
                "sha256": "e" * 64,
            }
        )
        manifest_payload["file_count"] = 4
        manifest_payload["uncompressed_bytes"] = 37

        manifest = parse_backup_manifest(_payload(manifest_payload))

        self.assertEqual(len(manifest.tasks[0].files), 3)

    def test_rejects_windows_absolute_path_for_unknown_optional_role(self) -> None:
        manifest_payload = _valid_manifest()
        manifest_payload["tasks"][0]["files"][0].update(
            {
                "path": "C:/local/secret.bin",
                "role": "future_optional_role",
                "required": False,
            }
        )

        with self.assertRaises(ValueError):
            parse_backup_manifest(_payload(manifest_payload))

    def test_normalizes_malformed_manifest_shapes_but_preserves_semantic_codes(self) -> None:
        malformed: list[object] = [[], {"format": []}]
        wrong_tasks = copy.deepcopy(_valid_manifest())
        wrong_tasks["tasks"] = {"task": "not-a-list"}
        malformed.append(wrong_tasks)
        wrong_file = copy.deepcopy(_valid_manifest())
        wrong_file["tasks"][0]["files"][0] = "not-an-object"
        malformed.append(wrong_file)
        wrong_size_type = copy.deepcopy(_valid_manifest())
        wrong_size_type["tasks"][0]["files"][0]["size_bytes"] = "10"
        malformed.append(wrong_size_type)
        for value in malformed:
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "^backup_manifest_invalid$"):
                    parse_backup_manifest(json.dumps(value).encode("utf-8"))

        future = copy.deepcopy(_valid_manifest())
        future["version"] = 2
        with self.assertRaisesRegex(ValueError, "^backup_manifest_version_unsupported$"):
            parse_backup_manifest(_payload(future))

        unsafe = copy.deepcopy(_valid_manifest())
        unsafe["tasks"][0]["files"][0]["path"] = "../metadata.json"
        with self.assertRaisesRegex(ValueError, "^backup_manifest_member_path_invalid$"):
            parse_backup_manifest(_payload(unsafe))


class HistoryBackupPathAndFingerprintTests(unittest.TestCase):
    def test_builds_canonical_member_paths(self) -> None:
        cases = (
            ("task-001", "metadata", "metadata.json", "tasks/task-001/source/metadata.json"),
            ("task-001", "request", "request.json", "tasks/task-001/source/request.json"),
            ("task-001", "organization", "organization.json", "tasks/task-001/source/organization.json"),
            ("task-001", "output", "output-0001.webp", "tasks/task-001/outputs/output-0001.webp"),
            ("task-001", "input", "input-0001.png", "tasks/task-001/inputs/images/input-0001.png"),
            ("task-001", "mask", "mask-0001.png", "tasks/task-001/inputs/masks/mask-0001.png"),
            ("task-001", "reference_file", "reference_file-0002.pdf", "tasks/task-001/inputs/references/reference_file-0002.pdf"),
        )

        for task_id, role, filename, expected in cases:
            with self.subTest(role=role):
                self.assertEqual(
                    safe_backup_member_path(task_id, role, filename), expected
                )

    def test_rejects_unsafe_task_ids_and_binary_filenames(self) -> None:
        for task_id, role, filename in (
            ("../task", "metadata", "metadata.json"),
            ("task/001", "metadata", "metadata.json"),
            ("task\x00", "output", "output-0001.png"),
            ("task-001", "output", "../output-0001.png"),
            ("task-001", "output", "output\\0001.png"),
            ("task-001", "output", "output-1.png"),
        ):
            with self.subTest(task_id=task_id, filename=filename):
                with self.assertRaises(ValueError):
                    safe_backup_member_path(task_id, role, filename)

    def test_fingerprint_is_stable_for_equivalent_file_order_and_ignores_paths(self) -> None:
        metadata = {"task_id": "task-001", "status": "completed", "output_file": "/private/output.png"}
        request = {"prompt": "a small red fox", "model": "gpt-image-1"}
        organization = {"archived_at": "2026-08-01T12:00:00+00:00"}
        files = [
            {"role": "output", "source_index": 1, "size_bytes": 10, "sha256": "a" * 64, "path": "/private/output.png"},
            {"role": "metadata", "source_index": None, "size_bytes": 12, "sha256": "b" * 64, "path": "/private/metadata.json"},
        ]

        first = canonical_task_fingerprint(metadata, request, files, organization)
        second = canonical_task_fingerprint(
            metadata,
            request,
            list(reversed([{**item, "path": "/another/location"} for item in files])),
            organization,
        )
        private_list_fingerprint = canonical_task_fingerprint(
            {**metadata, "private_paths": ["/private/first.png"]},
            request,
            files,
            organization,
        )
        other_private_list_fingerprint = canonical_task_fingerprint(
            {**metadata, "private_paths": ["/another/private.png"]},
            request,
            files,
            organization,
        )
        private_key_fingerprint = canonical_task_fingerprint(
            {"task_id": "task-001", "/private/one": "value"},
            request,
            files,
            organization,
        )
        other_private_key_fingerprint = canonical_task_fingerprint(
            {"task_id": "task-001", "/private/two": "value"},
            request,
            files,
            organization,
        )

        self.assertEqual(first, second)
        self.assertEqual(private_list_fingerprint, other_private_list_fingerprint)
        self.assertEqual(private_key_fingerprint, other_private_key_fingerprint)
        self.assertEqual(first, "sha256:" + hashlib.sha256(
            b'{"files":[["metadata",null,12,"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],["output",1,10,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]],"metadata":{"status":"completed","task_id":"task-001"},"organization":{"favorite":false,"tags":[]},"request":{"model":"gpt-image-1","prompt":"a small red fox"}}'
        ).hexdigest())

    def test_fingerprint_uses_portable_organization_names_not_local_tag_ids(self) -> None:
        metadata = {"task_id": "task-001", "status": "completed"}
        request = {"prompt": "safe"}
        files = [{"role": "metadata", "source_index": None, "size_bytes": 1, "sha256": "a" * 64}]

        first = canonical_task_fingerprint(
            metadata,
            request,
            files,
            {"favorite": True, "tags": [{"tag_id": "local-a", "name": " Travel "}]},
        )
        second = canonical_task_fingerprint(
            metadata,
            request,
            files,
            {"tags": [{"name": "Travel", "tag_id": "local-b"}], "favorite": True},
        )

        self.assertEqual(first, second)


class HistoryBackupResourceLimitTests(unittest.TestCase):
    def test_declares_backup_resource_ceiling_values(self) -> None:
        from codex_image.webui import resource_limits

        self.assertEqual(resource_limits.MAX_HISTORY_BACKUP_UPLOAD_BYTES, 64 * 1024 * 1024 * 1024)
        self.assertEqual(resource_limits.MAX_HISTORY_BACKUP_EXPANDED_BYTES, 128 * 1024 * 1024 * 1024)
        self.assertEqual(resource_limits.MAX_HISTORY_BACKUP_MEMBER_BYTES, 4 * 1024 * 1024 * 1024)
        self.assertEqual(resource_limits.MAX_HISTORY_BACKUP_MANIFEST_BYTES, 16 * 1024 * 1024)
        self.assertEqual(resource_limits.MAX_HISTORY_BACKUP_ENTRIES, 1_000_000)
        self.assertEqual(resource_limits.MAX_HISTORY_BACKUP_COMPRESSION_RATIO, 200)
        self.assertEqual(resource_limits.HISTORY_BACKUP_UPLOAD_CHUNK_BYTES, 8 * 1024 * 1024)
        self.assertEqual(resource_limits.HISTORY_BACKUP_MIN_FREE_BYTES, 2 * 1024 * 1024 * 1024)
        self.assertEqual(resource_limits.HISTORY_BACKUP_FREE_RATIO, 0.10)


if __name__ == "__main__":
    unittest.main()
