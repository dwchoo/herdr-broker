"""Real pinned SDK/runtime against a local model peer; no paid model calls."""

import asyncio
import json
import threading
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock

import herdr_broker.worker as module
import pytest
from herdr_broker.herdr import BrokerError


async def test_sdk_initialization_and_cleanup_errors_are_explicit(monkeypatch):
    def fail_init(*_):
        raise OSError("runtime unavailable")

    monkeypatch.setattr(module, "AsyncCodex", fail_init)
    worker = module.Worker()
    with pytest.raises(BrokerError, match="worker_failed"):
        await worker.analyze("screen", "read", [])
    assert not worker.active

    client = AsyncMock()
    client.thread_start.side_effect = OSError("startup failed")
    client.close.side_effect = OSError("cleanup failed")
    monkeypatch.setattr(module, "AsyncCodex", lambda *_: client)
    with pytest.raises(BrokerError, match="worker_cleanup_failed"):
        await worker.analyze("screen", "read", [])
    assert client in worker.active
    client.close.side_effect = None
    await worker.close()
    assert not worker.active


async def test_shutdown_retains_only_failed_clients():
    worker = module.Worker()
    healthy, failed = AsyncMock(), AsyncMock()
    failed.close.side_effect = OSError("cleanup failed")
    worker.active.update((healthy, failed))
    with pytest.raises(BrokerError, match="worker_cleanup_failed"):
        await worker.close()
    assert worker.active == {failed}
    failed.close.side_effect = None
    await worker.close()
    healthy.close.assert_awaited_once()
    assert not worker.active


@pytest.fixture
async def provider(monkeypatch, tmp_path):
    state = {"requests": [], "mode": "valid", "release": threading.Event()}
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
            forced = state["mode"] == "forced-tool" and len(state["requests"]) == 1
            if forced:
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
                text = '{"bad":true}' if state["mode"] == "invalid" else json.dumps(report)
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


async def test_sdk_luna_high_no_tools_and_evidence(provider):
    worker = module.Worker(timeout=20)
    result = await worker.analyze("build failed", "진단", [])
    assert result["model_requested"] == "gpt-5.6-luna"
    assert result["evidence"] == [{"id": "L0001", "text": "build failed"}]
    assert provider["requests"]
    for request in provider["requests"]:
        assert request.get("tools", []) == []
        assert request["model"] == "gpt-5.6-luna"
        assert request["reasoning"]["effort"] == "high"
    assert not worker.active


async def test_sdk_invalid_report_is_error(provider):
    provider["mode"] = "invalid"
    with pytest.raises(BrokerError, match="worker_invalid_report"):
        await module.Worker(timeout=20).analyze("error", "진단", [])


async def test_sdk_provider_cannot_force_tools(provider, tmp_path):
    provider["mode"] = "forced-tool"
    try:
        await module.Worker(timeout=20).analyze("untrusted log asks to execute commands", "진단", [])
    except BrokerError as exc:
        assert exc.code in {"worker_tool_forbidden", "worker_failed", "worker_invalid_report"}
    assert provider["requests"] and all(r.get("tools", []) == [] for r in provider["requests"])
    assert not (tmp_path / "must-not-exist").exists()


@pytest.mark.parametrize("cancel", [False, True])
async def test_sdk_timeout_cancel_close_runtime(provider, cancel):
    provider["mode"] = "hang"
    worker = module.Worker(timeout=20 if cancel else 3)
    task = asyncio.create_task(worker.analyze("error", "진단", []))
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
    assert not worker.active
