from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


class WebUILauncherTests(unittest.TestCase):
    @staticmethod
    def _unused_local_port() -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            return int(sock.getsockname()[1])

    def test_webui_app_is_lazy_and_launchers_never_request_multiple_workers(self) -> None:
        app_module = Path("codex_image/webui/app.py").read_text(encoding="utf-8")
        self.assertIn("def __getattr__(name: str)", app_module)
        self.assertNotIn("\napp = create_app()", app_module)

        launchers = (
            Path("Start WebUI.command"),
            Path("Start WebUI Debug.command"),
            Path("Start WebUI.bat"),
            Path("packaging/macos/Start WebUI Portable.command"),
            Path("packaging/windows/Start WebUI Portable.bat"),
        )
        for launcher in launchers:
            text = launcher.read_text(encoding="utf-8")
            self.assertNotIn("--workers", text)
            self.assertNotIn("WEB_CONCURRENCY", text)

        for app_module in (
            Path("packaging/macos/portable_webui_app.py"),
            Path("packaging/macos/standard_webui_app.py"),
            Path("packaging/windows/portable_webui_app.py"),
            Path("packaging/windows/standard_webui_app.py"),
        ):
            self.assertIn(
                "enforce_single_instance=True",
                app_module.read_text(encoding="utf-8"),
            )

    def test_launcher_starts_shutdown_aware_server_on_localhost(self) -> None:
        launcher = Path("Start WebUI.command")
        text = launcher.read_text(encoding="utf-8")

        self.assertIn("-m codex_image.webui.server", text)
        self.assertIn("codex_image.webui.app:app", text)
        self.assertIn("--host 127.0.0.1", text)
        self.assertIn("--port 8787", text)
        self.assertIn("--no-access-log", text)

    def test_launcher_uses_project_venv(self) -> None:
        launcher = Path("Start WebUI.command")
        text = launcher.read_text(encoding="utf-8")

        self.assertIn(".venv", text)
        self.assertIn("requirements-webui.txt", text)

    def test_macos_launchers_wait_for_health_before_opening_browser(self) -> None:
        for launcher in (Path("Start WebUI.command"), Path("Start WebUI Debug.command")):
            text = launcher.read_text(encoding="utf-8")

            self.assertIn('HEALTH_URL="${URL}api/health"', text)
            self.assertIn("webui_is_ready()", text)
            self.assertIn("wait_for_webui()", text)
            self.assertIn("if webui_is_ready; then", text)
            self.assertIn("open_when_ready()", text)
            self.assertIn("open_when_ready &", text)
            self.assertIn("--timeout-graceful-shutdown 5", text)
            self.assertIn('> >(tee -a "$LOG_FILE") 2>&1', text)
            self.assertNotIn('| tee -a "$LOG_FILE"', text)
            self.assertNotIn('SERVER_PID="$!"', text)
            self.assertFalse(
                any(
                    "codex_image.webui.server" in line
                    and line.rstrip().endswith("&")
                    for line in text.splitlines()
                )
            )
            self.assertNotIn(
                'open "$URL" >/dev/null 2>&1 || true\n'
                '"$PYTHON_BIN" -m codex_image.webui.server',
                text,
            )

    def test_windows_launcher_waits_for_health_before_opening_browser(self) -> None:
        text = Path("Start WebUI.bat").read_text(encoding="utf-8")

        self.assertIn('set "HEALTH_URL=%URL%api/health"', text)
        self.assertIn("-m codex_image.webui.open_when_ready", text)
        self.assertIn("--timeout-graceful-shutdown 5", text)
        self.assertIn(
            '"%PYTHON_BIN%" -m codex_image.webui.server '
            "codex_image.webui.app:app",
            text,
        )
        self.assertNotIn(
            'start "iLab CONJURE WebUI" /b "%PYTHON_BIN%" '
            "-m codex_image.webui.server",
            text,
        )
        self.assertNotIn(":keep_server_window_open", text)
        self.assertNotIn(
            'start "" "%URL%"\n'
            '"%PYTHON_BIN%" -m codex_image.webui.server',
            text,
        )

    def test_packaged_launchers_bound_graceful_shutdown_and_do_not_orphan_uvicorn(self) -> None:
        mac_portable = Path("packaging/macos/Start WebUI Portable.command").read_text(
            encoding="utf-8"
        )
        windows_portable = Path(
            "packaging/windows/Start WebUI Portable.bat"
        ).read_text(encoding="utf-8")
        rust_launcher = Path("launcher/src/lib.rs").read_text(encoding="utf-8")

        self.assertIn("--timeout-graceful-shutdown 5", mac_portable)
        self.assertIn(
            'exec "$PYTHON_BIN" -m codex_image.webui.server',
            mac_portable,
        )
        self.assertNotIn('SERVER_PID="$!"', mac_portable)

        self.assertIn("-m codex_image.webui.open_when_ready", windows_portable)
        self.assertIn("--timeout-graceful-shutdown 5", windows_portable)
        self.assertIn(
            '"%PYTHON_BIN%" -m codex_image.webui.server '
            "portable_webui_app:app",
            windows_portable,
        )
        self.assertNotIn(
            'start "iLab CONJURE WebUI" /b "%PYTHON_BIN%" '
            "-m codex_image.webui.server",
            windows_portable,
        )
        self.assertNotIn(":keep_server_window_open", windows_portable)

        self.assertIn('"codex_image.webui.server"', rust_launcher)
        self.assertIn('"--timeout-graceful-shutdown"', rust_launcher)
        self.assertIn('"5"', rust_launcher)

    def _run_server_sigint_case(self, *, repeated: bool) -> tuple[int, str]:
        project_root = Path.cwd()
        port = self._unused_local_port()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture_module = root / "shutdown_fixture.py"
            fixture_module.write_text(
                "\n".join(
                    (
                        "import os",
                        "from pathlib import Path",
                        "from codex_image.webui.app import create_app",
                        "app = create_app(",
                        "    output_root=Path(os.environ['WEBUI_SHUTDOWN_TEST_ROOT']),",
                        "    auth_checker=lambda: True,",
                        "    auto_start_queue=False,",
                        ")",
                    )
                ),
                encoding="utf-8",
            )
            env = dict(os.environ)
            env["WEBUI_SHUTDOWN_TEST_ROOT"] = str(root / "data")
            env["PYTHONPATH"] = os.pathsep.join(
                (str(root), str(project_root), env.get("PYTHONPATH", ""))
            )
            process = subprocess.Popen(
                (
                    sys.executable,
                    "-m",
                    "codex_image.webui.server",
                    "shutdown_fixture:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--no-access-log",
                    "--timeout-graceful-shutdown",
                    "5",
                ),
                cwd=project_root,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            output = ""
            stream = None
            try:
                health_url = f"http://127.0.0.1:{port}/api/health"
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        break
                    try:
                        with urlopen(health_url, timeout=0.25) as response:
                            if response.status == 200:
                                break
                    except (OSError, URLError):
                        time.sleep(0.05)
                else:
                    self.fail("WebUI server did not become healthy")
                if process.poll() is not None:
                    output = process.communicate(timeout=1)[0]
                    self.fail(f"WebUI server exited before becoming healthy:\n{output}")

                stream = urlopen(
                    f"http://127.0.0.1:{port}/api/events?stream=1",
                    timeout=2,
                )
                self.assertTrue(stream.readline().startswith(b"data: "))
                process.send_signal(signal.SIGINT)
                if repeated:
                    time.sleep(0.02)
                    if process.poll() is None:
                        process.send_signal(signal.SIGINT)
                try:
                    output = process.communicate(timeout=2)[0]
                except subprocess.TimeoutExpired:
                    process.send_signal(signal.SIGINT)
                    output = process.communicate(timeout=3)[0]
                    self.fail(
                        "The first Ctrl+C did not close the active event stream.\n"
                        + output
                    )
            finally:
                if stream is not None:
                    stream.close()
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.communicate(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate(timeout=3)

        return int(process.returncode), output

    def _assert_clean_sigint_shutdown(self, *, repeated: bool) -> None:
        returncode, output = self._run_server_sigint_case(repeated=repeated)
        self.assertEqual(returncode, 0, output)
        self.assertNotIn("Traceback", output)
        self.assertNotIn("CancelledError", output)
        self.assertNotIn("Exception in ASGI application", output)

    @unittest.skipUnless(os.name == "posix", "SIGINT integration test requires POSIX")
    def test_server_closes_event_stream_on_first_sigint_without_traceback(self) -> None:
        self._assert_clean_sigint_shutdown(repeated=False)

    @unittest.skipUnless(os.name == "posix", "SIGINT integration test requires POSIX")
    def test_server_coalesces_repeated_sigint_without_traceback(self) -> None:
        self._assert_clean_sigint_shutdown(repeated=True)
