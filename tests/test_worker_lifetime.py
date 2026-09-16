import asyncio
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from conftest import StubWorker
from herdr_broker.herdr import BrokerError
from herdr_broker.worker import Analysis, Limits, Worker
from test_worker_sdk import screen


@pytest.mark.parametrize("hang", [False, True])
async def test_cleanup_failure_blocks_new_clients_until_shutdown(monkeypatch, hang):
    entered, release = asyncio.Event(), asyncio.Event()
    runtime = SimpleNamespace(close=AsyncMock())
    constructed = []

    async def close():
        entered.set()
        if hang:
            await release.wait()
        else:
            raise OSError("close failed")

    runtime.close.side_effect = close
    worker = Worker(cleanup_timeout=0.02)
    worker.runtime = runtime
    with pytest.raises(BrokerError, match="worker_cleanup_failed"):
        await worker._cleanup_runtime()
    monkeypatch.setattr("herdr_broker.worker.AsyncCodex", lambda config: constructed.append(config))
    for _ in range(20):
        with pytest.raises(BrokerError, match="worker_cleanup_failed"):
            await worker.analyze(screen("screen"), "read", [])
    assert not constructed and worker.runtime is runtime
    if hang:
        release.set()
    else:
        runtime.close.side_effect = None
    await worker.close()
    assert worker.runtime is None
    assert runtime.close.await_count == (1 if hang else 2)


async def test_shutdown_during_capture_releases_slot():
    worker = StubWorker()
    entered = asyncio.Event()

    async def capture():
        entered.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(worker.analyze(capture, "read", []))
    await entered.wait()
    await worker.close()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert worker.running == 0 and not worker.sessions


async def test_cancelled_waiter_does_not_cancel_shared_initialization(monkeypatch):
    worker = StubWorker()
    ready, started = asyncio.Event(), asyncio.Event()
    original = worker._initialize

    async def initialize():
        started.set()
        await ready.wait()
        await original()

    monkeypatch.setattr(worker, "_initialize", initialize)
    task = asyncio.create_task(worker.analyze(screen("screen"), "read", []))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not worker.startup.cancelled() and not worker.startup.done()
    ready.set()
    result = await worker.analyze(screen("screen"), "read", [])
    assert result["analysis_id"] in worker.sessions
    await worker.close()


async def test_sessions_identity_busy_expiration_and_oldest_idle_eviction():
    worker = StubWorker()
    identity = ("w", "p", "t")
    first = await worker.analyze(screen("one"), "read", [], identity=identity)
    analysis_id = first["analysis_id"]
    with pytest.raises(BrokerError, match="analysis_target_mismatch"):
        await worker.analyze(screen("other"), "read", [], identity=("w", "p", "replaced"),
                             analysis_id=analysis_id)
    session = worker.sessions[analysis_id]
    session.busy = True
    with pytest.raises(BrokerError, match="analysis_session_busy"):
        await worker.analyze(screen("same"), "read", [], identity=identity, analysis_id=analysis_id)
    session.busy = False
    await worker.analyze(screen("two"), "read", [])
    await worker.analyze(screen("three"), "read", [])
    assert len(worker.sessions) == 2 and analysis_id not in worker.sessions
    with pytest.raises(BrokerError, match="analysis_session_expired"):
        await worker.analyze(screen("expired"), "read", [], identity=identity, analysis_id=analysis_id)
    remaining = next(iter(worker.sessions.values()))
    remaining.touched -= 301
    with pytest.raises(BrokerError, match="analysis_session_expired"):
        await worker.analyze(screen("idle"), "read", [], analysis_id=remaining.id)
    await worker.close()


async def test_resource_limits_require_spaced_rss_and_keep_unknown(monkeypatch):
    worker = Worker(limits=replace(Limits(), rss_bytes=100, temporary_bytes=200))
    values = {"rss_bytes": 100, "temporary_bytes": 0}
    worker.runtime = SimpleNamespace(resources=lambda: dict(values))
    reasons = []
    monkeypatch.setattr(worker, "_retire", reasons.append)
    clock = [100.0]
    monkeypatch.setattr("herdr_broker.worker.perf_counter", lambda: clock[0])
    await worker.sample_resources()
    clock[0] = 129
    await worker.sample_resources()
    assert not reasons
    clock[0] = 130
    await worker.sample_resources()
    assert reasons == ["rss_limit"]
    values.update(rss_bytes=None, temporary_bytes=None)
    await worker.sample_resources()
    assert worker.metrics["rss_bytes"] is None and worker.high_rss_since is None
    values.update(temporary_bytes=200)
    await worker.sample_resources()
    assert reasons[-1] == "temporary_limit"


async def test_idle_context_unsubscribes_without_ending_runtime():
    worker = StubWorker()
    worker.limits = replace(Limits(), sample_seconds=0.01, idle_seconds=0.01)
    await worker.analyze(screen("screen"), "read", [])
    runtime = worker.runtime
    runtime.resources = lambda: {"rss_bytes": 1, "temporary_bytes": 1}
    await asyncio.sleep(0.05)
    assert not worker.sessions and worker.runtime is runtime
    runtime.close.assert_not_awaited()
    await worker.close()


async def test_release_unknown_is_idempotent_and_busy_is_preserved():
    worker = Worker()
    assert not (await worker.release("missing"))["released"]
    session = Analysis(("w", "p", "t"))
    worker.sessions[session.id] = session
    with pytest.raises(BrokerError, match="analysis_session_busy"):
        await worker.release(session.id)
    assert session.id in worker.sessions
    session.busy = False
    assert (await worker.release(session.id))["released"]
    await worker.close()


async def test_spawn_cancellation_keeps_late_child_owned():
    import threading
    from unittest.mock import Mock

    from herdr_broker.sdk_runtime import SDKRuntime

    entered, release = threading.Event(), threading.Event()
    process = Mock()
    sync = SimpleNamespace(_proc=None)

    def start():
        entered.set()
        release.wait(2)
        sync._proc = process

    def close():
        sync._proc = None

    sync.start, sync.close = start, close
    client = SimpleNamespace(_client=SimpleNamespace(_sync=sync), close=AsyncMock())
    runtime = SDKRuntime(client, "/tmp", lambda: None)
    start_task = asyncio.create_task(runtime.start())
    await asyncio.to_thread(entered.wait, 1)
    start_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await start_task
    closing = asyncio.create_task(runtime.close())
    await asyncio.sleep(0.01)
    assert not closing.done()
    release.set()
    await closing
    assert runtime.process is process
    process.wait.assert_called()


async def test_repeated_early_fault_stops_after_one_replacement():
    worker = StubWorker()
    worker.warmup()
    await worker.startup
    worker._fault()
    await worker.recycling
    assert not worker.unhealthy and worker.recovery_used
    runtime = worker.runtime
    worker._fault()
    await worker.recycling
    assert worker.unhealthy and worker.runtime is None
    runtime.close.assert_awaited_once()
    with pytest.raises(BrokerError, match="worker_failed"):
        await worker.analyze(screen("new"), "read", [])
    await worker.close()


async def test_shutdown_cancels_blocked_replacement_warmup(monkeypatch):
    worker = StubWorker()
    worker.warmup()
    await worker.startup
    entered = asyncio.Event()

    async def initialize():
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(worker, "_initialize", initialize)
    worker._retire("loaded_threads")
    await entered.wait()
    await asyncio.wait_for(worker.close(), 0.5)
    assert worker.runtime is None


async def test_partial_spawn_error_still_closes_owned_child():
    from unittest.mock import Mock

    from herdr_broker.sdk_runtime import SDKRuntime

    process = Mock()
    sync = SimpleNamespace(_proc=None)

    def start():
        sync._proc = process
        raise OSError("reader thread failed after Popen")

    sync.start = start
    client = SimpleNamespace(_client=SimpleNamespace(_sync=sync), close=AsyncMock())
    runtime = SDKRuntime(client, "/tmp", lambda: None)
    with pytest.raises(OSError):
        await runtime.start()
    await runtime.close()
    client.close.assert_awaited_once()
    process.wait.assert_called_once()
