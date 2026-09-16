from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from importlib.resources import files
from tempfile import TemporaryDirectory
from time import perf_counter
from typing import Any, Literal
from uuid import uuid4

import anyio
from openai_codex import ApprovalMode, AsyncCodex, AsyncThread, AsyncTurnHandle, CodexConfig, Sandbox
from openai_codex.generated.v2_all import Personality
from openai_codex.types import ReasoningEffort
from pydantic import BaseModel

from .herdr import BrokerError
from .reports import AnalysisReport, StatusReport, build_report, validate_items
from .sdk_runtime import SDKRuntime, analysis_profile
from .snapshot import clean

MODEL = "gpt-5.6-luna"
Effort = Literal["low", "medium", "high"]
Purpose = Literal["status", "analysis"]
ServiceTier = Literal["default", "fast"]
Identity = tuple[str, str, str]
logger = logging.getLogger(__name__)
DISABLED = (
    "shell_tool",
    "unified_exec",
    "apps",
    "plugins",
    "multi_agent",
    "multi_agent_v2",
    "hooks",
    "memories",
    "shell_snapshot",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "image_generation",
    "view_image",
    "goals",
    "code_mode_host",
    "sleep_tool",
    "skill_search",
    "workspace_dependencies",
    "tool_suggest",
    "auth_elicitation",
    "tool_call_mcp_elicitation",
    "enable_request_compression",
    "code_mode",
    "code_mode_only",
)
INSTRUCTIONS = files("herdr_broker").joinpath("resources/worker.txt").read_text().strip()


def worker_config(directory: str) -> CodexConfig:
    profile, catalog = analysis_profile(directory, MODEL)
    return CodexConfig(
        cwd=directory,
        env={"CODEX_HOME": str(profile)},
        config_overrides=tuple(f"features.{name}=false" for name in DISABLED)
        + (
            "features.skip_host_skill_discovery=true",
            "features.fast_mode=true",
            "tools.update_plan.enabled=false",
            "tools.experimental_request_user_input.enabled=false",
            f"model_catalog_json={json.dumps(str(catalog))}",
            "skills.include_instructions=false",
            "include_environment_context=false",
            "include_apps_instructions=false",
            "include_collaboration_mode_instructions=false",
            "include_permissions_instructions=false",
            "mcp_servers={}",
            'web_search="disabled"',
            "project_doc_max_bytes=0",
            'history.persistence="none"',
            "suppress_unstable_features_warning=true",
            f"sqlite_home={json.dumps(directory + '/state')}",
            f"log_dir={json.dumps(directory + '/logs')}",
        ),
    )


@dataclass(frozen=True)
class Limits:
    contexts: int = 2
    idle_seconds: float = 300
    sample_seconds: float = 30
    rss_gap_seconds: float = 30
    rss_bytes: int = 512 * 1024 * 1024
    temporary_bytes: int = 128 * 1024 * 1024
    loaded_threads: int = 64


@dataclass
class Analysis:
    identity: Identity
    id: str = field(default_factory=lambda: uuid4().hex)
    thread: AsyncThread | None = None
    busy: bool = True
    touched: float = field(default_factory=perf_counter)
    turn: AsyncTurnHandle | None = None
    terminal_event: asyncio.Event = field(default_factory=asyncio.Event)


class Worker:
    def __init__(self, timeout: float = 60, cleanup_timeout: float = 5, *, limits: Limits | None = None):
        self.timeout, self.cleanup_timeout = timeout, cleanup_timeout
        self.limits = limits or Limits()
        self.runtime: SDKRuntime | None = None
        self.directory: TemporaryDirectory[str] | None = None
        self.startup: asyncio.Task[None] | None = None
        self.startup_error: str | None = None
        self.monitor: asyncio.Task[None] | None = None
        self.recycling: asyncio.Task[None] | None = None
        self.cleanup_task: asyncio.Task[None] | None = None
        self.sessions: dict[str, Analysis] = {}
        self.finishing: set[asyncio.Task[None]] = set()
        self.call_tasks: set[asyncio.Task[Any]] = set()
        self.thread_lock = asyncio.Lock()
        self.running = 0
        self.closing = False
        self.unhealthy = False
        self.recovery_used = False
        self.recycle_reason: str | None = None
        self.high_rss_since: float | None = None
        self.metrics: dict[str, Any] = {}

    @staticmethod
    def _consume(task: asyncio.Task[Any]) -> None:
        if not task.cancelled():
            task.exception()

    def warmup(self) -> None:
        if self.startup is None and not self.closing and not self.unhealthy:
            self.startup = asyncio.create_task(self._initialize())
            self.startup.add_done_callback(self._consume)
        if self.monitor is None and not self.closing:
            self.monitor = asyncio.create_task(self._monitor())

    async def _initialize(self) -> None:
        self.startup_error = None
        began = perf_counter()
        try:
            self.directory = TemporaryDirectory(prefix="herdr-worker-")
            self.runtime = SDKRuntime(AsyncCodex(worker_config(self.directory.name)),
                                      self.directory.name, self._fault)
            async with asyncio.timeout(self.timeout):
                await self.runtime.start()
            self.metrics["initialization_ms"] = round((perf_counter() - began) * 1000, 3)
            logger.info("sdk_ready %s", json.dumps(self.metrics))
        except BaseException as error:
            self.unhealthy = True
            runtime = self.runtime
            await self._cleanup_runtime()
            self.startup_error = error.code if isinstance(error, BrokerError) else "worker_failed"
            if runtime is not None and runtime.catalog_failed():
                self.startup_error = "worker_model_catalog_unavailable"
            raise BrokerError(self.startup_error) from None

    def _fault(self) -> None:
        if not self.closing:
            self.unhealthy = True
            self._retire("sdk_fault")

    def _retire(self, reason: str) -> None:
        self.recycle_reason = self.recycle_reason or reason
        if not self.running and not self.closing and self.recycling is None:
            self.recycling = asyncio.create_task(self._recycle())
            self.recycling.add_done_callback(self._consume)

    async def _cleanup_runtime(self) -> None:
        async def shutdown() -> None:
            if self.runtime is not None:
                await self.runtime.close()
            if self.directory is not None:
                self.directory.cleanup()
            self.runtime = None
            self.directory = None

        if self.cleanup_task is None:
            self.cleanup_task = asyncio.create_task(shutdown())
            self.cleanup_task.add_done_callback(self._consume)
        done, _ = await asyncio.wait({self.cleanup_task}, timeout=self.cleanup_timeout)
        if not done or self.cleanup_task.cancelled() or self.cleanup_task.exception() is not None:
            self.unhealthy = True
            raise BrokerError("worker_cleanup_failed")
        self.cleanup_task = None

    async def _recycle(self) -> None:
        reason = self.recycle_reason
        try:
            self.sessions.clear()
            await self._cleanup_runtime()
            self.high_rss_since = None
            if reason == "sdk_fault" and self.recovery_used:
                self.unhealthy = True
                self.recycle_reason = None
                return
            self.recovery_used = True
            self.unhealthy = False
            self.startup = None
            self.metrics = {"recycle_reason": reason}
            logger.warning("sdk_recycled %s", json.dumps(self.metrics))
            if not self.closing:
                # Exactly one replacement attempt. A failed warmup stays failed.
                self.startup = asyncio.create_task(self._initialize())
                self.startup.add_done_callback(self._consume)
                await asyncio.shield(self.startup)
            self.recycle_reason = None
        except Exception:
            self.unhealthy = True
            self.recycle_reason = None
        finally:
            self.recycling = None

    async def _monitor(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.limits.sample_seconds)
                if self.closing:
                    return
                if self.runtime is None or self.startup is None or not self.startup.done():
                    continue
                if self.unhealthy or self.recycle_reason:
                    continue
                try:
                    async with asyncio.timeout(self.cleanup_timeout):
                        for session in list(self.sessions.values()):
                            if not session.busy and perf_counter() - session.touched >= self.limits.idle_seconds:
                                await self.release(session.id)
                        await self.sample_resources()
                except Exception:
                    self._fault()
        except asyncio.CancelledError:
            pass

    async def sample_resources(self) -> None:
        runtime = self.runtime
        if runtime is None:
            return
        resources = await asyncio.to_thread(runtime.resources)
        if runtime is not self.runtime or self.recycle_reason:
            return
        self.metrics.update(resources)
        stamp = perf_counter()
        rss = resources["rss_bytes"]
        if rss is not None and rss >= self.limits.rss_bytes:
            if self.high_rss_since is None:
                self.high_rss_since = stamp
            elif stamp - self.high_rss_since >= self.limits.rss_gap_seconds:
                self._retire("rss_limit")
        else:
            self.high_rss_since = None
        size = resources["temporary_bytes"]
        if size is not None and size >= self.limits.temporary_bytes:
            self._retire("temporary_limit")
        logger.info("sdk_resources %s", json.dumps(resources))

    def _select(self, identity: Identity, analysis_id: str | None) -> tuple[Analysis, list[Analysis]]:
        if self.closing:
            raise BrokerError("worker_closed")
        if self.recycle_reason and self.recycling is not None:
            raise BrokerError("worker_recycling")
        if self.cleanup_task is not None:
            raise BrokerError("worker_cleanup_failed")
        if self.recycle_reason:
            raise BrokerError("worker_recycling")
        if self.unhealthy:
            raise BrokerError(self.startup_error or "worker_failed")
        if analysis_id:
            session = self.sessions.get(analysis_id)
            if session is None:
                raise BrokerError("analysis_session_expired")
            if session.identity != identity:
                raise BrokerError("analysis_target_mismatch")
            if session.busy:
                raise BrokerError("analysis_session_busy")
            if perf_counter() - session.touched >= self.limits.idle_seconds:
                raise BrokerError("analysis_session_expired")
        if self.running >= 2:
            raise BrokerError("worker_busy")
        retired = []
        if not analysis_id:
            if len(self.sessions) >= self.limits.contexts:
                idle = [s for s in self.sessions.values() if not s.busy]
                if not idle:
                    raise BrokerError("worker_busy")
                old = min(idle, key=lambda s: s.touched)
                retired.append(self.sessions.pop(old.id))
            session = Analysis(identity)
            self.sessions[session.id] = session
        assert session is not None
        session.busy = True
        session.turn = None
        session.terminal_event = asyncio.Event()
        self.running += 1
        return session, retired

    async def release(self, analysis_id: str) -> dict[str, Any]:
        session = self.sessions.get(analysis_id)
        if session is None:
            return {"analysis_id": analysis_id, "released": False}
        if session.busy:
            raise BrokerError("analysis_session_busy")
        self.sessions.pop(analysis_id)
        try:
            async with asyncio.timeout(self.cleanup_timeout):
                if session.thread is not None and self.runtime is not None:
                    await self.runtime.unsubscribe(session.thread.id)
        except BaseException:
            self._fault()
            raise
        return {"analysis_id": analysis_id, "released": True}

    async def analyze(
        self, capture: Callable[[], Awaitable[str]], objective: str, patterns: list[str],
        *, effort: Effort | None = None, purpose: Purpose = "analysis",
        identity: Identity = ("", "", ""), analysis_id: str | None = None,
        service_tier: ServiceTier = "default", requested_items: list[str] | None = None,
    ) -> dict[str, Any]:
        requested = validate_items(requested_items, purpose)
        requested = [clean(item, patterns) for item in requested]
        if requested:
            validate_items(requested, purpose)
        began = perf_counter()
        session, retired = self._select(identity, analysis_id)
        task = asyncio.current_task()
        if task is not None:
            self.call_tasks.add(task)
        selected: Effort = effort or ("low" if purpose == "status" else "medium")
        timings = {"admission": round((perf_counter() - began) * 1000, 3)}
        collector: asyncio.Task[dict[str, Any]] | None = None
        failed = True
        try:
            async with asyncio.timeout(self.timeout):
                ready = self.startup is not None and self.startup.done() and not self.unhealthy
                self.warmup()
                start = perf_counter()
                assert self.startup is not None
                await asyncio.shield(self.startup)
                timings["sdk_start"] = round((perf_counter() - start) * 1000, 3)
                if self.closing or self.unhealthy or self.recycle_reason:
                    raise BrokerError("worker_closed" if self.closing else "worker_recycling")
                assert self.runtime is not None
                for old in retired:
                    if old.thread is not None:
                        await self.runtime.unsubscribe(old.thread.id)
                start = perf_counter()
                text = await capture()
                timings["capture"] = round((perf_counter() - start) * 1000, 3)
                if self.closing:
                    raise BrokerError("worker_closed")
                collector = asyncio.create_task(self._analyze(
                    text, objective, patterns, selected, timings, session, purpose, service_tier, requested,
                ))
                result = await asyncio.shield(collector)
                result["sdk_reused"] = ready
                result["timings_ms"] = timings
                failed = False
                self.recovery_used = False
                return result
        except TimeoutError:
            raise BrokerError("worker_timeout") from None
        except asyncio.CancelledError:
            raise
        except BrokerError:
            raise
        except Exception:
            raise BrokerError("worker_failed") from None
        finally:
            finishing = asyncio.create_task(self._finish(session, collector, failed, timings))
            self.finishing.add(finishing)
            finishing.add_done_callback(self.finishing.discard)
            finishing.add_done_callback(self._consume)
            try:
                with anyio.CancelScope(shield=True):
                    await asyncio.shield(finishing)
            finally:
                if task is not None:
                    self.call_tasks.discard(task)
                logger.log(logging.WARNING if failed else logging.INFO, "pane_analysis %s", json.dumps({
                    "failed": failed, "purpose": purpose, "effort": selected, "timings_ms": timings,
                    "service_tier_requested": service_tier,
                    "total_ms": round((perf_counter() - began) * 1000, 3),
                }))

    async def _finish(
        self, session: Analysis, collector: asyncio.Task[dict[str, Any]] | None,
        failed: bool, timings: dict[str, float],
    ) -> None:
        start = perf_counter()
        try:
            async with asyncio.timeout(self.cleanup_timeout):
                if failed:
                    self.sessions.pop(session.id, None)
                    if collector is not None and not session.terminal_event.is_set():
                        if session.turn is None or collector.done():
                            self._fault()
                        else:
                            await session.turn.interrupt()
                            await session.terminal_event.wait()
                            await asyncio.wait({collector})
                    if collector is not None and collector.done():
                        self._consume(collector)
                if session.thread is not None and self.runtime is not None and not self.unhealthy:
                    await self.runtime.unsubscribe(session.thread.id)
        except Exception:
            self._fault()
            raise BrokerError("worker_cleanup_failed") from None
        finally:
            if collector is not None and not collector.done():
                collector.cancel()
                await asyncio.gather(collector, return_exceptions=True)
            session.thread = None
            session.turn = None
            session.busy = False
            session.touched = perf_counter()
            self.running -= 1
            timings["cleanup"] = round((perf_counter() - start) * 1000, 3)
            if self.recycle_reason:
                self._retire(self.recycle_reason)

    async def _analyze(
        self, text: str, objective: str, patterns: list[str], effort: Effort,
        timings: dict[str, float], session: Analysis, purpose: Purpose, service_tier: ServiceTier, requested_items: list[str],
    ) -> dict[str, Any]:
        prepared = perf_counter()
        instructions = INSTRUCTIONS + "\n" + files("herdr_broker").joinpath(f"resources/{purpose}.txt").read_text().strip()
        observation = uuid4().hex
        rows = {f"L{i + 1:04}": row for i, row in enumerate(text.split("\n"))}
        objective = clean(objective, patterns)
        content: dict[str, Any] = {
            "purpose": purpose, "objective": objective, "observation_id": observation, "screen": rows,
        }
        if purpose == "analysis":
            content["requested_items"] = requested_items
        prompt = json.dumps(content, ensure_ascii=False, separators=(",", ":"))
        payload_bytes = len(text.encode()) + len(objective.encode())
        schema = (StatusReport if purpose == "status" else AnalysisReport).model_json_schema()
        sizes = {"screen_bytes": len(text.encode()), "objective_bytes": len(objective.encode()),
                 "prompt_bytes": len(prompt.encode()),
                 "schema_bytes": len(json.dumps(schema, ensure_ascii=False, separators=(",", ":")).encode()),
                 "instructions_bytes": len(instructions.encode())}
        sizes["broker_request_bytes"] = sum(sizes[key] for key in ("prompt_bytes", "schema_bytes", "instructions_bytes"))
        logger.info("worker_input_sizes %s", json.dumps(sizes))
        timings["prepare"] = round((perf_counter() - prepared) * 1000, 3)
        assert self.runtime is not None and self.directory is not None
        start = perf_counter()
        async with self.thread_lock:
            loaded = await self.runtime.loaded_count(self.limits.loaded_threads)
            self.metrics["loaded_threads"] = loaded
            if loaded >= self.limits.loaded_threads:
                self._retire("loaded_threads")
                raise BrokerError("worker_recycling")
            session.thread = await self.runtime.client.thread_start(
                model=MODEL, approval_mode=ApprovalMode.deny_all, sandbox=Sandbox.read_only,
                ephemeral=True, cwd=self.directory.name, base_instructions=instructions,
                developer_instructions="", personality=Personality.none,
            )
        timings["thread_start"] = round((perf_counter() - start) * 1000, 3)
        start = perf_counter()
        session.turn = await session.thread.turn(
            prompt, effort=ReasoningEffort(effort), output_schema=schema,
            turn_service_tier="priority" if service_tier == "fast" else "default",
        )
        timings["turn_submit"] = round((perf_counter() - start) * 1000, 3)
        stage, start = "first_event", perf_counter()
        final, completed, usage, total = "", False, None, 0
        stream = session.turn.stream()
        try:
            async for event in stream:
                if stage == "first_event":
                    timings[stage] = round((perf_counter() - start) * 1000, 3)
                    stage, start = "stream", perf_counter()
                payload: dict[str, Any] = (event.payload.model_dump(mode="json", by_alias=True)
                                          if isinstance(event.payload, BaseModel) else event.payload.params)
                total += len(json.dumps(payload).encode())
                if total > 1024 * 1024:
                    raise BrokerError("worker_output_limit")
                if event.method in {"item/started", "item/completed"}:
                    item = payload.get("item", {})
                    if item.get("type") not in {"userMessage", "agentMessage", "reasoning"}:
                        raise BrokerError("worker_tool_forbidden")
                    if event.method == "item/completed" and item.get("type") == "agentMessage":
                        final = item.get("text", "")
                elif event.method == "thread/tokenUsage/updated":
                    usage = payload.get("tokenUsage")
                elif event.method == "turn/completed":
                    session.terminal_event.set()
                    completed = payload.get("turn", {}).get("status") == "completed"
        finally:
            await getattr(stream, "aclose")()
            timings[stage] = round((perf_counter() - start) * 1000, 3)
        if not completed:
            raise BrokerError("worker_failed")
        start = perf_counter()
        report = build_report(final, text, observation, purpose, requested_items, patterns)
        timings["validation"] = round((perf_counter() - start) * 1000, 3)
        return {
            **report, "model_requested": MODEL, "effort": effort, "purpose": purpose, "usage": usage,
            "service_tier_requested": service_tier,
            "analysis_id": session.id, "observation_id": observation,
            "context_mode": "independent", "context_reused": False, "context_reset": False,
            "context_reset_reason": None, "input_bytes": payload_bytes,
            "input_sizes": sizes,
        }

    async def close(self) -> None:
        self.closing = True
        with anyio.CancelScope(shield=True):
            if self.monitor is not None:
                self.monitor.cancel()
                await asyncio.gather(self.monitor, return_exceptions=True)
            for task in list(self.call_tasks):
                task.cancel()
            if self.call_tasks:
                await asyncio.gather(*self.call_tasks, return_exceptions=True)
            if self.finishing:
                await asyncio.gather(*self.finishing, return_exceptions=True)
            if self.startup is not None and not self.startup.done():
                self.startup.cancel()
                await asyncio.gather(self.startup, return_exceptions=True)
            if self.recycling is not None:
                await asyncio.gather(self.recycling, return_exceptions=True)
            if self.cleanup_task is not None and self.cleanup_task.done():
                self.cleanup_task = None  # One explicit shutdown retry of failed cleanup.
            await self._cleanup_runtime()
            self.sessions.clear()
