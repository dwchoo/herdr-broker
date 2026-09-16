import asyncio
import copy
import os
from pathlib import Path

import pytest
from conftest import StubWorker
from herdr_broker.context import CONTEXT_KEYS, Context
from herdr_broker.server import create_server
from herdr_broker.service import Broker
from test_mcp import call

IDENTITY = {"pane_id": "w1:p2", "terminal_id": "term_2"}


async def test_local_context_discovers_workspaces_without_fake_caller(harness, monkeypatch):
    peer, broker, _, _ = harness
    for key in CONTEXT_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(
        "herdr_broker.context.local_settings", lambda: {"herdr_socket": str(broker.herdr.endpoint)}
    )
    context = await Context.load(Path.cwd())
    assert context.caller is context.workspace is context.terminal is None
    server = create_server(Broker(context, StubWorker()))
    result = await call(server, "workspace_list")
    assert result["connection"] == "local" and result["default_workspace_id"] is None
    assert result["workspaces"][0]["workspace_id"] == "w1"
    with pytest.raises(Exception, match="workspace_required"):
        await server.call_tool("pane_list", {})
    assert len((await call(server, "pane_list", workspace_id="w1"))["panes"]) == 3
    assert len((await call(server, "tab_list", workspace_id="w1"))["tabs"]) == 2
    with pytest.raises(Exception, match="workspace_not_found"):
        await server.call_tool("pane_list", {"workspace_id": "missing"})
    assert not any(m.startswith("pane.send") for m, _ in peer.calls)
    # An invalid inherited Herdr context never silently downgrades to local mode.
    monkeypatch.setenv("HERDR_ENV", "1")
    with pytest.raises(Exception, match="herdr_context_required"):
        await Context.load(Path.cwd())


async def test_workspace_selection_metadata_only(harness):
    peer, _, server, worker = harness
    peer.tabs.append(dict(tab_id="w2:t1", workspace_id="w2", label="다른 작업", number=1, pane_count=1))
    peer.panes.append(
        dict(peer.panes[2], pane_id="w2:p1", workspace_id="w2", tab_id="w2:t1", terminal_id="remote_tab")
    )
    result = await call(server, "workspace_list")
    assert len(result["workspaces"]) == 2 and result["caller_pane_id"] == "w1:p1"
    result = await call(server, "pane_list", workspace_id="w2")
    assert len(result["panes"]) == 1 and result["panes"][0]["pane_id"] == "w2:p1"
    assert not worker.calls


async def test_herdr_context_uses_live_tab_after_pane_move(harness, monkeypatch):
    _, broker, _, _ = harness
    monkeypatch.setattr(
        "herdr_broker.context.local_settings", lambda: {"herdr_socket": str(broker.herdr.endpoint)}
    )
    for key, value in {
        "HERDR_ENV": "1",
        "HERDR_PANE_ID": "w1:p1",
        "HERDR_WORKSPACE_ID": "w1",
        "HERDR_TAB_ID": "old-tab",
        "HERDR_SOCKET_PATH": str(broker.herdr.endpoint),
    }.items():
        monkeypatch.setenv(key, value)
    context = await Context.load(Path.cwd())
    assert context.caller == "w1:p1" and context.shell_pid == os.getpid()


async def test_layout_redacts_exported_launch_data(harness):
    peer, _, server, worker = harness
    peer.layouts["w1:t1"]["first"].update(env={"SECRET": "never-return"}, command=["never-return"])
    result = await call(server, "pane_layout", **IDENTITY)
    assert result["root"]["direction"] == "right"
    assert result["panes"][1]["terminal_id"] == "term_2"
    assert "never-return" not in str(result) and not worker.calls


@pytest.mark.parametrize("direction", ["right", "down"])
async def test_split_fresh_shell_focus_and_duplicate(harness, direction):
    peer, _, server, worker = harness
    args = dict(**IDENTITY, request_id="create", direction=direction)
    result = await call(server, "pane_split", **args)
    assert result["submission"] == "accepted" and result["pane"]["terminal_id"] == "term_4"
    assert (await call(server, "pane_split", **args))["duplicate"]
    assert len(peer.panes) == 4 and not worker.calls
    sent = next(p for m, p in peer.calls if m == "pane.split")
    assert sent == {"target_pane_id": "w1:p2", "direction": direction, "ratio": 0.5, "focus": False}
    with pytest.raises(Exception, match="request_payload_changed"):
        await server.call_tool("pane_close", {**IDENTITY, "request_id": "create"})
    new = result["pane"]
    named = await call(
        server, "pane_rename", pane_id=new["pane_id"], terminal_id=new["terminal_id"], numbered=True
    )
    assert named["pane_code"]


async def test_swap_and_close_exact_identity(harness):
    peer, _, server, _ = harness
    result = await call(
        server,
        "pane_swap",
        **IDENTITY,
        target_pane_id="w1:p1",
        target_terminal_id="term_1",
        request_id="swap",
    )
    assert result["changed"] and peer.layouts["w1:t1"]["first"]["pane_id"] == "w1:p2"
    bad = await call(server, "pane_close", pane_id="w1:p2", terminal_id="replaced", request_id="bad")
    assert bad["submission"] == "not_sent" and bad["error"] == "target_changed"
    args = dict(**IDENTITY, request_id="close")
    assert (await call(server, "pane_close", **args))["changed"]
    assert (await call(server, "pane_close", **args))["duplicate"]
    assert all(p["pane_id"] != "w1:p2" for p in peer.panes)
    assert sum(m == "pane.close" for m, _ in peer.calls) == 1


async def test_move_keeps_terminal_and_native_noop(harness):
    peer, _, server, _ = harness
    args = dict(**IDENTITY, target_pane_id="w1:p3", target_terminal_id="term_3", direction="down")
    result = await call(server, "pane_move", **args, request_id="move")
    assert result["changed"] and result["pane"]["tab_id"] == "w1:t2"
    assert result["pane"]["terminal_id"] == "term_2"
    result = await call(server, "pane_move", **args, request_id="noop")
    assert not result["changed"] and result["reason"] == "same_tab"
    assert len(peer.panes) == 3


async def test_reorient_pair_round_trip_preserves_tree_and_terminals(harness):
    peer, _, server, worker = harness
    original = copy.deepcopy(peer.layouts)
    identities = [(p["pane_id"], p["terminal_id"]) for p in peer.panes]
    result = await call(server, "pane_reorient", **IDENTITY, request_id="down", direction="down")
    assert result["submission"] == "accepted" and result["changed"]
    assert peer.layouts["w1:t1"]["direction"] == "down"
    assert result["steps"] == ["pane.move", "pane.move"]
    assert len(peer.tabs) == 2
    assert (await call(server, "pane_reorient", **IDENTITY, request_id="down", direction="down"))["duplicate"]
    await call(server, "pane_reorient", **IDENTITY, request_id="right", direction="right")
    assert peer.layouts == original
    assert identities == [(p["pane_id"], p["terminal_id"]) for p in peer.panes]
    assert not worker.calls and not any(m in {"pane.close", "layout.apply"} for m, _ in peer.calls)


async def test_reorient_nested_pair_only(harness):
    peer, _, server, _ = harness
    result = await call(server, "pane_split", **IDENTITY, request_id="nested", direction="down", ratio=0.3)
    root_before = copy.deepcopy(peer.layouts["w1:t1"])
    rotated = await call(server, "pane_reorient", **IDENTITY, request_id="rotate", direction="right")
    assert rotated["submission"] == "accepted"
    expected = copy.deepcopy(root_before)
    expected["second"]["direction"] = "right"
    assert peer.layouts["w1:t1"] == expected
    result = await call(
        server, "pane_reorient", pane_id="w1:p1", terminal_id="term_1", request_id="group", direction="down"
    )
    assert result["error"] == "sibling_leaf_pair_required" and result["submission"] == "not_sent"


async def test_reorient_partial_reports_stranded_identity_without_cleanup(harness):
    peer, _, server, _ = harness
    peer.fail_move_number = 2
    args = dict(**IDENTITY, request_id="partial", direction="down")
    result = await call(server, "pane_reorient", **args)
    assert result["submission"] == "partial"
    assert result["temporary_tab_id"] == result["pane"]["tab_id"]
    assert result["pane"]["terminal_id"] == "term_2" and len(peer.panes) == 3
    assert (await call(server, "pane_reorient", **args))["duplicate"]
    assert peer.move_count == 2 and not any(m == "pane.close" for m, _ in peer.calls)


async def test_rotation_stops_after_concurrent_layout_change(harness):
    peer, _, server, _ = harness

    def change(peer, moved):
        peer.layouts["w1:t1"] = {
            "type": "split",
            "direction": "down",
            "ratio": 0.5,
            "first": peer.layouts["w1:t1"],
            "second": {"type": "pane", "pane_id": "user-new-pane"},
        }

    peer.after_move = change
    result = await call(server, "pane_reorient", **IDENTITY, request_id="changed", direction="down")
    assert result["submission"] == "partial" and result["error"] == "layout_changed"
    assert peer.move_count == 1


async def test_ack_loss_and_cancel_do_not_repeat_creation(harness):
    peer, _, server, _ = harness
    peer.drop_after = "pane.split"
    args = dict(**IDENTITY, request_id="lost")
    first = await call(server, "pane_split", **args)
    assert first["submission"] == "unknown" and len(peer.panes) == 4
    assert (await call(server, "pane_split", **args))["duplicate"]
    peer.drop_after = None
    peer.delay_send = 0.1
    peer.arrived.clear()
    task = asyncio.create_task(call(server, "pane_split", **IDENTITY, request_id="cancel"))
    await peer.arrived.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await call(server, "pane_split", **IDENTITY, request_id="cancel")
    assert result["submission"] == "unknown" and result["duplicate"]
    assert sum(m == "pane.split" for m, _ in peer.calls) == 2


async def test_zoomed_and_wrong_identity_never_reorient(harness):
    peer, _, server, _ = harness
    peer.zoomed.add("w1:t1")
    result = await call(server, "pane_reorient", **IDENTITY, request_id="zoom", direction="down")
    assert result["error"] == "tab_zoomed" and not peer.move_count
    result = await call(server, "pane_split", pane_id="w1:p2", terminal_id="wrong", request_id="bad")
    assert result["submission"] == "not_sent" and len(peer.panes) == 3


async def test_lost_second_move_ack_is_unknown_and_not_repeated(harness):
    peer, _, server, _ = harness
    peer.drop_move_number = 2
    args = dict(**IDENTITY, request_id="second-ack", direction="down")
    result = await call(server, "pane_reorient", **args)
    assert result["submission"] == "unknown"
    assert result["steps"] == ["pane.move"]
    # The final move happened; the response was lost. The recorded temp location is only last-known.
    assert peer.layouts["w1:t1"]["direction"] == "down"
    assert (await call(server, "pane_reorient", **args))["duplicate"]
    assert peer.move_count == 2 and len(peer.tabs) == 2


@pytest.mark.parametrize("number", [1, 2])
async def test_rotation_rejects_selected_terminal_replaced_during_export(harness, number):
    peer, _, server, _ = harness

    def replace(peer):
        peer.panes[number - 1]["terminal_id"] = "replacement"

    peer.after_export = replace
    result = await call(
        server,
        "pane_reorient",
        pane_id=f"w1:p{number}",
        terminal_id=f"term_{number}",
        request_id="replaced-during-export",
        direction="down",
    )
    assert result["submission"] == "not_sent" and result["error"] == "target_changed"
    assert peer.move_count == 0


async def test_empty_inherited_context_is_not_local_fallback(harness, monkeypatch):
    _, broker, _, _ = harness
    for key in CONTEXT_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(
        "herdr_broker.context.local_settings", lambda: {"herdr_socket": str(broker.herdr.endpoint)}
    )
    monkeypatch.setenv("HERDR_PANE_ID", "")
    with pytest.raises(Exception, match="herdr_context_required"):
        await Context.load(Path.cwd())


async def test_duplicate_inventory_and_invalid_focus_are_errors(harness, monkeypatch):
    peer, broker, server, _ = harness
    peer.panes.append(dict(peer.panes[1], terminal_id="duplicate"))
    with pytest.raises(Exception, match="herdr_invalid_response"):
        await server.call_tool("pane_layout", IDENTITY)
    peer.panes.pop()
    original = broker.herdr.request

    async def bad_focus(method, params, before_write=None):
        response = await original(method, params, before_write)
        if method == "layout.export":
            response["layout"]["focused_pane_id"] = "missing"
        return response

    monkeypatch.setattr(broker.herdr, "request", bad_focus)
    with pytest.raises(Exception, match="herdr_invalid_response"):
        await server.call_tool("pane_layout", IDENTITY)


async def test_layout_annotations_describe_actual_effects(harness):
    _, _, server, _ = harness
    tools = {tool.name: tool for tool in await server.list_tools()}
    for name in ("pane_split", "pane_swap", "pane_move", "pane_reorient"):
        assert tools[name].annotations.destructive_hint is False
        assert tools[name].annotations.read_only_hint is False
    assert tools["pane_close"].annotations.destructive_hint is True


async def test_rotation_rejects_layout_with_nonexistent_sibling(harness):
    peer, _, server, _ = harness
    peer.layouts["w1:t1"] = {
        "type": "split",
        "direction": "down",
        "ratio": 0.5,
        "first": peer.layouts["w1:t1"],
        "second": {"type": "pane", "pane_id": "missing"},
    }
    result = await call(server, "pane_reorient", **IDENTITY, request_id="stale-tree", direction="down")
    assert result["submission"] == "not_sent" and result["error"] == "layout_changed"
    assert peer.move_count == 0


@pytest.mark.parametrize(
    ("tool", "field", "value"),
    [
        ("pane_swap", "focused_pane_id", {}),
        ("pane_swap", "focused_pane_id", ""),
        ("pane_swap", "focused_pane_id", "w1:p1"),
        ("pane_swap", "reason", {}),
        ("pane_swap", "reason", "unsupported"),
        ("pane_move", "reason", "unsupported"),
        ("pane_swap", "reason", "same_pane"),
        ("pane_move", "reason", "same_tab"),
        ("pane_swap", "changed", False),
        ("pane_move", "changed", False),
    ],
)
async def test_invalid_mutation_response_is_unknown_and_never_repeated(harness, monkeypatch, tool, field, value):
    peer, broker, server, _ = harness
    original = broker.herdr.request
    method_name = tool.replace("_", ".")

    async def malformed(method, params, before_write=None):
        response = await original(method, params, before_write)
        if method == method_name:
            response["swap" if tool == "pane_swap" else "move_result"][field] = value
        return response

    monkeypatch.setattr(broker.herdr, "request", malformed)
    target = 1 if tool == "pane_swap" else 3
    args = dict(
        **IDENTITY,
        target_pane_id=f"w1:p{target}",
        target_terminal_id=f"term_{target}",
        request_id="malformed-response",
    )
    result = await call(server, tool, **args)
    assert result["submission"] == "unknown" and result["error"] == "herdr_invalid_response"
    assert (await call(server, tool, **args))["duplicate"]
    assert sum(method == method_name for method, _ in peer.calls) == 1


async def test_same_pane_swap_preserves_native_noop(harness):
    _, _, server, _ = harness
    result = await call(
        server,
        "pane_swap",
        **IDENTITY,
        target_pane_id=IDENTITY["pane_id"],
        target_terminal_id=IDENTITY["terminal_id"],
        request_id="same-pane",
    )
    assert result["submission"] == "accepted"
    assert result["changed"] is False and result["reason"] == "same_pane"
