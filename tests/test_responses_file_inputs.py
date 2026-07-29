from __future__ import annotations

import base64
import inspect
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from codex_image.client import ResponsesInputFile, ResponsesRequestError
from codex_image.codex_responses_client import CodexImageClient
from codex_image.openai_responses_client import OpenAIResponsesImageClient
from tests.helpers import (
    FakeResponse,
    FakeTransport,
    TEST_PNG_BASE64,
    make_sse_completed_event,
)


class ResponsesFilePayloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pdf = ResponsesInputFile(
            filename="brief.pdf",
            mime_type="application/pdf",
            file_data="data:application/pdf;base64,JVBERg==",
            detail="auto",
        )
        self.markdown = ResponsesInputFile(
            filename="notes.md",
            mime_type="text/markdown",
            file_data="data:text/markdown;base64,IyBOb3Rlcw==",
        )

    def test_codex_payload_appends_files_after_images(self) -> None:
        client = object.__new__(CodexImageClient)
        payload = client.build_payload(
            prompt="Use the references",
            input_images=["data:image/png;base64,aW1hZ2U="],
            input_files=[self.pdf, self.markdown],
        )
        content = payload["input"][0]["content"]
        self.assertEqual([part["type"] for part in content], ["input_text", "input_image", "input_file", "input_file"])
        self.assertEqual(content[2]["detail"], "auto")
        self.assertNotIn("detail", content[3])

    def test_openai_payload_uses_same_file_shape(self) -> None:
        client = object.__new__(OpenAIResponsesImageClient)
        client.image_model = "gpt-image-2"
        payload = client.build_payload(prompt="Use the file", input_files=[self.pdf])
        self.assertEqual(payload["input"][0]["content"][-1], self.pdf.to_content_part())

    def test_request_error_string_never_contains_raw_file_data(self) -> None:
        error = ResponsesRequestError(
            "OpenAI-compatible responses request failed: HTTP 400: invalid input_file",
            status=400,
            body='{"error":{"message":"bad data:text/markdown;base64,U0VDUkVU"}}',
        )
        self.assertNotIn("U0VDUkVU", str(error))
        self.assertIn("U0VDUkVU", error.body)

    def test_request_error_sanitizes_accidentally_embedded_raw_body(self) -> None:
        body = '{"error":{"file_data":"data:text/plain;base64,U0VDUkVU"}}'
        error = ResponsesRequestError(f"Responses request failed: {body}", status=400, body=body)

        self.assertNotIn(body, str(error))
        self.assertNotIn("U0VDUkVU", str(error))
        self.assertEqual(error.body, body)

    def test_public_responses_methods_accept_reference_files_but_direct_images_do_not(self) -> None:
        from codex_image.client import CodexImagesImageClient, OpenAIImagesImageClient

        for client_type in (CodexImageClient, OpenAIResponsesImageClient):
            self.assertIn("reference_files", inspect.signature(client_type.generate_image).parameters)
            self.assertIn("reference_files", inspect.signature(client_type.edit_image).parameters)
        for client_type in (CodexImagesImageClient, OpenAIImagesImageClient):
            self.assertNotIn("reference_files", inspect.signature(client_type.generate_image).parameters)
            self.assertNotIn("reference_files", inspect.signature(client_type.edit_image).parameters)

    def test_openai_generate_threads_files_without_switching_image_action(self) -> None:
        transport = FakeTransport(
            [
                FakeResponse(
                    status=200,
                    body=make_sse_completed_event(image_b64=TEST_PNG_BASE64),
                    headers={"Content-Type": "text/event-stream"},
                )
            ]
        )
        client = OpenAIResponsesImageClient(
            api_key="test-key",
            base_url="https://api.example.com/v1",
            image_model="gpt-image-2",
            transport=transport,
        )

        client.generate_image(prompt="Use the file", reference_files=[self.pdf])

        payload = json.loads(transport.requests[0]["body"].decode("utf-8"))
        self.assertEqual(payload["tools"][0]["action"], "generate")
        self.assertEqual(payload["input"][0]["content"][-1], self.pdf.to_content_part())

    def test_edit_methods_thread_files_after_images(self) -> None:
        from codex_image.auth import AuthState

        clients = [
            CodexImageClient(
                AuthState(
                    path=Path("/tmp/auth.json"),
                    access_token="token",
                    refresh_token=None,
                    id_token="header.payload.sig",
                    account_id="acct",
                    last_refresh=None,
                    raw={},
                ),
                transport=FakeTransport(
                    [FakeResponse(status=200, body=make_sse_completed_event(image_b64=TEST_PNG_BASE64), headers={})]
                ),
            ),
            OpenAIResponsesImageClient(
                api_key="test-key",
                base_url="https://api.example.com/v1",
                image_model="gpt-image-2",
                transport=FakeTransport(
                    [FakeResponse(status=200, body=make_sse_completed_event(image_b64=TEST_PNG_BASE64), headers={})]
                ),
            ),
        ]

        for client in clients:
            with self.subTest(client=type(client).__name__):
                client.edit_image(
                    prompt="Edit from references",
                    images=["data:image/png;base64,aW1hZ2U="],
                    reference_files=[self.markdown],
                )
                payload = json.loads(client.transport.requests[0]["body"].decode("utf-8"))
                self.assertEqual(
                    [part["type"] for part in payload["input"][0]["content"]],
                    ["input_text", "input_image", "input_file"],
                )


class ResponsesTypedErrorTests(unittest.TestCase):
    def _clients_for_http_error(self, body: str) -> list[object]:
        from codex_image.auth import AuthState

        return [
            CodexImageClient(
                AuthState(
                    path=Path("/tmp/auth.json"),
                    access_token="token",
                    refresh_token=None,
                    id_token="header.payload.sig",
                    account_id="acct",
                    last_refresh=None,
                    raw={},
                ),
                transport=FakeTransport([FakeResponse(status=400, body=body.encode("utf-8"), headers={})]),
            ),
            OpenAIResponsesImageClient(
                api_key="test-key",
                base_url="https://api.example.com/v1",
                image_model="gpt-image-2",
                transport=FakeTransport([FakeResponse(status=400, body=body.encode("utf-8"), headers={})]),
            ),
        ]

    def test_non_2xx_errors_are_typed_sanitized_and_limited(self) -> None:
        secret = "U0VDUkVULUZJTEU="
        body = json.dumps(
            {
                "error": {
                    "code": "invalid_file",
                    "message": [
                        "invalid input_file",
                        {"file_data": f"data:text/markdown;base64,{secret}"},
                        "x" * 4_000,
                    ],
                }
            }
        )
        for client in self._clients_for_http_error(body):
            with self.subTest(client=type(client).__name__):
                with self.assertRaises(ResponsesRequestError) as raised:
                    client.generate_image(prompt="Use references")
                error = raised.exception
                self.assertEqual(error.status, 400)
                self.assertEqual(error.body, body)
                self.assertIn("invalid_file", str(error))
                self.assertNotIn(secret, str(error))
                self.assertNotIn(secret, repr(error))
                self.assertLessEqual(len(str(error)), 2_000)

    def test_message_only_outbound_plaintext_and_base64_echoes_are_redacted(self) -> None:
        plaintext = "PRIVATE-DOCUMENT-TEXT"
        encoded = base64.b64encode(plaintext.encode("utf-8")).decode("ascii")
        reference = ResponsesInputFile(
            filename="private.md",
            mime_type="text/markdown",
            file_data=f"data:text/markdown;base64,{encoded}",
        )
        for echoed in (plaintext, encoded):
            body = json.dumps({"error": {"message": f"provider rejected {echoed}"}})
            for client in self._clients_for_http_error(body):
                with self.subTest(client=type(client).__name__, echoed=echoed):
                    with self.assertRaises(ResponsesRequestError) as caught:
                        client.generate_image(prompt="Use file", reference_files=[reference])
                    self.assertNotIn(plaintext, str(caught.exception))
                    self.assertNotIn(encoded, str(caught.exception))

    def test_non_2xx_error_redacts_file_data_echoes_and_keeps_provider_message_readable(self) -> None:
        private_text = "PRIVATE NOTES FOR REDACTION TEST"
        short_base64 = base64.b64encode(private_text.encode("utf-8")).decode("ascii")
        body = json.dumps(
            {
                "file_data": private_text,
                "encoded_file": {"file_data": f"data:text/plain;base64,{short_base64}"},
                "error": {
                    "code": "invalid_file",
                    "message": f"could not parse input: {private_text}; encoded={short_base64}",
                },
            }
        )

        for client in self._clients_for_http_error(body):
            with self.subTest(client=type(client).__name__):
                with self.assertRaises(ResponsesRequestError) as raised:
                    client.generate_image(prompt="Use references")
                message = str(raised.exception)
                self.assertIn("could not parse input", message)
                self.assertNotIn(private_text, message)
                self.assertNotIn(short_base64, message)
                self.assertNotIn(private_text, repr(raised.exception))
                self.assertNotIn(short_base64, repr(raised.exception))

    def test_request_error_constructor_uses_body_file_data_for_final_redaction(self) -> None:
        private_text = "PRIVATE CONSTRUCTOR NOTES"
        short_base64 = base64.b64encode(private_text.encode("utf-8")).decode("ascii")
        body = json.dumps({"file_data": f"data:text/plain;base64,{short_base64}"})

        error = ResponsesRequestError(
            f"Provider rejected file: {private_text}; encoded={short_base64}",
            status=400,
            body=body,
        )

        self.assertIn("Provider rejected file", str(error))
        self.assertNotIn(private_text, str(error))
        self.assertNotIn(short_base64, str(error))
        self.assertNotIn(private_text, repr(error))
        self.assertNotIn(short_base64, repr(error))

    def test_sse_terminal_errors_are_typed_and_keep_raw_event_only_in_body(self) -> None:
        secret = "U0VDUkVULVNTRQ=="
        events = [
            {"type": "error", "error": {"code": "bad_file", "message": f"bad data:text/plain;base64,{secret}"}},
            {
                "type": "response.failed",
                "error": None,
                "response": {
                    "status": "failed",
                    "error": {"code": "bad_file", "message": f"bad data:text/plain;base64,{secret}"},
                },
            },
            {
                "type": "response.incomplete",
                "response": {
                    "status": "incomplete",
                    "error": {"code": "bad_file", "message": f"bad data:text/plain;base64,{secret}"},
                },
            },
        ]
        for client_type in (CodexImageClient, OpenAIResponsesImageClient):
            for event in events:
                with self.subTest(client=client_type.__name__, event=event["type"]):
                    raw_event = json.dumps(event, separators=(",", ":"))
                    body = f"data: {raw_event}\n\n".encode("utf-8")
                    client = object.__new__(client_type)
                    with self.assertRaises(ResponsesRequestError) as raised:
                        client.parse_sse_response(body)
                    error = raised.exception
                    self.assertEqual(error.status, 200)
                    self.assertEqual(error.body, raw_event)
                    self.assertIn(secret, error.body)
                    self.assertIn("bad_file", str(error))
                    self.assertNotIn(secret, str(error))
                    self.assertNotIn(secret, repr(error))

    def test_sse_debug_output_redacts_file_data_before_typed_error(self) -> None:
        secret = "U0VDUkVULURFQlVH"
        event = {
            "type": "error",
            "error": {
                "code": "bad_file",
                "message": "invalid input_file",
                "file_data": f"data:application/pdf;base64,{secret}",
                "result": "A" * 600,
            },
        }
        body = f"data: {json.dumps(event)}\n\n".encode("utf-8")
        client = object.__new__(CodexImageClient)
        with tempfile.TemporaryDirectory() as temp_dir:
            debug_path = Path(temp_dir) / "events.jsonl"
            with self.assertRaises(ResponsesRequestError):
                client.parse_sse_response(body, debug_sse_path=debug_path)
            debug_text = debug_path.read_text(encoding="utf-8")
        self.assertNotIn(secret, debug_text)
        self.assertNotIn("data:application/pdf;base64", debug_text)
        self.assertNotIn("A" * 600, debug_text)

    def test_sse_error_redacts_sibling_file_echoes_from_exception_and_debug(self) -> None:
        private_text = "PRIVATE SSE NOTES"
        short_base64 = base64.b64encode(private_text.encode("utf-8")).decode("ascii")
        event = {
            "type": "error",
            "file_data": private_text,
            "encoded_file": {"file_data": f"data:text/plain;base64,{short_base64}"},
            "error": {
                "code": "bad_file",
                "message": f"could not parse input: {private_text}; encoded={short_base64}",
            },
        }
        body = f"data: {json.dumps(event)}\n\n".encode("utf-8")
        client = object.__new__(CodexImageClient)
        with tempfile.TemporaryDirectory() as temp_dir:
            debug_path = Path(temp_dir) / "events.jsonl"
            with self.assertRaises(ResponsesRequestError) as raised:
                client.parse_sse_response(body, debug_sse_path=debug_path)
            debug_text = debug_path.read_text(encoding="utf-8")

        self.assertIn("could not parse input", str(raised.exception))
        for rendered in (str(raised.exception), repr(raised.exception), debug_text):
            self.assertNotIn(private_text, rendered)
            self.assertNotIn(short_base64, rendered)
        self.assertIn("could not parse input", debug_text)

    def test_message_only_sse_echo_uses_outbound_context_for_debug_and_exception(self) -> None:
        private_text = "PRIVATE OUTBOUND SSE TEXT"
        encoded = base64.b64encode(private_text.encode()).decode()
        sensitive_values = {f"data:text/plain;base64,{encoded}", encoded, private_text}
        event = {
            "type": "error",
            "error": {"code": "bad_file", "message": f"provider echoed {private_text} ({encoded})"},
        }
        body = f"data: {json.dumps(event)}\n\n".encode()
        with mock.patch.dict("os.environ", {"CODEX_IMAGE_DEBUG_SSE": "1"}), tempfile.TemporaryDirectory() as temp_dir:
            for client_type in (CodexImageClient, OpenAIResponsesImageClient):
                with self.subTest(client=client_type.__name__):
                    client = object.__new__(client_type)
                    debug_path = Path(temp_dir) / f"{client_type.__name__}.jsonl"
                    with self.assertRaises(ResponsesRequestError) as raised:
                        client.parse_sse_response(
                            body,
                            debug_sse_path=debug_path,
                            sensitive_values=sensitive_values,
                        )
                    debug_text = debug_path.read_text(encoding="utf-8")
                    for rendered in (str(raised.exception), repr(raised.exception), debug_text):
                        self.assertNotIn(private_text, rendered)
                        self.assertNotIn(encoded, rendered)
                    self.assertIn("bad_file", str(raised.exception))

    def test_completed_without_image_redacts_outbound_echo_but_keeps_diagnostic(self) -> None:
        private_text = "PRIVATE COMPLETED OUTPUT TEXT"
        encoded = base64.b64encode(private_text.encode()).decode()
        event = {
            "type": "response.completed",
            "response": {
                "output": [{"type": "message", "content": [{"type": "output_text", "text": f"cannot use {private_text} {encoded}"}]}],
            },
        }
        body = f"data: {json.dumps(event)}\n\n".encode()
        client = object.__new__(CodexImageClient)
        with self.assertRaises(RuntimeError) as raised:
            client.parse_sse_response(
                body,
                sensitive_values={f"data:text/plain;base64,{encoded}", encoded, private_text},
            )
        self.assertIn("Codex image generation failed", str(raised.exception))
        self.assertNotIn(private_text, str(raised.exception))
        self.assertNotIn(encoded, str(raised.exception))

    def test_short_plaintext_redaction_does_not_corrupt_provider_diagnostics(self) -> None:
        encoded = base64.b64encode(b"x").decode()
        error = ResponsesRequestError(
            "context_length_exceeded: extra metadata; echoed x",
            status=400,
            body='{"error":{"code":"context_length_exceeded","message":"extra metadata; echoed x"}}',
            sensitive_values={f"data:text/plain;base64,{encoded}", encoded, "x"},
        )
        message = str(error)
        self.assertIn("context_length_exceeded", message)
        self.assertIn("extra metadata", message)
        self.assertNotIn("echoed x", message)
