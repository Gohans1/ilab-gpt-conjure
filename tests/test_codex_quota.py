from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from tests.helpers import FakeResponse, FakeTransport, write_auth_file


class CodexQuotaFetcherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.auth_path = Path(self.tmpdir.name) / "auth.json"
        write_auth_file(
            self.auth_path,
            access_token="access-token-for-test",
            refresh_token="refresh-token-for-test",
            account_id="acct-test",
        )

    def test_fetches_session_and_weekly_remaining_quota_without_returning_credentials(self) -> None:
        payload = {
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 18.5,
                    "reset_at": "2026-08-31T20:00:00Z",
                    "limit_window_seconds": 18000,
                },
                "secondary_window": {
                    "used_percent": 73.25,
                    "reset_at": "2026-09-05T20:00:00Z",
                    "limit_window_seconds": 604800,
                },
            },
        }
        transport = FakeTransport(
            [FakeResponse(status=200, body=json.dumps(payload).encode("utf-8"))]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertTrue(result["available"])
        self.assertEqual(result["remaining_percent"], 27)
        self.assertEqual(
            [(item["label"], item["remaining_percent"]) for item in result["windows"]],
            [("Session", 82), ("Weekly", 27)],
        )
        self.assertEqual(transport.requests[0]["headers"]["ChatGPT-Account-Id"], "acct-test")
        self.assertNotIn("access_token", result)
        self.assertNotIn("refresh_token", result)
        rendered = json.dumps(result)
        self.assertNotIn("access-token-for-test", rendered)
        self.assertNotIn("refresh-token-for-test", rendered)

    def test_missing_usage_values_remain_unknown_instead_of_zero(self) -> None:
        transport = FakeTransport(
            [
                FakeResponse(
                    status=200,
                    body=json.dumps({"rate_limit": {"primary_window": {}, "secondary_window": {}}}).encode("utf-8"),
                )
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertFalse(result["available"])
        self.assertIsNone(result["remaining_percent"])
        self.assertEqual(result["status"], "unavailable")
        self.assertNotEqual(result["remaining_percent"], 0)

    def test_overflowing_usage_values_remain_unknown_instead_of_raising(self) -> None:
        transport = FakeTransport(
            [
                FakeResponse(
                    status=200,
                    body=json.dumps(
                        {"rate_limit": {"primary_window": {"used_percent": 10**1000}}}
                    ).encode("utf-8"),
                )
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertFalse(result["available"])
        self.assertIsNone(result["remaining_percent"])
        self.assertEqual(result["reason"], "quota-data-unavailable")

    def test_malformed_auth_file_remains_unavailable_instead_of_raising(self) -> None:
        self.auth_path.write_text("[]", encoding="utf-8")

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=FakeTransport([]))

        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "auth-file-invalid")

    def test_rate_limit_response_remains_unavailable(self) -> None:
        transport = FakeTransport(
            [FakeResponse(status=429, body=b"rate limited")]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertFalse(result["available"])
        self.assertIsNone(result["remaining_percent"])
        self.assertEqual(result["reason"], "rate-limited")

    def test_malformed_auth_refresh_response_remains_unavailable(self) -> None:
        transport = FakeTransport(
            [
                FakeResponse(status=401, body=b"unauthorized"),
                FakeResponse(status=200, body=b"not-json"),
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "auth-refresh-failed")

    def test_non_object_auth_refresh_response_remains_unavailable(self) -> None:
        transport = FakeTransport(
            [
                FakeResponse(status=401, body=b"unauthorized"),
                FakeResponse(status=200, body=b"[]"),
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "auth-refresh-failed")

    def test_expired_access_token_refreshes_once_and_retries_usage(self) -> None:
        payload = {
            "rate_limit": {
                "primary_window": {"used_percent": 10},
            }
        }
        transport = FakeTransport(
            [
                FakeResponse(status=401, body=b"unauthorized"),
                FakeResponse(
                    status=200,
                    body=json.dumps(
                        {
                            "access_token": "quota-test-token",
                            "refresh_token": "quota-refresh-token",
                        }
                    ).encode("utf-8"),
                ),
                FakeResponse(status=200, body=json.dumps(payload).encode("utf-8")),
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertTrue(result["available"])
        self.assertEqual(result["remaining_percent"], 90)
        self.assertEqual([item["method"] for item in transport.requests], ["GET", "POST", "GET"])
        self.assertEqual(
            transport.requests[2]["headers"]["Authorization"],
            "Bearer quota-test-token",
        )


class CodexQuotaRouteTests(unittest.TestCase):
    def test_route_returns_safe_quota_payload(self) -> None:
        payload = {
            "available": True,
            "status": "available",
            "remaining_percent": 82,
            "windows": [],
            "fetched_at": "2026-08-31T12:00:00+00:00",
        }
        with tempfile.TemporaryDirectory() as tmp:
            with patch(
                "codex_image.webui.routes.codex_quota.get_codex_quota",
                return_value=payload,
            ):
                from codex_image.webui.app import create_app

                app = create_app(output_root=Path(tmp), auto_start_queue=False)
                response = TestClient(app).get("/api/codex/quota")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), payload)


if __name__ == "__main__":
    unittest.main()
