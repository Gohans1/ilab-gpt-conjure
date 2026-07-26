from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
import tempfile
import unittest

from codex_image.webui.events import event_snapshot
from tests.webui_helpers import FakeImageClient


class WebUIEventSnapshotTests(unittest.TestCase):
    def test_generation_snapshot_bounds_each_activity_group_and_keeps_older_active_task(self) -> None:
        from codex_image.webui.app import create_app

        with tempfile.TemporaryDirectory() as tmp:
            app = create_app(
                output_root=Path(tmp),
                client_factory=lambda: FakeImageClient(),
                auth_checker=lambda: True,
                auto_start_queue=False,
            )
            now = datetime.now().astimezone()
            active_task_id = "20260601000000-active"
            app.state.storage.write_metadata(
                active_task_id,
                {
                    "task_id": active_task_id,
                    "created_at": "2026-06-01T00:00:00+00:00",
                    "updated_at": "2026-06-01T00:00:00+00:00",
                    "status": "queued",
                    "mode": "generate",
                    "prompt": "older active task",
                    "params": {},
                    "input_files": [],
                },
            )
            app.state.queue_storage.enqueue(active_task_id)

            for index in range(55):
                task_id = f"20260701{index:06d}-recent"
                completed_at = now.replace(hour=12, minute=0, second=0, microsecond=0) + timedelta(seconds=index)
                app.state.storage.write_metadata(
                    task_id,
                    {
                        "task_id": task_id,
                        "created_at": (now - timedelta(days=20, seconds=index)).isoformat(),
                        "updated_at": completed_at.isoformat(),
                        "completed_at": completed_at.isoformat(),
                        "status": "completed",
                        "mode": "generate",
                        "prompt": f"recent task {index}",
                        "params": {},
                        "input_files": [],
                    },
                )
            for label, days_ago in (("yesterday", 1), ("last7", 3)):
                terminal_at = now - timedelta(days=days_ago)
                app.state.storage.write_metadata(
                    label,
                    {
                        "task_id": label,
                        "created_at": now.isoformat(),
                        "updated_at": terminal_at.isoformat(),
                        "completed_at": terminal_at.isoformat(),
                        "status": "completed",
                        "mode": "generate",
                        "prompt": label,
                        "params": {},
                        "input_files": [],
                    },
                )

            snapshot = event_snapshot(app.state.ctx)

        task_ids = [task["task_id"] for task in snapshot["tasks"]]
        groups = {group["key"]: group for group in snapshot["task_groups"]}
        self.assertEqual(len(task_ids), 53)
        self.assertEqual(len(set(task_ids)), 53)
        self.assertIn(active_task_id, task_ids)
        self.assertEqual(groups["today"]["count"], 55)
        self.assertEqual(len(groups["today"]["tasks"]), 50)
        self.assertEqual(groups["yesterday"]["count"], 1)
        self.assertEqual(groups["last7"]["count"], 1)
        self.assertEqual(snapshot["queue"]["summary"]["waiting_count"], 1)


if __name__ == "__main__":
    unittest.main()
