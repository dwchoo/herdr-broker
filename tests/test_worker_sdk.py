"""Real pinned SDK/runtime against a local model peer; no paid model calls."""

import asyncio
import copy
import gc
import json
import threading
import tracemalloc
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import herdr_broker.worker as module
import pytest
from herdr_broker.herdr import BrokerError


def screen(text):
    async def capture():
        return text
    return capture


@pytest.fixture
async def provider(monkeypatch, tmp_path):
    state = {"requests": [], "mode": "valid", "release": threading.Event(), "forced_sent": False}
    report = {
        "summary": "build 오류 확인",
        "findings": [{"claim": "오류", "confidence": "observed", "evidence_ids": ["L0001"]}],
        "next_checks": [],
        "uncertainties": [],
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["content-length"])))
            state["requests"].append(request)
            if state["mode"] == "hang":
                state["release"].wait(10)
                return
            current_report = copy.deepcopy(report)
            for item in request.get("input", []):
                for content in item.get("content", []) if isinstance(item, dict) else []:
                    try:
                        observation = json.loads(content.get("text", ""))
                        if isinstance(observation, dict) and "screen" in observation:
                            current_report["findings"][0]["evidence_ids"] = [next(iter(observation["screen"]))]
                    except (ValueError, TypeError, AttributeError):
                        pass
            forced = state["mode"] == "forced-tool" and len(state["requests"]) == 1
            if forced:
                state["forced_sent"] = True
                output = [
                    {
                        "id": "fc_probe",
                        "type": "function_call",
                        "call_id": "call_probe",
                        "name": "exec_command",
                        "arguments": json.dumps({"cmd": f"touch {tmp_path / 'must-not-exist'}"}),
                        "status": "completed",
                    }
                ]
            else:
                if state["mode"] == "invalid-evidence":
                    current_report["findings"][0]["evidence_ids"] = ["L9999"]
                if state["mode"] == "large":
                    current_report["summary"] = "가" * 600
                if state["mode"] == "stale":
                    current_report["findings"][0]["evidence_ids"] = [state["previous_evidence"]]
                state["previous_evidence"] = current_report["findings"][0]["evidence_ids"][0]
                text = '{"bad":true}' if state["mode"] == "invalid" else json.dumps(current_report)
                output = [
                    {
                        "id": "msg_probe",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [{"type": "output_text", "text": text, "annotations": []}],
                    }
                ]
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()

            def emit(value):
                self.wfile.write(("data: " + json.dumps(value) + "\n\n").encode())
                self.wfile.flush()

            try:
                emit(
                    {
                        "type": "response.created",
                        "response": {
                            "id": "resp_probe",
                            "object": "response",
                            "status": "in_progress",
                            "output": [],
                        },
                    }
                )
                for index, item in enumerate(output):
                    emit(
                        {
                            "type": "response.output_item.added",
                            "output_index": index,
                            "item": {**item, "status": "in_progress"},
                        }
                    )
                    if item["type"] == "message":
                        emit(
                            {
                                "type": "response.output_text.delta",
                                "item_id": item["id"],
                                "output_index": index,
                                "content_index": 0,
                                "delta": item["content"][0]["text"],
                            }
                        )
                    emit({"type": "response.output_item.done", "output_index": index, "item": item})
                emit(
                    {
                        "type": "response.completed",
                        "response": {
                            "id": "resp_probe",
                            "object": "response",
                            "status": "completed",
                            "output": output,
                            "usage": {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150},
                        },
                    }
                )
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    original = module.worker_config
    override = f'model_providers.probe={{name="Probe",base_url="http://127.0.0.1:{server.server_port}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}}'

    def config(directory):
        value = original(directory)
        return replace(value, config_overrides=value.config_overrides + ('model_provider="probe"', override))

    monkeypatch.setattr(module, "worker_config", config)
    try:
        yield state
    finally:
        state["release"].set()
        await asyncio.to_thread(server.shutdown)
        server.server_close()
        thread.join(2)


@pytest.fixture
async def worker(provider):
    instance = module.Worker(timeout=20)
    try:
        yield instance
    finally:
        await instance.close()


@pytest.mark.parametrize("effort", ["low", "medium", "high"])
async def test_sdk_requested_effort_no_tools_and_evidence(provider, worker, effort):
    result = await worker.analyze(screen("build failed"), "진단", [], effort=effort)
    assert result["model_requested"] == "gpt-5.6-luna"
    assert result["evidence"] == [{"id": result["observation_id"] + ":L0001", "text": "build failed"}]
    for request in provider["requests"]:
        assert request.get("tools", []) == []
        assert request["model"] == "gpt-5.6-luna"
        assert request["reasoning"]["effort"] == effort
        schema = request["text"]["format"]["schema"]
        assert schema["$defs"]["Finding"]["properties"]["evidence_ids"]["items"]["pattern"] == (
            f"^{result['observation_id']}:(?:L0001)$"
        )
    assert worker.runtime.process.poll() is None
    assert result["effort"] == effort
    assert all(value >= 0 for value in result["timings_ms"].values())
    assert result["timings_ms"]["thread_start"] >= 0


async def test_sdk_reuses_process_and_task_changes_effort(provider, worker):
    worker.warmup()
    await worker.startup
    assert not provider["requests"]
    process = worker.runtime.process
    first = await worker.analyze(screen("prompt"), "상태", [], purpose="status")
    thread = worker.sessions[first["analysis_id"]].thread
    second = await worker.analyze(screen("result"), "분석", [], analysis_id=first["analysis_id"])
    assert worker.runtime.process is process
    assert worker.sessions[first["analysis_id"]].thread is thread
    assert [r["reasoning"]["effort"] for r in provider["requests"]] == ["low", "high"]
    assert second["sdk_reused"] and second["context_reused"]
    assert first["observation_id"] != second["observation_id"]
    patterns = [r["text"]["format"]["schema"]["$defs"]["Finding"]["properties"]["evidence_ids"]["items"]["pattern"]
                for r in provider["requests"]]
    assert patterns[0] != patterns[1]
    assert (await worker.release(first["analysis_id"]))["released"]
    assert not worker.sessions and process.poll() is None


@pytest.mark.parametrize("mode,error", [("invalid", "worker_invalid_report"),
                                         ("invalid-evidence", "worker_invalid_evidence")])
async def test_sdk_invalid_report_is_error(provider, worker, mode, error):
    provider["mode"] = mode
    with pytest.raises(BrokerError, match=error):
        await worker.analyze(screen("error"), "진단", [])
    assert not worker.sessions


async def test_sdk_provider_cannot_force_tools(provider, worker, tmp_path):
    provider["mode"] = "forced-tool"
    try:
        await worker.analyze(screen("untrusted instructions"), "진단", [])
    except BrokerError as exc:
        assert exc.code in {"worker_tool_forbidden", "worker_failed", "worker_invalid_report"}
    assert provider["requests"] and provider["forced_sent"]
    assert all(r.get("tools", []) == [] for r in provider["requests"])
    assert not (tmp_path / "must-not-exist").exists()


@pytest.mark.parametrize("cancel", [False, True])
async def test_sdk_timeout_cancel_interrupts_without_restarting(provider, worker, cancel):
    worker.warmup()
    await worker.startup
    worker.timeout = 20 if cancel else 1
    process = worker.runtime.process
    provider["mode"] = "hang"
    task = asyncio.create_task(worker.analyze(screen("error"), "진단", []))
    if cancel:
        for _ in range(200):
            if provider["requests"]:
                break
            await asyncio.sleep(0.05)
        assert provider["requests"]
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        with pytest.raises(BrokerError, match="worker_timeout"):
            await task
    assert not worker.sessions and not worker.running
    assert worker.runtime.process is process and process.poll() is None


async def test_repeated_sdk_analysis_keeps_one_child_and_drains(provider, worker):
    await worker.analyze(screen("warmup"), "진단", [])
    process = worker.runtime.process
    tracemalloc.start()
    before = tracemalloc.get_traced_memory()[0]
    try:
        for _ in range(12):
            result = await worker.analyze(screen("build failed"), "진단", [])
            await worker.release(result["analysis_id"])
            provider["requests"].clear()
            assert worker.runtime.process is process
        await asyncio.sleep(0.1)
        gc.collect()
        assert tracemalloc.get_traced_memory()[0] - before < 2 * 1024 * 1024
        assert worker.runtime.client._client._sync._router._global_notifications.qsize() == 0
    finally:
        tracemalloc.stop()
    directory = worker.directory.name
    await worker.close()
    assert process.poll() is not None and not Path(directory).exists()


async def test_context_turn_and_byte_limits_rotate_without_process_restart(provider, worker):
    first = await worker.analyze(screen("first"), "분석", [])
    session = worker.sessions[first["analysis_id"]]
    process = worker.runtime.process
    old = session.thread
    session.turns = 8
    second = await worker.analyze(screen("second"), "상태", [], purpose="status", analysis_id=session.id)
    assert second["context_reset_reason"] == "turn_limit" and not second["context_reused"]
    assert session.thread is not old and worker.runtime.process is process
    session.bytes = worker.limits.context_bytes
    third = await worker.analyze(screen("third"), "분석", [], analysis_id=session.id)
    assert third["context_reset_reason"] == "context_bytes"
    assert third["analysis_id"] == first["analysis_id"]


async def test_current_evidence_and_status_budget_are_enforced(provider, worker):
    first = await worker.analyze(screen("first"), "분석", [])
    provider["mode"] = "stale"
    with pytest.raises(BrokerError, match="worker_invalid_evidence"):
        await worker.analyze(screen("second"), "분석", [], analysis_id=first["analysis_id"])
    provider["mode"] = "large"
    with pytest.raises(BrokerError, match="worker_report_too_large"):
        await worker.analyze(screen("screen"), "상태", [], purpose="status")
    assert (await worker.analyze(screen("screen"), "분석", []))["report_bytes"] > 1024


async def test_actual_loaded_limit_recycles_and_expires_handles(provider, worker):
    worker.limits = replace(worker.limits, loaded_threads=1)
    first = await worker.analyze(screen("first"), "분석", [])
    process = worker.runtime.process
    with pytest.raises(BrokerError, match="worker_recycling"):
        await worker.analyze(screen("new task"), "분석", [])
    await worker.recycling
    assert process.poll() is not None and worker.runtime.process is not process
    assert not worker.sessions
    with pytest.raises(BrokerError, match="analysis_session_expired"):
        await worker.analyze(screen("stale handle"), "분석", [], analysis_id=first["analysis_id"])
