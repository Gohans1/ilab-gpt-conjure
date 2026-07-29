from __future__ import annotations

import asyncio
import threading


class ShutdownCoordinator:
    def __init__(self) -> None:
        self._requested = threading.Event()
        self._lock = threading.Lock()
        self._waiters: set[tuple[asyncio.AbstractEventLoop, asyncio.Event]] = set()

    def request_shutdown(self) -> None:
        self._requested.set()
        with self._lock:
            waiters = tuple(self._waiters)
        for loop, event in waiters:
            if loop.is_closed():
                continue
            loop.call_soon_threadsafe(event.set)

    def is_shutdown_requested(self) -> bool:
        return self._requested.is_set()

    async def wait(self, timeout: float) -> bool:
        if self._requested.is_set():
            return True
        loop = asyncio.get_running_loop()
        event = asyncio.Event()
        waiter = (loop, event)
        with self._lock:
            self._waiters.add(waiter)
        try:
            if self._requested.is_set():
                event.set()
            try:
                await asyncio.wait_for(event.wait(), timeout=max(0.0, timeout))
            except TimeoutError:
                return False
            return True
        finally:
            with self._lock:
                self._waiters.discard(waiter)
