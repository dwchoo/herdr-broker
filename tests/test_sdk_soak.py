"""Opt-in real SDK soak: BROKER_SOAK_SECONDS=2100 pytest -s tests/test_sdk_soak.py."""
import asyncio
import gc
import json
import os
import subprocess
import time
import tracemalloc
from datetime import UTC, datetime
from pathlib import Path

import pytest
from herdr_broker.herdr import BrokerError
from herdr_broker.observations import Observations
from herdr_broker.worker import Worker
from test_worker_sdk import provider as model_provider_fixture
from test_worker_sdk import screen

provider = model_provider_fixture


@pytest.mark.skipif(not os.environ.get("BROKER_SOAK_SECONDS"), reason="35-minute SDK soak is opt-in")
async def test_real_sdk_100_analyses_and_35_minute_retention(provider):
    duration = float(os.environ["BROKER_SOAK_SECONDS"])
    worker = Worker(timeout=30)
    observations = Observations()
    started = time.monotonic()
    records, owned, directories = [], {}, set()
    output = Path("/private/tmp/herdr-report-soak.json")
    tracemalloc.start()

    async def measure(stage):
        runtime = worker.runtime
        assert runtime is not None and runtime.process is not None
        owned[runtime.process.pid] = runtime.process
        directories.add(str(runtime.directory))
        live = [pid for pid, proc in owned.items() if proc.poll() is None]
        assert live == [runtime.process.pid]
        await asyncio.sleep(0.05)
        gc.collect()
        record = {
            "stage": stage, "elapsed_seconds": round(time.monotonic() - started, 2),
            "pid": runtime.process.pid, "live_children": len(live),
            "loaded_threads": await runtime.loaded_count(1000),
            "global_queue": runtime.client._client._sync._router._global_notifications.qsize(),
            "python_traced_bytes": tracemalloc.get_traced_memory()[0],
            "contexts": len(worker.sessions), "snapshot_bytes": observations.bytes, "snapshots": len(observations.records),
            "python_rss_bytes": int(subprocess.check_output(["/bin/ps", "-o", "rss=", "-p", str(os.getpid())]).strip()) * 1024,
            **await asyncio.to_thread(runtime.resources),
        }
        assert record["global_queue"] == 0
        records.append(record)
        output.write_text(json.dumps({"complete": False, "samples": records}, indent=2))
        print("SDK_SOAK=" + json.dumps(record), flush=True)

    try:
        worker.warmup()
        await worker.startup
        await measure("ready")
        completed = 0
        while completed < 100:
            try:
                result = await worker.analyze(screen("synthetic output\nuser@host$"), "확인", [],
                                              purpose="status" if completed % 2 == 0 else "analysis")
            except BrokerError as exc:
                if exc.code != "worker_recycling":
                    raise
                assert worker.recycling is not None
                await worker.recycling
                await measure("recycled")
                continue
            observations.put(result["observation_id"], "synthetic", {"captured_at": datetime.now(UTC).isoformat()}, time.monotonic())
            await worker.release(result["analysis_id"])
            provider["requests"].clear()
            completed += 1
            if completed % 10 == 0:
                await measure(f"analysis_{completed}")
        while time.monotonic() - started < duration:
            await asyncio.sleep(min(30, duration - (time.monotonic() - started)))
            if worker.recycling is not None:
                await worker.recycling
            await measure("idle")
        assert len(worker.sessions) == 0
        assert not observations.records and observations.bytes == 0
    finally:
        observations.close()
        await worker.close()
        tracemalloc.stop()
    assert all(proc.poll() is not None for proc in owned.values())
    assert all(not Path(path).exists() for path in directories)
    output.write_text(json.dumps({"complete": True, "analyses": completed,
                                 "duration_seconds": time.monotonic() - started,
                                 "children_exited": True, "directories_removed": True,
                                 "samples": records}, indent=2))
