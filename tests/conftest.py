import asyncio
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

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

    async def analyze(self, text, objective, patterns):
        self.calls.append((text, objective))
        if self.error:
            raise BrokerError(self.error)
        return {"report": {"summary": "화면 확인", "findings": [], "next_checks": [], "uncertainties": []}}


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
            if method == "pane.send_input":
                self.arrived.set()
                await asyncio.sleep(self.delay_send)
            if self.drop == method:
                return
            error = None
            current = next((p for p in self.panes if p["pane_id"] == params.get("pane_id")), None)
            if self.failure == method:
                error = {"code": self.failure_code}
            elif method == "ping":
                result = {"type": "pong", "version": "0.9.0", "protocol": 22}
            elif method == "pane.list":
                result = {"type": "pane_list", "panes": self.panes}
            elif method == "tab.list":
                result = {"type": "tab_list", "tabs": self.tabs}
            elif method == "tab.rename":
                tab = next(t for t in self.tabs if t["tab_id"] == params["tab_id"])
                tab["label"] = params["label"]
                result = {"type": "tab_info", "tab": tab}
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
                        "foreground_processes": self.process_overrides.get(current["pane_id"], [{"name": "zsh"}]),
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
            else:
                error = {"code": "method_not_found"}
            response = {"id": request["id"], **({"error": error} if error else {"result": result})}
            writer.write(json.dumps(response).encode() + b"\n")
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()
            self.handlers.discard(task)


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
        yield peer, broker, create_server(broker), worker
