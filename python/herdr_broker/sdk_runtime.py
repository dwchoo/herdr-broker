"""The version-specific seam around the pinned Codex SDK and its owned child."""
from __future__ import annotations

import asyncio
import subprocess
from collections.abc import Callable
from pathlib import Path

from openai_codex import AsyncCodex
from openai_codex.generated.v2_all import ThreadLoadedListResponse, ThreadUnsubscribeResponse


class SDKRuntime:
    def __init__(self, client: AsyncCodex, directory: str, on_fault: Callable[[], None]):
        self.client = client
        self.directory = Path(directory)
        self.on_fault = on_fault
        self.process: subprocess.Popen[str] | None = None
        self.notifications: asyncio.Task[None] | None = None
        self.spawning: asyncio.Task[None] | None = None
        self.closing = False
        self.drained = 0

    def _spawn_owned(self) -> None:
        # Cancellation of to_thread cannot stop Popen. This thread retains ownership
        # and closes even a child that appears after asynchronous cleanup timed out.
        sync = self.client._client._sync
        try:
            sync.start()
        finally:
            self.process = sync._proc
            if self.closing:
                sync.close()
                if self.process is not None:
                    self.process.wait(timeout=2)

    async def start(self) -> None:
        self.spawning = asyncio.create_task(asyncio.to_thread(self._spawn_owned))
        await asyncio.shield(self.spawning)
        if self.closing:
            raise RuntimeError("SDK closed while spawning")
        await self.client.__aenter__()
        self.notifications = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        try:
            while True:
                await self.client._client.next_notification()
                self.drained += 1
        except Exception:
            if not self.closing:
                self.on_fault()

    async def loaded_count(self, limit: int) -> int:
        count, cursor = 0, None
        while True:
            response = await self.client._client.request(
                "thread/loaded/list", {"limit": limit, "cursor": cursor},
                response_model=ThreadLoadedListResponse,
            )
            count += len(response.data)
            cursor = response.next_cursor
            if count >= limit or not cursor:
                return count

    async def unsubscribe(self, thread_id: str) -> None:
        await self.client._client.request(
            "thread/unsubscribe", {"threadId": thread_id}, response_model=ThreadUnsubscribeResponse,
        )

    async def close(self) -> None:
        self.closing = True
        if self.spawning is not None:
            try:
                await asyncio.shield(self.spawning)
            except Exception:
                pass  # A partial spawn still owns a child that must be closed below.
        await self.client.close()
        if self.process is not None:
            # The SDK's kill path does not wait; verify/reap this exact owned child.
            await asyncio.to_thread(self.process.wait, timeout=2)
        if self.notifications is not None:
            await self.notifications

    def resources(self) -> dict[str, int | None]:
        rss: int | None = None
        size: int | None = None
        if self.process is not None and self.process.poll() is None:
            try:
                rss = int(subprocess.check_output(
                    ["/bin/ps", "-o", "rss=", "-p", str(self.process.pid)], timeout=2,
                    stderr=subprocess.DEVNULL,
                ).strip()) * 1024
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        try:
            size = sum(p.stat().st_size for p in self.directory.rglob("*") if p.is_file())
        except OSError:
            pass
        return {"rss_bytes": rss, "temporary_bytes": size}
