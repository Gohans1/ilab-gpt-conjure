from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from tempfile import TemporaryDirectory
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from codex_image.webui.history_organizer import HistoryOrganizer
from codex_image.webui.history_query import HistoryFilter, HistoryQueryService
from codex_image.webui.routes.history import register_history_routes
from codex_image.webui.task_index import SQLiteTaskIndex


class _RouteStorage:
    def __init__(self, index: SQLiteTaskIndex, service: HistoryQueryService) -> None:
        self.task_index = index
        self.history_query = service
        self.refresh_calls = 0

    def refresh_stale_task_index(self) -> int:
        self.refresh_calls += 1
        return 0

    def query_task_history(self, **kwargs):
        self.refresh_stale_task_index()
        return self.history_query.query(**kwargs)


class _CapturingTaskIndex:
    def __init__(self) -> None:
        self.calls: list[tuple[str, HistoryFilter, int]] = []

    def query_history_around(
        self,
        anchor_task_id: str,
        filters: HistoryFilter,
        *,
        limit: int = 50,
    ) -> dict[str, object]:
        self.calls.append((anchor_task_id, filters, limit))
        return {
            "tasks": [],
            "next_cursor": None,
            "previous_cursor": None,
            "anchor_found": False,
        }


class HistoryAnchorWindowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        root = Path(self.temporary.name)
        self.index = SQLiteTaskIndex(root / "webui-task-index.db")
        self.organizer = HistoryOrganizer(root / "webui-history-organizer.db")
        self.service = HistoryQueryService(self.index, self.organizer)
        self.tag = self.organizer.create_tag("Anchor set")
        base = datetime(2026, 7, 1, tzinfo=timezone.utc)
        for number in range(120):
            # Pairs deliberately share a timestamp so task_id is a required tie-break.
            timestamp = (base + timedelta(minutes=number // 2)).isoformat()
            even = number % 2 == 0
            self.index.upsert(
                {
                    "task_id": f"task-{number:03d}",
                    "created_at": timestamp,
                    "updated_at": timestamp,
                    "completed_at": timestamp,
                    "terminal_at": timestamp,
                    "status": "completed" if number % 10 else "failed",
                    "mode": "generate" if even else "animation_edit",
                    "prompt": f"anchor corpus item {number:03d}",
                    "params": {
                        "size": "1152x2048" if even else "1024x1024",
                        "quality": "high" if even else "standard",
                        "ratio": "9:16" if even else "1:1",
                        "orientation": "portrait" if even else "square",
                        "prompt_fidelity": "strict" if even else "original",
                    },
                    "backend": "openai_images" if even else "codex_images",
                    "api_provider_name": "provider-even" if even else "provider-odd",
                    "archived_at": timestamp if number % 6 == 0 else "",
                }
            )
        tagged = [f"task-{number:03d}" for number in range(0, 120, 4)]
        self.organizer.organize(
            tagged,
            favorite=True,
            add_tag_ids=[self.tag.tag_id],
        )

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def _global_ids(self, filters: HistoryFilter) -> list[str]:
        page = self.service.query(limit=100, **self._filter_kwargs(filters))
        second = self.service.query(
            limit=100,
            cursor=page["next_cursor"],
            **self._filter_kwargs(filters),
        ) if page["next_cursor"] else {"tasks": []}
        return [item["task_id"] for item in [*page["tasks"], *second["tasks"]]]

    @staticmethod
    def _filter_kwargs(filters: HistoryFilter) -> dict[str, object]:
        return {
            "q": filters.q,
            "month": filters.month,
            "mode": filters.mode,
            "status": filters.status,
            "prompt_mode": filters.prompt_mode,
            "size": filters.size,
            "quality": filters.quality,
            "ratio": filters.ratio,
            "orientation": filters.orientation,
            "backend": filters.backend,
            "provider": filters.provider,
            "archived": filters.archived,
            "favorite": filters.favorite,
            "tag_ids": list(filters.tag_ids),
            "untagged": filters.untagged,
            "sort": filters.sort,
        }

    def test_middle_anchor_is_once_in_strict_global_order_for_both_sorts(self) -> None:
        for sort in ("newest", "oldest"):
            with self.subTest(sort=sort):
                filters = HistoryFilter(sort=sort)
                expected = self._global_ids(filters)
                page = self.service.query_around("task-060", filters, limit=50)
                ids = [task["task_id"] for task in page["tasks"]]

                self.assertTrue(page["anchor_found"])
                self.assertEqual(len(ids), 50)
                self.assertEqual(ids.count("task-060"), 1)
                start = expected.index(ids[0])
                self.assertEqual(ids, expected[start : start + len(ids)])
                self.assertEqual(ids.index("task-060"), 25)
                self.assertIsNotNone(page["previous_cursor"])
                self.assertIsNotNone(page["next_cursor"])

                previous = self.service.query(
                    limit=50,
                    cursor=page["previous_cursor"],
                    direction="previous",
                    **self._filter_kwargs(filters),
                )
                following = self.service.query(
                    limit=50,
                    cursor=page["next_cursor"],
                    direction="next",
                    **self._filter_kwargs(filters),
                )
                previous_ids = [task["task_id"] for task in previous["tasks"]]
                following_ids = [task["task_id"] for task in following["tasks"]]
                end = start + len(ids)
                self.assertEqual(previous_ids, expected[max(0, start - 50) : start])
                self.assertEqual(following_ids, expected[end : end + 50])
                self.assertEqual(
                    [*previous_ids, *ids, *following_ids],
                    expected[max(0, start - 50) : end + 50],
                )

    def test_first_last_and_missing_anchors_expose_only_real_sides(self) -> None:
        for sort in ("newest", "oldest"):
            filters = HistoryFilter(sort=sort)
            expected = self._global_ids(filters)
            first = self.service.query_around(expected[0], filters, limit=50)
            last = self.service.query_around(expected[-1], filters, limit=50)
            self.assertIsNone(first["previous_cursor"])
            self.assertIsNotNone(first["next_cursor"])
            self.assertIsNotNone(last["previous_cursor"])
            self.assertIsNone(last["next_cursor"])
            self.assertEqual(first["tasks"][0]["task_id"], expected[0])
            self.assertEqual(last["tasks"][-1]["task_id"], expected[-1])

        missing = self.service.query_around("task-missing", HistoryFilter(), limit=50)
        self.assertEqual(
            missing,
            {
                "tasks": [],
                "next_cursor": None,
                "previous_cursor": None,
                "anchor_found": False,
            },
        )

    def test_every_current_filter_uses_the_same_filtered_anchor_relation(self) -> None:
        cases = {
            "q": ("task-060", HistoryFilter(q="corpus item 060")),
            "month": ("task-060", HistoryFilter(month="2026-07")),
            "mode": ("task-060", HistoryFilter(mode="generate")),
            "status": ("task-060", HistoryFilter(status="failed")),
            "prompt_mode": ("task-060", HistoryFilter(prompt_mode="strict")),
            "size": ("task-060", HistoryFilter(size="1152x2048")),
            "quality": ("task-060", HistoryFilter(quality="high")),
            "ratio": ("task-060", HistoryFilter(ratio="9:16")),
            "orientation": ("task-060", HistoryFilter(orientation="portrait")),
            "backend": ("task-060", HistoryFilter(backend="openai_images")),
            "provider": ("task-060", HistoryFilter(provider="provider-even")),
            "archived": ("task-060", HistoryFilter(archived=True)),
            "favorite": ("task-060", HistoryFilter(favorite=True)),
            "tag": ("task-060", HistoryFilter(tag_ids=(self.tag.tag_id,))),
            "untagged": ("task-061", HistoryFilter(untagged=True)),
            "combined": (
                "task-060",
                HistoryFilter(
                    q="anchor corpus",
                    month="2026-07",
                    mode="generate",
                    status="failed",
                    prompt_mode="strict",
                    size="1152x2048",
                    quality="high",
                    ratio="9:16",
                    orientation="portrait",
                    backend="openai_images",
                    provider="provider-even",
                    archived=True,
                    favorite=True,
                    tag_ids=(self.tag.tag_id,),
                ),
            ),
        }
        for label, (anchor, filters) in cases.items():
            with self.subTest(label=label):
                page = self.service.query_around(anchor, filters, limit=50)
                self.assertTrue(page["anchor_found"])
                self.assertIn(anchor, [task["task_id"] for task in page["tasks"]])

        unmatched = self.service.query_around(
            "task-061",
            HistoryFilter(mode="generate"),
            limit=50,
        )
        self.assertFalse(unmatched["anchor_found"])
        self.assertEqual(unmatched["tasks"], [])

    def test_single_and_small_filtered_relations_have_exact_window_boundaries(self) -> None:
        cases = (
            ("task-060", HistoryFilter(q="corpus item 060"), 1),
            ("task-060", HistoryFilter(status="failed"), 12),
        )
        for anchor, base_filters, expected_count in cases:
            for sort in ("newest", "oldest"):
                with self.subTest(anchor=anchor, filters=base_filters, sort=sort):
                    filters = HistoryFilter(
                        **{
                            **self._filter_kwargs(base_filters),
                            "tag_ids": tuple(base_filters.tag_ids),
                            "sort": sort,
                        }
                    )
                    page = self.service.query_around(anchor, filters, limit=50)
                    ids = [task["task_id"] for task in page["tasks"]]

                    self.assertTrue(page["anchor_found"])
                    self.assertLessEqual(len(ids), 50)
                    self.assertEqual(len(ids), expected_count)
                    self.assertEqual(ids.count(anchor), 1)
                    self.assertIsNone(page["previous_cursor"])
                    self.assertIsNone(page["next_cursor"])

    def test_anchor_row_payload_matches_ordinary_query_with_organizer_hydration(self) -> None:
        filters = HistoryFilter(
            favorite=True,
            tag_ids=(self.tag.tag_id,),
        )
        ordinary = self.service.query(
            limit=100,
            **self._filter_kwargs(filters),
        )
        anchored = self.service.query_around("task-060", filters, limit=50)
        ordinary_row = next(
            task for task in ordinary["tasks"] if task["task_id"] == "task-060"
        )
        anchored_row = next(
            task for task in anchored["tasks"] if task["task_id"] == "task-060"
        )

        self.assertEqual(anchored_row, ordinary_row)
        self.assertTrue(anchored_row["favorite"])
        self.assertEqual(
            [tag["tag_id"] for tag in anchored_row["tags"]],
            [self.tag.tag_id],
        )

    def test_route_anchor_mode_validation_filters_and_ordinary_paging(self) -> None:
        storage = _RouteStorage(self.index, self.service)
        app = FastAPI()
        register_history_routes(app, SimpleNamespace(storage=storage))
        client = TestClient(app)

        ordinary = client.get("/api/task-history/tasks?limit=7")
        self.assertEqual(ordinary.status_code, 200)
        self.assertEqual(len(ordinary.json()["tasks"]), 7)
        self.assertNotIn("anchor_found", ordinary.json())

        anchored = client.get(
            "/api/task-history/tasks",
            params={
                "anchor_task_id": "task-060",
                "mode": "generate",
                "provider": "provider-even",
                "tag": self.tag.tag_id,
            },
        )
        self.assertEqual(anchored.status_code, 200)
        self.assertTrue(anchored.json()["anchor_found"])
        self.assertEqual(storage.refresh_calls, 2)

        missing = client.get(
            "/api/task-history/tasks?anchor_task_id=task-061&mode=generate"
        )
        self.assertEqual(missing.status_code, 200)
        self.assertFalse(missing.json()["anchor_found"])
        self.assertEqual(missing.json()["tasks"], [])

        for query in (
            "anchor_task_id=task-060&cursor=abc",
            "anchor_task_id=task-060&direction=previous",
            "anchor_task_id=",
            "anchor_task_id=../task-060",
        ):
            with self.subTest(query=query):
                self.assertEqual(
                    client.get(f"/api/task-history/tasks?{query}").status_code,
                    422,
                )

    def test_route_passes_every_history_filter_to_anchor_query(self) -> None:
        capturing_index = _CapturingTaskIndex()
        storage = _RouteStorage(capturing_index, self.service)
        app = FastAPI()
        register_history_routes(app, SimpleNamespace(storage=storage))
        client = TestClient(app)

        response = client.get(
            "/api/task-history/tasks",
            params=[
                ("anchor_task_id", "task-060"),
                ("limit", "37"),
                ("q", "anchor corpus"),
                ("month", "2026-07"),
                ("mode", "generate"),
                ("status", "failed"),
                ("prompt_mode", "strict"),
                ("size", "1152x2048"),
                ("quality", "high"),
                ("ratio", "9:16"),
                ("orientation", "portrait"),
                ("backend", "openai_images"),
                ("provider", "provider-even"),
                ("archived", "true"),
                ("favorite", "false"),
                ("tag", "tag-one"),
                ("tag", "tag-two"),
                ("sort", "oldest"),
            ],
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            capturing_index.calls[0],
            (
                "task-060",
                HistoryFilter(
                    q="anchor corpus",
                    month="2026-07",
                    mode="generate",
                    status="failed",
                    prompt_mode="strict",
                    size="1152x2048",
                    quality="high",
                    ratio="9:16",
                    orientation="portrait",
                    backend="openai_images",
                    provider="provider-even",
                    archived=True,
                    favorite=False,
                    tag_ids=("tag-one", "tag-two"),
                    sort="oldest",
                ),
                37,
            ),
        )

        untagged = client.get(
            "/api/task-history/tasks",
            params={
                "anchor_task_id": "task-061",
                "untagged": "true",
            },
        )
        self.assertEqual(untagged.status_code, 200)
        self.assertTrue(capturing_index.calls[1][1].untagged)


if __name__ == "__main__":
    unittest.main()
