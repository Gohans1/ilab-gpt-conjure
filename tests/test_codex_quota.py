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
            access_token="[REDACTED]",
            refresh_token="[REDACTED]",
            account_id="[REDACTED]",
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
            "rate_limit_reset_credits": {"available_count": 0},
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
        self.assertEqual(transport.requests[0]["headers"]["ChatGPT-Account-Id"], "[REDACTED]")
        self.assertNotIn("access_token", result)
        self.assertNotIn("refresh_token", result)
        rendered = json.dumps(result)
        self.assertNotIn("[REDACTED]", rendered)
        self.assertNotIn("[REDACTED]", rendered)

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

    def test_missing_weekly_window_is_returned_as_unknown(self) -> None:
        payload = {
            "rate_limit": {
                "primary_window": {"used_percent": 10},
            },
            "rate_limit_reset_credits": {"available_count": 0},
        }
        transport = FakeTransport(
            [FakeResponse(status=200, body=json.dumps(payload).encode("utf-8"))]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertTrue(result["available"])
        self.assertEqual(
            [item["label"] for item in result["windows"]],
            ["Session", "Weekly"],
        )
        self.assertIsNone(result["windows"][1]["remaining_percent"])
        self.assertEqual(result["remaining_percent"], 90)

    def test_out_of_range_usage_percentages_remain_unknown(self) -> None:
        payload = {
            "rate_limit": {
                "primary_window": {"used_percent": 150},
                "secondary_window": {"used_percent": 25},
            },
            "rate_limit_reset_credits": {"available_count": 0},
        }
        transport = FakeTransport(
            [FakeResponse(status=200, body=json.dumps(payload).encode("utf-8"))]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertTrue(result["available"])
        self.assertIsNone(result["windows"][0]["remaining_percent"])
        self.assertEqual(result["windows"][1]["remaining_percent"], 75)
        self.assertEqual(result["remaining_percent"], 75)

    def test_fractional_window_duration_uses_the_known_window_definition(self) -> None:
        payload = {
            "rate_limit": {
                "primary_window": {
                    "used_percent": 10,
                    "limit_window_seconds": 18_000.5,
                },
                "secondary_window": {"used_percent": 20},
            },
            "rate_limit_reset_credits": {"available_count": 0},
        }
        transport = FakeTransport([
            FakeResponse(status=200, body=json.dumps(payload).encode("utf-8"))
        ])

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertIsNone(result["windows"][0]["remaining_percent"])
        self.assertEqual(result["windows"][1]["remaining_percent"], 80)

    def test_fetches_banked_reset_count_and_safe_credit_dates(self) -> None:
        payload = {
            "rate_limit": {
                "primary_window": {"used_percent": 10},
            },
            "rate_limit_reset_credits": {"available_count": 2},
        }
        reset_payload = {
            "available_count": 2,
            "credits": [
                {
                    "credit_id": "[REDACTED]",
                    "status": "available",
                    "granted_at": "2026-06-17T00:00:00Z",
                    "expires_at": "2026-07-17T00:00:00Z",
                    "title": "Full reset",
                },
                {"status": "redeemed", "expires_at": "2099-01-01T00:00:00Z"},
            ],
        }
        transport = FakeTransport(
            [
                FakeResponse(status=200, body=json.dumps(payload).encode("utf-8")),
                FakeResponse(status=200, body=json.dumps(reset_payload).encode("utf-8")),
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertTrue(result["available"])
        self.assertEqual(result["banked_resets"], 2)
        self.assertEqual(
            result["banked_reset_credits"],
            [
                {
                    "granted_at": "2026-06-17T00:00:00+00:00",
                    "expires_at": "2026-07-17T00:00:00+00:00",
                    "status": "available",
                    "title": "Full reset",
                    "description": None,
                }
            ],
        )
        self.assertEqual(
            transport.requests[1]["url"],
            "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
        )
        rendered = json.dumps(result)
        self.assertNotIn("[REDACTED]", rendered)
        self.assertNotIn("[REDACTED]", rendered)
        self.assertNotIn("[REDACTED]", rendered)

    def test_reset_credit_failure_keeps_quota_and_inline_count(self) -> None:
        payload = {
            "rate_limit": {
                "primary_window": {"used_percent": 10},
            },
            "rate_limit_reset_credits": {"available_count": 1},
        }
        transport = FakeTransport(
            [
                FakeResponse(status=200, body=json.dumps(payload).encode("utf-8")),
                FakeResponse(status=429, body=b"rate limited"),
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertTrue(result["available"])
        self.assertEqual(result["remaining_percent"], 90)
        self.assertEqual(result["banked_resets"], 1)
        self.assertEqual(result["banked_reset_credits"], [])

    def test_reset_credit_transport_failure_keeps_quota_and_inline_count(self) -> None:
        payload = {
            "rate_limit": {
                "primary_window": {"used_percent": 10},
            },
            "rate_limit_reset_credits": {"available_count": 1},
        }
        transport = FakeTransport(
            [FakeResponse(status=200, body=json.dumps(payload).encode("utf-8"))]
        )

        from codex_image.codex_quota import fetch_codex_quota

        with patch(
            "codex_image.codex_quota._reset_credits_request",
            side_effect=RuntimeError("reset request failed"),
        ):
            result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertTrue(result["available"])
        self.assertEqual(result["banked_resets"], 1)
        self.assertEqual(result["banked_reset_credits"], [])

    def test_missing_banked_reset_data_remains_unknown(self) -> None:
        payload = {
            "rate_limit": {"primary_window": {"used_percent": 10}},
            "rate_limit_reset_credits": {},
        }
        transport = FakeTransport(
            [
                FakeResponse(status=200, body=json.dumps(payload).encode("utf-8")),
                FakeResponse(status=500, body=b"unavailable"),
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertTrue(result["available"])
        self.assertIsNone(result["banked_resets"])
        self.assertEqual(result["banked_reset_credits"], [])

    def test_missing_inline_reset_object_uses_reset_credit_endpoint(self) -> None:
        payload = {
            "rate_limit": {"primary_window": {"used_percent": 10}},
        }
        reset_payload = {"available_count": 2, "credits": []}
        transport = FakeTransport(
            [
                FakeResponse(status=200, body=json.dumps(payload).encode("utf-8")),
                FakeResponse(status=200, body=json.dumps(reset_payload).encode("utf-8")),
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertTrue(result["available"])
        self.assertEqual(result["banked_resets"], 2)
        self.assertEqual(len(transport.requests), 2)

    def test_malformed_inline_reset_object_uses_reset_credit_endpoint(self) -> None:
        payload = {
            "rate_limit": {
                "primary_window": {"used_percent": 10},
            },
            "rate_limit_reset_credits": [],
        }
        reset_payload = {"available_count": 3}
        transport = FakeTransport(
            [
                FakeResponse(status=200, body=json.dumps(payload).encode("utf-8")),
                FakeResponse(status=200, body=json.dumps(reset_payload).encode("utf-8")),
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertEqual(result["banked_resets"], 3)
        self.assertEqual(len(transport.requests), 2)

    def test_malformed_reset_count_remains_unknown(self) -> None:
        payload = {
            "rate_limit": {"primary_window": {"used_percent": 10}},
            "rate_limit_reset_credits": {"available_count": 2.5},
        }
        transport = FakeTransport(
            [
                FakeResponse(status=200, body=json.dumps(payload).encode("utf-8")),
                FakeResponse(status=500, body=b"unavailable"),
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertTrue(result["available"])
        self.assertIsNone(result["banked_resets"])

    def test_overflowing_reset_count_remains_unknown(self) -> None:
        payload = {
            "rate_limit": {
                "primary_window": {"used_percent": 10},
            },
            "rate_limit_reset_credits": {"available_count": 10**30},
        }
        reset_payload = {"available_count": 10**30}
        transport = FakeTransport(
            [
                FakeResponse(status=200, body=json.dumps(payload).encode("utf-8")),
                FakeResponse(status=200, body=json.dumps(reset_payload).encode("utf-8")),
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertIsNone(result["banked_resets"])

    def test_reset_credit_without_available_status_is_not_rendered(self) -> None:
        payload = {
            "rate_limit": {"primary_window": {"used_percent": 10}},
            "rate_limit_reset_credits": {"available_count": 1},
        }
        reset_payload = {"available_count": 1, "credits": [{}]}
        transport = FakeTransport(
            [
                FakeResponse(status=200, body=json.dumps(payload).encode("utf-8")),
                FakeResponse(status=200, body=json.dumps(reset_payload).encode("utf-8")),
            ]
        )

        from codex_image.codex_quota import fetch_codex_quota

        result = fetch_codex_quota(auth_path=self.auth_path, transport=transport)

        self.assertTrue(result["available"])
        self.assertEqual(result["banked_reset_credits"], [])

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
            },
            "rate_limit_reset_credits": {"available_count": 0},
        }
        transport = FakeTransport(
            [
                FakeResponse(status=401, body=b"unauthorized"),
                FakeResponse(
                    status=200,
                    body=json.dumps(
                        {
                            "access_token": "[REDACTED]",
                            "refresh_token": "[REDACTED]",
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
            "Bearer [REDACTED]",
        )

    def test_quota_cache_does_not_cross_auth_identity(self) -> None:
        import codex_image.codex_quota as quota

        results = [
            {"available": True, "remaining_percent": 90},
            {"available": True, "remaining_percent": 70},
        ]
        with (
            patch.object(quota, "_cached_result", None),
            patch.object(quota, "_cached_at", 0.0),
            patch.object(quota, "_cached_key", None),
            patch.object(
                quota,
                "_auth_cache_key",
                side_effect=["account-a", "account-a", "account-b", "account-b"],
            ),
            patch.object(quota, "fetch_codex_quota", side_effect=results) as fetch,
        ):
            first = quota.get_codex_quota()
            second = quota.get_codex_quota()

        self.assertEqual(first["remaining_percent"], 90)
        self.assertEqual(second["remaining_percent"], 70)
        self.assertEqual(fetch.call_count, 2)


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
