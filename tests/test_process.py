import asyncio
import json
import os
import sys
import tomllib
from pathlib import Path

import pytest
from herdr_broker.cli import END, START, setup
from herdr_broker.context import CONTEXT_KEYS, Context, is_descendant
from herdr_broker.herdr import BrokerError
from mcp.client import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[1]


async def test_public_stdio_tools_and_no_database(tmp_path):
    params = StdioServerParameters(
        command=sys.executable, args=[str(ROOT / "tests/stdio_fixture.py")], cwd=tmp_path
    )
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as client:
            await client.initialize()
            tools = (await client.list_tools()).tools
            assert len(tools) == 15
            result = await client.call_tool("pane_list", {})
            assert not result.is_error and len(result.structured_content["panes"]) == 3
            args = {"pane_id": "w1:p2", "terminal_id": "term_2", "request_id": "stdio", "text": "echo hi"}
            first = await client.call_tool("pane_send", args)
            again = await client.call_tool("pane_send", args)
            assert first.structured_content["submission"] == "accepted"
            assert again.structured_content["duplicate"]
            changed = await client.call_tool("pane_send", {**args, "text": "different"})
            assert changed.is_error
    assert list(tmp_path.iterdir()) == []


async def test_production_partial_herdr_context_rejected():
    env = {k: v for k, v in os.environ.items() if k not in CONTEXT_KEYS}
    env["HERDR_ENV"] = "1"
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "herdr_broker",
        "mcp",
        "--project",
        str(ROOT),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await process.communicate()
    assert process.returncode == 1 and not out
    assert b"herdr_context_required" in err


def test_process_ancestry_rejects_copied_env_and_other_user():
    rows = "100 90 501\n90 50 501\n50 1 501\n200 1 501\n"
    assert is_descendant(rows, 100, 50, 501)
    assert not is_descendant(rows, 100, 200, 501)
    assert not is_descendant(rows, 100, 50, 502)
    assert not is_descendant("100 90 501\n90 100 501", 100, 50, 501)


async def test_project_boundary_and_missing_context(tmp_path, monkeypatch):
    with pytest.raises(BrokerError, match="project_context_required"):
        await Context.load(tmp_path)
    monkeypatch.setenv("HERDR_ENV", "1")
    monkeypatch.delenv("HERDR_PANE_ID", raising=False)
    with pytest.raises(BrokerError, match="herdr_context_required"):
        await Context.load(ROOT)


def test_setup_preserves_approval_and_other_settings(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    folder = tmp_path / ".codex"
    folder.mkdir()
    path = folder / "config.toml"
    original = (
        'approval_policy = "never"\nmodel = "gpt-5.6-luna"\n\n'
        + START
        + '\n[mcp_servers.herdr_broker]\ncommand="node"\n'
        + END
        + '\n\n[mcp_servers.other]\ncommand="existing"\n'
    )
    path.write_text(original)
    setup(tmp_path)
    first = path.read_text()
    result = tomllib.loads(first)
    assert result["approval_policy"] == "never"
    assert result["mcp_servers"]["other"]["command"] == "existing"
    assert result["mcp_servers"]["herdr_broker"]["command"].endswith("uv")
    setup(tmp_path)
    assert path.read_text() == first


def test_setup_no_approval_added_and_rejects_unmanaged(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    setup(tmp_path)
    path = tmp_path / ".codex/config.toml"
    assert "approval_policy" not in path.read_text()
    path.write_text('[mcp_servers.herdr_broker]\ncommand="custom"\n')
    with pytest.raises(BrokerError, match="project_mcp_already_configured"):
        setup(tmp_path)
    assert "custom" in path.read_text()


def test_setup_rejects_symlink(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    actual = tmp_path / "actual"
    actual.mkdir()
    (tmp_path / ".codex").symlink_to(actual, target_is_directory=True)
    with pytest.raises(BrokerError, match="project_config_invalid"):
        setup(tmp_path)
    assert list(actual.iterdir()) == []


@pytest.mark.parametrize("termination", ["eof", "term", "int", "kill", "early_term", "term_eof"])
async def test_sdk_warmup_does_not_block_mcp_and_child_exits(tmp_path, termination):
    import signal
    from time import perf_counter

    pid_file = tmp_path / "sdk.pid"
    process = await asyncio.create_subprocess_exec(
        sys.executable, "tests/sdk_stdio_fixture.py", str(pid_file),
        *(["early"] if termination == "early_term" else []),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    sdk_pid = None
    try:
        start = perf_counter()
        process.stdin.write((json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {},
            "clientInfo": {"name": "ownership-probe", "version": "1"},
        }}) + "\n").encode())
        await process.stdin.drain()
        response = json.loads(await asyncio.wait_for(process.stdout.readline(), 3))
        assert response["id"] == 1 and "result" in response
        assert perf_counter() - start < 3
        for _ in range(300):
            if pid_file.exists():
                break
            await asyncio.sleep(0.05)
        sdk_pid = int(pid_file.read_text())
        if termination == "eof":
            process.stdin.close()
        else:
            process.send_signal(signal.SIGKILL if termination == "kill" else
                                signal.SIGINT if termination == "int" else signal.SIGTERM)
            if termination == "term_eof":
                process.stdin.close()
        await asyncio.wait_for(process.wait(), 8)
        for _ in range(100):
            try:
                os.kill(sdk_pid, 0)
            except ProcessLookupError:
                break
            await asyncio.sleep(0.05)
        else:
            pytest.fail("Owned SDK survived MCP exit")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
        if sdk_pid is not None:
            try:
                os.kill(sdk_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
