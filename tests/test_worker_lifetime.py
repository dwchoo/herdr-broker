import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from herdr_broker.herdr import BrokerError
from herdr_broker.worker import Worker
from test_worker_sdk import screen


@pytest.mark.parametrize("hang", [False, True])
async def test_cleanup_failure_blocks_new_clients_until_shutdown(monkeypatch, hang):
    release = asyncio.Event()
    client = AsyncMock()
    client.thread_start.side_effect = OSError("startup failed")
    constructed = []

    async def close():
        if hang:
            await release.wait()
        else:
            raise OSError("close failed")

    client.close.side_effect = close

    def factory(config):
        constructed.append(Path(config.cwd))
        return client

    monkeypatch.setattr("herdr_broker.worker.AsyncCodex", factory)
    worker = Worker(cleanup_timeout=0.02)
    for _ in range(20):
        with pytest.raises(BrokerError, match="worker_cleanup_failed"):
            await worker.analyze(screen("screen"), "read", [])
    assert len(constructed) == len(worker.active) == 1
    assert worker.running == 0 and worker.unhealthy
    assert constructed[0].exists()  # Do not remove a still-running SDK's working directory.
    if hang:
        release.set()
    else:
        client.close.side_effect = None
    await worker.close()
    await asyncio.sleep(0)  # Cleanup task done callbacks.
    assert not worker.active and not worker.directories and not worker.cleanups
    assert not constructed[0].exists()
    assert client.close.await_count == (1 if hang else 2)


async def test_repeated_cancellation_keeps_cleanup_owned(monkeypatch):
    started = asyncio.Event()
    closing = asyncio.Event()
    release = asyncio.Event()
    client = AsyncMock()

    async def start(**kwargs):
        started.set()
        await asyncio.Event().wait()

    async def close():
        closing.set()
        await release.wait()

    client.thread_start.side_effect = start
    client.close.side_effect = close
    monkeypatch.setattr("herdr_broker.worker.AsyncCodex", lambda _: client)
    worker = Worker()
    task = asyncio.create_task(worker.analyze(screen("screen"), "read", []))
    await started.wait()
    task.cancel()
    await closing.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert worker.unhealthy and client in worker.active
    release.set()
    await worker.close()
    assert not worker.active
    client.close.assert_awaited_once()


async def test_shutdown_during_capture_never_starts_client(monkeypatch):
    captured = asyncio.Event()
    release = asyncio.Event()
    factory = AsyncMock()
    monkeypatch.setattr("herdr_broker.worker.AsyncCodex", factory)

    async def capture():
        captured.set()
        await release.wait()
        return "screen"

    worker = Worker()
    task = asyncio.create_task(worker.analyze(capture, "read", []))
    await captured.wait()
    await worker.close()
    release.set()
    with pytest.raises(BrokerError, match="worker_closed"):
        await task
    factory.assert_not_called()
    assert worker.running == 0
