import asyncio
import copy
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from herdr_broker.context import Context
from herdr_broker.herdr import BrokerError, Herdr
from herdr_broker.server import create_server
from herdr_broker.service import Broker
from herdr_broker.worker import Worker


def pane(number, tab="w1:t1", **extra):
    return dict(
        pane_id=f"w1:p{number}",
        terminal_id=f"term_{number}",
        workspace_id="w1",
        tab_id=tab,
        label=f"{1000 + number} · 테스트",
        cwd="/tmp",
        agent_status="idle",
        **extra,
    )


class StubWorker(Worker):
    def __init__(self):
        super().__init__()
        self.calls = []
        self.error = None

    async def _initialize(self):
        self.runtime = SimpleNamespace(unsubscribe=AsyncMock(), close=AsyncMock())

    async def _analyze(self, text, objective, patterns, effort, timings, session, purpose, service_tier):
        self.calls.append((text, objective))
        if self.error:
            raise BrokerError(self.error)
        return {"analysis_id": session.id, "purpose": purpose, "effort": effort, "service_tier_requested": service_tier, "report": {"summary": "화면 확인", "findings": [], "next_checks": [], "uncertainties": []}}


class Peer:
    def __init__(self):
        self.panes = [pane(1, agent="codex"), pane(2), pane(3, "w1:t2", agent="codex")]
        self.tabs = [
            dict(tab_id=f"w1:t{i}", workspace_id="w1", label=f"탭 {i}", number=i, pane_count=2)
            for i in (1, 2)
        ]
        self.calls = []
        self.text = "build failed\nTS2305 missing export"
        self.drop = None
        self.failure = None
        self.failure_code = "synthetic_failure"
        self.process_overrides = {}
        self.read_overrides = {}
        self.layouts = {
            "w1:t1": {
                "type": "split",
                "direction": "right",
                "ratio": 0.5,
                "first": {"type": "pane", "pane_id": "w1:p1"},
                "second": {"type": "pane", "pane_id": "w1:p2"},
            },
            "w1:t2": {"type": "pane", "pane_id": "w1:p3"},
        }
        self.zoomed = set()
        self.next_pane = 4
        self.next_tab = 3
        self.drop_after = None
        self.drop_move_number = None
        self.fail_move_number = None
        self.move_count = 0
        self.after_move = None
        self.after_export = None
        self.delay_send = 0
        self.arrived = asyncio.Event()
        self.handlers = set()

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        try:
            request = json.loads(await reader.readline())
            method, params = request["method"], request["params"]
            self.calls.append((method, params))
            if method in {"pane.send_input", "pane.split", "pane.close", "pane.swap", "pane.move"}:
                self.arrived.set()
                await asyncio.sleep(self.delay_send)
            if self.drop == method:
                return
            error = None
            current = next(
                (
                    p
                    for p in self.panes
                    if p["pane_id"] == params.get("pane_id", params.get("target_pane_id"))
                ),
                None,
            )
            if self.failure == method:
                error = {"code": self.failure_code}
            elif method == "ping":
                result = {"type": "pong", "version": "0.9.0", "protocol": 22}
            elif method == "workspace.list":
                result = {
                    "type": "workspace_list",
                    "workspaces": [
                        dict(
                            workspace_id=w,
                            number=i + 1,
                            label=f"Workspace {i + 1}",
                            focused=i == 0,
                            pane_count=len([p for p in self.panes if p["workspace_id"] == w]),
                            tab_count=len([t for t in self.tabs if t["workspace_id"] == w]),
                            active_tab_id=next(t["tab_id"] for t in self.tabs if t["workspace_id"] == w),
                        )
                        for i, w in enumerate(dict.fromkeys(t["workspace_id"] for t in self.tabs))
                    ],
                }
            elif method == "pane.list":
                result = {
                    "type": "pane_list",
                    "panes": [p for p in self.panes if p["workspace_id"] == params["workspace_id"]],
                }
            elif method == "tab.list":
                result = {
                    "type": "tab_list",
                    "tabs": [t for t in self.tabs if t["workspace_id"] == params["workspace_id"]],
                }
            elif method == "tab.rename":
                tab = next(t for t in self.tabs if t["tab_id"] == params["tab_id"])
                tab["label"] = params["label"]
                result = {"type": "tab_info", "tab": tab}
            elif method == "pane.swap":
                a, b = params["source_pane_id"], params["target_pane_id"]
                source = next(p for p in self.panes if p["pane_id"] == a)
                tree = self.layouts[source["tab_id"]]

                def swap(node):
                    if node["type"] == "pane":
                        node["pane_id"] = (
                            b if node["pane_id"] == a else a if node["pane_id"] == b else node["pane_id"]
                        )
                    else:
                        swap(node["first"])
                        swap(node["second"])

                swap(tree)
                result = {
                    "type": "pane_swap",
                    "swap": {
                        "changed": a != b,
                        "reason": "same_pane" if a == b else None,
                        "source_pane_id": a,
                        "target_pane_id": b,
                        "focused_pane_id": a,
                    },
                }
            elif not current:
                error = {"code": "pane_not_found"}
            elif method == "pane.get":
                result = {"type": "pane_info", "pane": current}
            elif method == "pane.process_info":
                result = {
                    "type": "pane_process_info",
                    "process_info": {
                        "pane_id": current["pane_id"],
                        "shell_pid": os.getpid(),
                        "foreground_processes": self.process_overrides.get(
                            current["pane_id"], [{"name": "zsh"}]
                        ),
                    },
                }
            elif method == "pane.read":
                result = {
                    "type": "pane_read",
                    "read": {
                        **{k: current[k] for k in ("pane_id", "workspace_id", "tab_id")},
                        "text": self.text,
                        "revision": 1,
                        "truncated": False,
                        "source": "recent_unwrapped",
                        "format": "ansi",
                        **self.read_overrides,
                    },
                }
            elif method == "pane.rename":
                current["label"] = params["label"]
                result = {"type": "pane_info", "pane": current}
            elif method == "pane.send_input":
                result = {"type": "ok"}
            elif method == "layout.export":
                result = {
                    "type": "layout_export",
                    "layout": {
                        "workspace_id": current["workspace_id"],
                        "tab_id": current["tab_id"],
                        "zoomed": current["tab_id"] in self.zoomed,
                        "focused_pane_id": current["pane_id"],
                        "root": copy.deepcopy(self.layouts[current["tab_id"]]),
                    },
                }
                if self.after_export:
                    self.after_export(self)
            elif method == "pane.split":
                created = pane(self.next_pane, current["tab_id"])
                created["label"] = None
                self.next_pane += 1
                self.panes.append(created)
                self.insert(current, created, params["direction"], params["ratio"])
                result = {"type": "pane_info", "pane": created}
            elif method == "pane.close":
                self.detach(current)
                self.panes.remove(current)
                result = {"type": "ok"}
            elif method == "pane.move":
                self.move_count += 1
                if self.move_count == self.fail_move_number:
                    error = {"code": "target_pane_not_found"}
                else:
                    dest = params["destination"]
                    same = dest["type"] == "tab" and dest["tab_id"] == current["tab_id"]
                    zoomed = current["tab_id"] in self.zoomed or dest.get("tab_id") in self.zoomed
                    changed = not same and not zoomed
                    if changed:
                        self.detach(current)
                        if dest["type"] == "new_tab":
                            tab_id = f"w1:t{self.next_tab}"
                            self.next_tab += 1
                            self.tabs.append(
                                dict(
                                    tab_id=tab_id,
                                    workspace_id=current["workspace_id"],
                                    label="temporary",
                                    number=self.next_tab,
                                    pane_count=1,
                                )
                            )
                            current["tab_id"] = tab_id
                            self.layouts[tab_id] = {"type": "pane", "pane_id": current["pane_id"]}
                        else:
                            target = next(p for p in self.panes if p["pane_id"] == dest["target_pane_id"])
                            current["tab_id"] = target["tab_id"]
                            self.insert(target, current, dest["split"], dest["ratio"])
                    result = {
                        "type": "pane_move",
                        "move_result": {
                            "changed": changed,
                            "reason": "same_tab" if same else "zoomed_tab" if zoomed else None,
                            "previous_pane_id": current["pane_id"],
                            "pane": copy.deepcopy(current),
                        },
                    }
                    if self.after_move:
                        self.after_move(self, current)
            else:
                error = {"code": "method_not_found"}
            if self.drop_after == method or (method == "pane.move" and self.move_count == self.drop_move_number):
                return
            response = {"id": request["id"], **({"error": error} if error else {"result": result})}
            writer.write(json.dumps(response).encode() + b"\n")
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            self.handlers.discard(task)

    def detach(self, pane):
        def remove(node):
            if node["type"] == "pane":
                return None if node["pane_id"] == pane["pane_id"] else node
            a, b = remove(node["first"]), remove(node["second"])
            return b if a is None else a if b is None else {**node, "first": a, "second": b}

        tree = remove(self.layouts[pane["tab_id"]])
        if tree is None:
            self.layouts.pop(pane["tab_id"])
            self.tabs = [t for t in self.tabs if t["tab_id"] != pane["tab_id"]]
        else:
            self.layouts[pane["tab_id"]] = tree

    def insert(self, target, new, direction, ratio):
        def add(node):
            if node["type"] == "pane":
                return (
                    {
                        "type": "split",
                        "direction": direction,
                        "ratio": ratio,
                        "first": node,
                        "second": {"type": "pane", "pane_id": new["pane_id"]},
                    }
                    if node["pane_id"] == target["pane_id"]
                    else node
                )
            return {**node, "first": add(node["first"]), "second": add(node["second"])}

        self.layouts[target["tab_id"]] = add(self.layouts[target["tab_id"]])


@asynccontextmanager
async def peer_server(path):
    peer = Peer()
    server = await asyncio.start_unix_server(peer.handle, path=str(path))
    try:
        yield peer
    finally:
        server.close()
        await server.wait_closed()
        for task in tuple(peer.handlers):
            task.cancel()
        await asyncio.gather(*peer.handlers, return_exceptions=True)


@pytest.fixture
def socket_path():
    with TemporaryDirectory(prefix="hb-test-", dir="/tmp") as directory:
        yield Path(directory) / "h.sock"


@pytest.fixture
async def harness(tmp_path, socket_path):
    async with peer_server(socket_path) as peer:
        herdr = Herdr(socket_path, timeout=0.3)
        context = Context(herdr, tmp_path, "w1", "w1:p1", "term_1", os.getpid(), ["synthetic-secret"])
        # Context project check stays real; the peer is a test-only protocol server.
        context.project = Path.cwd()
        worker = StubWorker()
        broker = Broker(context, worker)
        try:
            yield peer, broker, create_server(broker), worker
        finally:
            await worker.close()


@pytest.fixture
def sdk_home(tmp_path, monkeypatch):
    source = tmp_path / "source-codex"
    source.mkdir()
    (source / "auth.json").write_text("{}")  # Local peer needs no real credentials.
    (source / "AGENTS.md").write_text("PARENT_ONLY_INSTRUCTIONS")
    (source / "config.toml").write_text('developer_instructions="PARENT_CONFIG_INSTRUCTIONS"\nservice_tier="fast"\n[features]\nfast_mode=false\n')
    (source / "models_cache.json").write_text(json.dumps({"models": [{
        "slug": "gpt-5.6-luna", "display_name": "Probe", "description": None,
        "supported_reasoning_levels": [], "shell_type": "unified_exec",
        "visibility": "list", "supported_in_api": True, "priority": 1,
        "service_tiers": [{"id": "priority", "name": "Fast", "description": "Probe"}],
        "support_verbosity": False, "truncation_policy": {"mode": "bytes", "limit": 10000},
        "experimental_supported_tools": [], "base_instructions": "Synthetic provider test.",
        "tool_mode": "code_mode_only", "apply_patch_tool_type": "freeform", "supports_search_tool": True,
    }]}))
    monkeypatch.setenv("CODEX_HOME", str(source))
    return source
