from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from fastapi.testclient import TestClient


class WebUIHistoryApiTests(unittest.TestCase):
    def _app_client(self, root: Path):
        from codex_image.webui.app import create_app

        app = create_app(
            output_root=root,
            auth_checker=lambda: True,
            auto_start_queue=False,
        )
        client = TestClient(app)
        for index, task_id in enumerate(
            (
                "20260726100000-aaaaaaaa",
                "20260726100000-bbbbbbbb",
                "20260726100000-cccccccc",
            )
        ):
            app.state.storage.write_metadata(
                task_id,
                {
                    "task_id": task_id,
                    "created_at": (
                        f"2026-07-26T10:0{2 - index}:00+00:00"
                    ),
                    "updated_at": (
                        f"2026-07-26T10:0{2 - index}:00+00:00"
                    ),
                    "status": "completed",
                    "mode": "generate",
                    "prompt": task_id,
                    "params": {"size": "1024x1024"},
                    "generated_count": 1,
                    "failed_count": 0,
                    "total_count": 1,
                },
            )
        return app, client

    def test_tag_crud_reports_counts_and_cleans_associations(self) -> None:
        with TemporaryDirectory() as tmp:
            app, client = self._app_client(Path(tmp))
            created = client.post(
                "/api/task-history/tags",
                json={"name": " 暖色 "},
            )
            tag = created.json()["tag"]
            organized = client.post(
                "/api/task-history/organize",
                json={
                    "task_ids": [
                        "20260726100000-aaaaaaaa",
                        "20260726100000-bbbbbbbb",
                    ],
                    "add_tag_ids": [tag["tag_id"]],
                },
            )
            listed = client.get("/api/task-history/tags")
            renamed = client.patch(
                f"/api/task-history/tags/{tag['tag_id']}",
                json={"name": "精选"},
            )
            deleted = client.delete(
                f"/api/task-history/tags/{tag['tag_id']}"
            )
            organization = app.state.storage.history_organizations(
                ["20260726100000-aaaaaaaa"]
            )["20260726100000-aaaaaaaa"]

        self.assertEqual(created.status_code, 200)
        self.assertEqual(tag["name"], "暖色")
        self.assertEqual(organized.status_code, 200)
        self.assertEqual(
            listed.json()["tags"],
            [
                {
                    "tag_id": tag["tag_id"],
                    "name": "暖色",
                    "count": 2,
                }
            ],
        )
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(renamed.json()["tag"]["name"], "精选")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json()["affected_task_count"], 2)
        self.assertEqual(organization.tags, ())

    def test_tag_errors_use_stable_status_codes(self) -> None:
        with TemporaryDirectory() as tmp:
            _app, client = self._app_client(Path(tmp))
            invalid = client.post(
                "/api/task-history/tags",
                json={"name": "   "},
            )
            first = client.post(
                "/api/task-history/tags",
                json={"name": "Ａ"},
            )
            duplicate = client.post(
                "/api/task-history/tags",
                json={"name": "a"},
            )
            missing_rename = client.patch(
                "/api/task-history/tags/missing",
                json={"name": "新名称"},
            )
            missing_delete = client.delete(
                "/api/task-history/tags/missing"
            )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(duplicate.status_code, 409)
        self.assertEqual(missing_rename.status_code, 404)
        self.assertEqual(missing_delete.status_code, 404)

    def test_batch_organization_is_atomic_and_validated(self) -> None:
        with TemporaryDirectory() as tmp:
            app, client = self._app_client(Path(tmp))
            tag_id = client.post(
                "/api/task-history/tags",
                json={"name": "成片"},
            ).json()["tag"]["tag_id"]
            empty = client.post(
                "/api/task-history/organize",
                json={"task_ids": []},
            )
            too_many = client.post(
                "/api/task-history/organize",
                json={
                    "task_ids": [
                        f"task-{index}"
                        for index in range(301)
                    ]
                },
            )
            overlap = client.post(
                "/api/task-history/organize",
                json={
                    "task_ids": ["20260726100000-aaaaaaaa"],
                    "add_tag_ids": [tag_id],
                    "remove_tag_ids": [tag_id],
                },
            )
            missing_task = client.post(
                "/api/task-history/organize",
                json={
                    "task_ids": [
                        "20260726100000-aaaaaaaa",
                        "missing-task",
                    ],
                    "favorite": True,
                    "add_tag_ids": [tag_id],
                },
            )
            missing_tag = client.post(
                "/api/task-history/organize",
                json={
                    "task_ids": ["20260726100000-aaaaaaaa"],
                    "favorite": True,
                    "add_tag_ids": ["missing-tag"],
                },
            )
            organization = app.state.storage.history_organizations(
                ["20260726100000-aaaaaaaa"]
            )["20260726100000-aaaaaaaa"]

        self.assertEqual(empty.status_code, 422)
        self.assertEqual(too_many.status_code, 422)
        self.assertEqual(overlap.status_code, 422)
        self.assertEqual(missing_task.status_code, 404)
        self.assertEqual(missing_tag.status_code, 404)
        self.assertFalse(organization.favorite)
        self.assertEqual(organization.tags, ())

    def test_repeated_tag_filters_use_and_and_return_organization(self) -> None:
        with TemporaryDirectory() as tmp:
            _app, client = self._app_client(Path(tmp))
            first_tag = client.post(
                "/api/task-history/tags",
                json={"name": "暖色"},
            ).json()["tag"]
            second_tag = client.post(
                "/api/task-history/tags",
                json={"name": "精选"},
            ).json()["tag"]
            first = client.post(
                "/api/task-history/organize",
                json={
                    "task_ids": ["20260726100000-aaaaaaaa"],
                    "favorite": True,
                    "add_tag_ids": [
                        first_tag["tag_id"],
                        second_tag["tag_id"],
                    ],
                },
            )
            client.post(
                "/api/task-history/organize",
                json={
                    "task_ids": ["20260726100000-bbbbbbbb"],
                    "add_tag_ids": [first_tag["tag_id"]],
                },
            )
            filtered = client.get(
                "/api/task-history/tasks",
                params=[
                    ("tag", first_tag["tag_id"]),
                    ("tag", second_tag["tag_id"]),
                    ("limit", "10"),
                ],
            )
            favorites = client.get(
                "/api/task-history/tasks",
                params={"favorite": "true", "limit": 10},
            )
            conflict = client.get(
                "/api/task-history/tasks",
                params=[
                    ("tag", first_tag["tag_id"]),
                    ("untagged", "true"),
                ],
            )

        self.assertEqual(first.status_code, 200)
        organization = first.json()["organizations"][
            "20260726100000-aaaaaaaa"
        ]
        self.assertTrue(organization["favorite"])
        self.assertEqual(
            {tag["tag_id"] for tag in organization["tags"]},
            {first_tag["tag_id"], second_tag["tag_id"]},
        )
        self.assertEqual(filtered.status_code, 200)
        self.assertEqual(
            [task["task_id"] for task in filtered.json()["tasks"]],
            ["20260726100000-aaaaaaaa"],
        )
        self.assertEqual(
            [task["task_id"] for task in favorites.json()["tasks"]],
            ["20260726100000-aaaaaaaa"],
        )
        self.assertEqual(conflict.status_code, 422)

    def test_task_detail_adds_organization_as_a_sibling(self) -> None:
        with TemporaryDirectory() as tmp:
            _app, client = self._app_client(Path(tmp))
            tag = client.post(
                "/api/task-history/tags",
                json={"name": "待选"},
            ).json()["tag"]
            client.post(
                "/api/task-history/organize",
                json={
                    "task_ids": ["20260726100000-aaaaaaaa"],
                    "favorite": True,
                    "add_tag_ids": [tag["tag_id"]],
                },
            )
            response = client.get(
                "/api/tasks/20260726100000-aaaaaaaa"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            payload["task"]["task_id"],
            "20260726100000-aaaaaaaa",
        )
        self.assertTrue(payload["organization"]["favorite"])
        self.assertEqual(
            payload["organization"]["tags"],
            [
                {
                    "tag_id": tag["tag_id"],
                    "name": tag["name"],
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
