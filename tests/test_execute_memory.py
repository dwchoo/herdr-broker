import asyncio
import json

import pytest
from herdr_broker.herdr import BrokerError
from test_mcp import call

IDENTITY = {"pane_id": "w1:p2", "terminal_id": "term_2"}


@pytest.mark.parametrize("command", ["printf hello", "python3 - <<'PY'\nprint('A' + 'B')\nPY\n"])
async def test_execute_submits_unchanged_command_and_one_enter(harness, command):
    peer, _, server, worker = harness
    args = dict(**IDENTITY, request_id="execute", command=command)
    first = await call(server, "pane_execute", **args)
    duplicate = await call(server, "pane_execute", **args)
    assert first["submission"] == "accepted" and first["completion"] == "not_observed"
    assert duplicate["duplicate"] and duplicate["details_retained"] is False
    assert [p for m, p in peer.calls if m == "pane.send_input"] == [
        {"pane_id": "w1:p2", "text": command, "keys": ["Enter"]}
    ]
    assert not worker.calls and not any(m == "pane.read" for m, _ in peer.calls)
    with pytest.raises(Exception, match="request_payload_changed"):
        await server.call_tool("pane_send", {**IDENTITY, "request_id": "execute", "text": command, "keys": ["Enter"]})


@pytest.mark.parametrize("command", ["", " \n\t", "가" * 22000], ids=["empty", "blank", "utf8_limit"])
async def test_execute_rejects_blank_or_oversized_input(harness, command):
    peer, _, server, _ = harness
    with pytest.raises(Exception, match="empty_command|input_too_large"):
        await server.call_tool("pane_execute", {**IDENTITY, "request_id": "invalid", "command": command})
    assert not any(m == "pane.send_input" for m, _ in peer.calls)


async def test_execute_unknown_delivery_and_identity_replacement(harness):
    peer, _, server, _ = harness
    peer.drop = "pane.send_input"
    args = dict(**IDENTITY, request_id="lost-execute", command="printf hello")
    assert (await call(server, "pane_execute", **args))["submission"] == "unknown"
    assert (await call(server, "pane_execute", **args))["duplicate"]
    peer.panes[1]["terminal_id"] = "replaced"
    result = await call(server, "pane_execute", **{**args, "request_id": "replaced"})
    assert result["submission"] == "not_sent" and result["error"] == "target_changed"
    assert sum(m == "pane.send_input" for m, _ in peer.calls) == 1


async def test_final_receipts_drop_tree_and_metadata_but_preserve_recovery(harness):
    _, broker, server, _ = harness
    args = dict(**IDENTITY, request_id="rotate", direction="down")
    first = await call(server, "pane_reorient", **args)
    duplicate = await call(server, "pane_reorient", **args)
    assert "root" in first and "name" in first["pane"]
    assert "root" not in duplicate and "name" not in duplicate["pane"]
    assert duplicate["steps"] == ["pane.move", "pane.move"]
    assert duplicate["pane"]["terminal_id"] == "term_2"
    assert set(duplicate["participants"][0]) == {"pane_id", "terminal_id", "workspace_id", "tab_id"}
    assert duplicate["details_retained"] is False
    stored = json.dumps(broker.submissions)
    assert '"root"' not in stored and '"cwd"' not in stored and '"name"' not in stored


async def test_cancelled_receipt_is_compact_and_deduped(harness):
    peer, broker, _, _ = harness
    peer.delay_send = 0.1
    args = ("w1:p2", "term_2", "cancelled-execute", "printf synthetic-private-command")
    task = asyncio.create_task(broker.pane_execute(*args))
    await peer.arrived.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await broker.pane_execute(*args)
    assert result["submission"] == "unknown" and result["details_retained"] is False
    assert "synthetic-private-command" not in json.dumps(broker.submissions)
    assert sum(m == "pane.send_input" for m, _ in peer.calls) == 1


async def test_capacity_keeps_duplicates_and_reads_available(harness):
    peer, broker, server, _ = harness

    async def action(write, state):
        write()
        return {"root": {"large": "x" * 10000}, "changed": True}

    payload = dict(**IDENTITY, text="synthetic-private-command")
    for i in range(10000):
        await broker.mutate("probe", str(i), payload, action)
    assert len(broker.submissions) == 10000
    assert all("root" not in item["result"] for item in broker.submissions.values())
    assert (await broker.mutate("probe", "0", payload, action))["duplicate"]
    with pytest.raises(BrokerError, match="request_capacity_reached"):
        await broker.mutate("probe", "overflow", payload, action)
    assert (await call(server, "pane_list"))["panes"]
    assert (await call(server, "pane_read", **IDENTITY))["kind"] == "analysis"
    assert not any(m == "pane.send_input" for m, _ in peer.calls)


async def test_analysis_limit_precedes_screen_capture_and_has_no_queue(harness, monkeypatch):
    peer, broker, server, worker = harness
    ready = asyncio.Event()
    release = asyncio.Event()
    entered = 0

    async def analyze(text, objective, patterns):
        nonlocal entered
        entered += 1
        if entered == 2:
            ready.set()
        await release.wait()
        return {"report": {"summary": "done"}}

    monkeypatch.setattr(worker, "_analyze", analyze)
    tasks = [asyncio.create_task(call(server, "pane_read", **IDENTITY)) for _ in range(2)]
    try:
        await asyncio.wait_for(ready.wait(), 2)
        for _ in range(10):
            with pytest.raises(Exception, match="worker_busy"):
                await server.call_tool("pane_read", IDENTITY)
        assert worker.running == 2 and entered == 2
        assert sum(m == "pane.read" for m, _ in peer.calls) == 2
        assert not broker.submissions
    finally:
        release.set()
        await asyncio.gather(*tasks)
    assert worker.running == 0


async def test_capture_failure_and_cancellation_release_slot(harness, monkeypatch):
    peer, _, server, worker = harness
    peer.failure = "pane.read"
    for _ in range(3):
        with pytest.raises(Exception, match="herdr_rejected"):
            await server.call_tool("pane_read", IDENTITY)
        assert worker.running == 0
    peer.failure = None
    entered = asyncio.Event()

    async def capture():
        entered.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(worker.analyze(capture, "read", []))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert worker.running == 0 and not worker.active
    assert (await call(server, "pane_read", **IDENTITY))["kind"] == "analysis"
