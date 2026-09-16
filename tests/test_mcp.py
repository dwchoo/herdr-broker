import asyncio
import json

import pytest
from conftest import pane
from herdr_broker.herdr import BrokerError


async def call(server, tool_name, **arguments):
    result = await server.call_tool(tool_name, arguments)
    if result.is_error:
        raise AssertionError(result)
    return result.structured_content or json.loads(result.content[0].text)


@pytest.mark.asyncio
async def test_inventory_metadata_only_and_all_roles(harness):
    peer, broker, server, worker = harness
    tools = await server.list_tools()
    assert {t.name for t in tools} == {
        "tab_list",
        "pane_list",
        "pane_read", "pane_excerpt", "analysis_release",
        "pane_send",
        "pane_execute",
        "pane_rename",
        "tab_rename",
        "workspace_list", "pane_layout", "pane_split", "pane_close", "pane_swap", "pane_move", "pane_reorient",
    }
    result = await call(server, "pane_list")
    assert [p["role"] for p in result["panes"]] == ["caller", "terminal", "agent"]
    assert result["panes"][2]["tab_id"] == "w1:t2"
    assert all(p["can_operate"] for p in result["panes"])
    assert not worker.calls and not broker.submissions
    assert {m for m, _ in peer.calls} <= {"pane.list", "pane.get", "pane.process_info"}
    assert len((await call(server, "tab_list"))["tabs"]) == 2


async def test_pagination_duplicates_and_no_fuzzy_resolver(harness):
    peer, _, server, _ = harness
    peer.panes += [pane(i) for i in range(4, 40)]
    peer.panes[1]["label"] = peer.panes[2]["label"] = "1234 · 빌드"
    first = await call(server, "pane_list")
    second = await call(server, "pane_list", offset=first["next_offset"])
    assert len(first["panes"]) == 32 and first["truncated"]
    assert len(second["panes"]) == 7 and not second["truncated"]
    assert first["panes"][1]["pane_code"] == first["panes"][2]["pane_code"] == "1234"
    failure = await call(server, "pane_send", pane_id="123", terminal_id="term_2", request_id="a", text="x")
    assert failure["submission"] == "not_sent"
    assert not any(m == "pane.send_input" for m, _ in peer.calls)


async def test_short_output_worker_raw_and_failure(harness):
    peer, _, server, worker = harness
    peer.text = "ok"
    args = dict(pane_id="w1:p2", terminal_id="term_2")
    read = await call(server, "pane_read", **args)
    assert read["kind"] == "analysis" and len(worker.calls) == 1
    raw = await call(server, "pane_read", **args, raw=True)
    assert raw["text"] == "ok" and len(worker.calls) == 1
    worker.error = "worker_failed"
    with pytest.raises(Exception, match="worker_failed"):
        await server.call_tool("pane_read", args)
    assert not any(method == "pane.send_input" for method, _ in peer.calls)


async def test_raw_bounds_unicode_and_redaction(harness):
    peer, _, server, worker = harness
    peer.text = "가" * 40000 + "\npassword=synthetic-secret\n\x1b[31m오류\x1b[0m"
    result = await call(server, "pane_read", pane_id="w1:p2", terminal_id="term_2", raw=True)
    assert len(result["text"].encode()) <= 8192 and result["truncated"]
    assert result["next_offset"] and not worker.calls
    await call(server, "pane_read", pane_id="w1:p2", terminal_id="term_2")
    assert "synthetic-secret" not in worker.calls[0][0] and "\x1b" not in worker.calls[0][0]


@pytest.mark.parametrize("invalid", [
    {"source": "viewport"}, {"format": "other"}, {"revision": None},
    {"revision": True}, {"revision": -1}, {"revision": "1"}, {"truncated": "false"},
])
async def test_invalid_read_metadata_never_reaches_worker(harness, invalid):
    peer, _, server, worker = harness
    peer.read_overrides = invalid
    with pytest.raises(Exception, match="herdr_invalid_response"):
        await server.call_tool("pane_read", {"pane_id": "w1:p2", "terminal_id": "term_2"})
    assert not worker.calls


async def test_exact_input_dedupe_changed_payload(harness):
    peer, _, server, _ = harness
    args = dict(pane_id="w1:p2", terminal_id="term_2", request_id="same", text="echo 안녕", keys=[])
    first = await call(server, "pane_send", **args)
    duplicate = await call(server, "pane_send", **args)
    assert first["submission"] == "accepted" and first["completion"] == "not_observed"
    assert duplicate["duplicate"]
    sends = [p for m, p in peer.calls if m == "pane.send_input"]
    assert sends == [{"pane_id": "w1:p2", "text": "echo 안녕", "keys": []}]
    with pytest.raises(Exception, match="request_payload_changed"):
        await server.call_tool("pane_send", {**args, "text": "changed"})


async def test_duplicate_inflight_unknown_ack_and_cancellation(harness):
    peer, broker, _, _ = harness
    peer.delay_send = 0.1
    args = ("w1:p2", "term_2", "inflight", "echo hi", ["Enter"])
    task = asyncio.create_task(broker.pane_send(*args))
    await peer.arrived.wait()
    assert (await broker.pane_send(*args))["submission"] == "pending"
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert (await broker.pane_send(*args))["submission"] == "unknown"
    peer.drop = "pane.send_input"
    lost = ("w1:p2", "term_2", "lost", "echo hi", ["Enter"])
    assert (await broker.pane_send(*lost))["submission"] == "unknown"
    assert (await broker.pane_send(*lost))["duplicate"]
    assert len([m for m, _ in peer.calls if m == "pane.send_input"]) == 2


async def test_replacement_movement_caller_change(harness):
    peer, broker, server, _ = harness
    peer.panes[1]["terminal_id"] = "replaced"
    result = await call(
        server, "pane_send", pane_id="w1:p2", terminal_id="term_2", request_id="old", text="x"
    )
    assert result["submission"] == "not_sent" and result["error"] == "target_changed"
    peer.panes[1]["workspace_id"] = "w2"
    peer.panes[1]["pane_id"] = "w2:p2"
    with pytest.raises(BrokerError, match="herdr_rejected"):
        await broker.pane_read("w1:p2", "replaced", "read", True, 0)
    peer.panes[0]["terminal_id"] = "new-caller"
    with pytest.raises(Exception, match="herdr_context_changed"):
        await server.call_tool("pane_list", {})
    assert not any(m == "pane.send_input" for m, _ in peer.calls)


async def test_failure_is_not_empty_inventory(harness):
    peer, _, server, _ = harness
    peer.failure = "pane.list"
    with pytest.raises(Exception):
        await server.call_tool("pane_list", {})
    peer.failure = "pane.process_info"
    # Caller process verification must also fail, rather than authorize a stale caller.
    with pytest.raises(Exception):
        await server.call_tool("pane_list", {})


@pytest.mark.parametrize("processes", [None, "zsh", {}, [None], [{"name": 42}]])
async def test_invalid_process_metadata_is_unavailable_row(harness, processes):
    peer, _, server, _ = harness
    peer.process_overrides["w1:p2"] = processes
    result = await call(server, "pane_list")
    assert len(result["panes"]) == 3
    assert result["panes"][1]["process_status"] == "unavailable"
    assert result["panes"][1]["process_error"] == "herdr_invalid_response"
    assert result["panes"][0]["process_status"] == "checked"


async def test_known_enqueue_failure_is_rejected_without_replay(harness):
    peer, _, server, _ = harness
    peer.failure = "pane.send_input"
    peer.failure_code = "pane_send_failed"
    args = dict(pane_id="w1:p2", terminal_id="term_2", request_id="rejected", text="echo hi")
    assert (await call(server, "pane_send", **args))["submission"] == "rejected"
    assert (await call(server, "pane_send", **args))["duplicate"]
    assert len([m for m, _ in peer.calls if m == "pane.send_input"]) == 1


async def test_names_live_in_herdr_and_survive_new_broker(harness):
    from herdr_broker.service import Broker

    peer, broker, server, worker = harness
    peer.panes[1]["label"] = "서버"
    result = await call(server, "pane_rename", pane_id="w1:p2", terminal_id="term_2", numbered=True)
    assert result["name"] == "1000 · 서버"
    result = await call(
        server, "pane_rename", pane_id="w1:p2", terminal_id="term_2", name="빌드", numbered=True
    )
    assert result["name"] == "1000 · 빌드"
    restarted = Broker(broker.context, worker)
    assert (await restarted.pane_list(None, 0))["panes"][1]["pane_code"] == "1000"
    assert not restarted.submissions
    await call(server, "tab_rename", tab_id="w1:t2", name="작업")
    assert peer.tabs[1]["label"] == "작업"
    assert not any(m in {"pane.split", "pane.close", "pane.move", "layout.apply"} for m, _ in peer.calls)
