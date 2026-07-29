from __future__ import annotations

import errno
import os
from pathlib import Path
from typing import BinaryIO


class WebUIAlreadyRunningError(RuntimeError):
    def __init__(self) -> None:
        super().__init__(
            "Another iLab CONJURE instance is already using this data directory. "
            "Close the existing app and try again."
        )


class WebUIWorkerConfigurationError(RuntimeError):
    pass


def validate_single_worker_environment() -> None:
    configured = os.getenv("WEB_CONCURRENCY", "").strip()
    if configured and configured != "1":
        raise WebUIWorkerConfigurationError(
            "iLab CONJURE requires a single WebUI worker. "
            "Unset WEB_CONCURRENCY or set it to 1."
        )


class WebUIInstanceLock:
    def __init__(self, handle: BinaryIO) -> None:
        self._handle = handle
        self._released = False

    @classmethod
    def acquire(cls, source_data_root: Path) -> "WebUIInstanceLock":
        root = Path(source_data_root)
        root.mkdir(parents=True, exist_ok=True)
        lock_path = root / ".webui-instance.lock"
        handle = lock_path.open("a+b")
        try:
            if os.name == "nt":
                cls._acquire_windows(handle)
            else:
                cls._acquire_posix(handle)
            try:
                os.chmod(lock_path, 0o600)
            except OSError:
                pass
        except BaseException:
            handle.close()
            raise
        return cls(handle)

    @staticmethod
    def _acquire_posix(handle: BinaryIO) -> None:
        import fcntl

        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in {errno.EACCES, errno.EAGAIN}:
                raise WebUIAlreadyRunningError() from exc
            raise

    @staticmethod
    def _acquire_windows(handle: BinaryIO) -> None:
        import msvcrt

        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
            os.fsync(handle.fileno())
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                raise WebUIAlreadyRunningError() from exc
            raise

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        try:
            if os.name == "nt":
                import msvcrt

                self._handle.seek(0)
                msvcrt.locking(self._handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        finally:
            self._handle.close()

    def __enter__(self) -> "WebUIInstanceLock":
        return self

    def __exit__(self, *_args: object) -> None:
        self.release()
