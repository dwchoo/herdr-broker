"""The version-specific seam around the pinned Codex SDK and its owned child."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
from collections.abc import Callable
from pathlib import Path

from openai_codex import AsyncCodex
from openai_codex.generated.v2_all import ThreadLoadedListResponse, ThreadUnsubscribeResponse

from .herdr import BrokerError
from .options import Effort, ServiceTier


def analysis_profile(directory: str, model: str | tuple[str, ...]) -> tuple[Path, Path]:
    """Scope SDK settings to this Worker; reference file auth without reading it."""
    source = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))).expanduser().resolve()
    auth = source / "auth.json"
    if not auth.is_file():
        raise BrokerError("worker_auth_unavailable")
    try:
        cache = source / "models_cache.json"
        if cache.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("model cache too large")
        models = json.loads(cache.read_text())["models"]
        selected = dict.fromkeys((model,) if isinstance(model, str) else model)
        restricted = []
        for slug in selected:
            matches = [item for item in models if isinstance(item, dict) and item.get("slug") == slug]
            if len(matches) != 1:
                raise ValueError("model unavailable")
            metadata = matches[0]
            # Preserve model limits, supported tiers and security metadata. Only disable tools.
            metadata.update(tool_mode="direct", apply_patch_tool_type=None,
                            supports_search_tool=False, multi_agent_version=None,
                            experimental_supported_tools=[])
            restricted.append(metadata)
    except (OSError, ValueError, TypeError, KeyError):
        raise BrokerError("worker_model_catalog_unavailable") from None
    profile = Path(directory) / "profile"
    profile.mkdir(mode=0o700)
    (profile / "auth.json").symlink_to(auth)
    catalog = profile / "models.json"
    catalog.write_text(json.dumps({"models": restricted}))
    return profile, catalog


def validate_model(metadata: dict[str, object], effort: Effort, tier: ServiceTier) -> None:
    levels = metadata.get("supported_reasoning_levels")
    if not isinstance(levels, list):
        raise BrokerError("worker_model_catalog_unavailable")
    if not any(isinstance(x, dict) and x.get("effort") == effort for x in levels):
        raise BrokerError("worker_effort_unsupported")
    tiers = metadata.get("service_tiers")
    if tier == "fast" and (not isinstance(tiers, list) or not any(
        isinstance(x, dict) and x.get("id") == "priority" for x in tiers
    )):
        raise BrokerError("worker_fast_unsupported")


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

    def catalog_failed(self) -> bool:
        # Called after close joins stderr consumption; do not log its contents.
        return any("failed to parse model_catalog_json" in line
                   for line in self.client._client._sync._stderr_lines)

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
            size = sum(p.stat().st_size for p in self.directory.rglob("*") if not p.is_symlink() and p.is_file())
        except OSError:
            pass
        return {"rss_bytes": rss, "temporary_bytes": size}
