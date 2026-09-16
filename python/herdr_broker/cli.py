from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import signal
import stat
import sys
import tempfile
import tomllib
from importlib.metadata import distribution
from pathlib import Path
from typing import Any

from .context import CONTEXT_KEYS, Context, project_path
from .herdr import BrokerError
from .server import create_server
from .service import Broker
from .worker import Worker

START = "# herdr-broker project MCP: begin"
END = "# herdr-broker project MCP: end"


def setup(project: Path) -> dict[str, Any]:
    root = project_path(project)
    uv = shutil.which("uv")
    if not uv:
        raise BrokerError("uv_required")
    directory = root / ".codex"
    if directory.is_symlink():
        raise BrokerError("project_config_invalid")
    directory.mkdir(exist_ok=True)
    path = directory / "config.toml"
    original = ""
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise BrokerError("project_config_invalid")
        original = path.read_text()
    try:
        parsed = tomllib.loads(original)
    except tomllib.TOMLDecodeError as exc:
        raise BrokerError("project_config_invalid") from exc
    if START not in original and "herdr_broker" in parsed.get("mcp_servers", {}):
        raise BrokerError("project_mcp_already_configured")
    # Checkout setup follows uv.lock; installed packages retain their installation source.
    checkout = (root / "python/herdr_broker/cli.py").resolve() == Path(__file__).resolve()
    command = uv
    if checkout:
        args = ["run", "--locked", "--project", str(root), "herdr-broker"]
    else:
        package = distribution("herdr-broker")
        direct = json.loads(package.read_text("direct_url.json") or "{}")
        source = direct.get("url", "herdr-broker==" + package.version)
        vcs = direct.get("vcs_info")
        if vcs:
            source = "git+" + source + "@" + vcs["commit_id"]
        args = ["tool", "run", "--from", source, "herdr-broker"]
    args += ["mcp", "--project", str(root)]
    block = (
        f"{START}\n[mcp_servers.herdr_broker]\ncommand = {json.dumps(command)}\n"
        f"args = {json.dumps(args)}\ncwd = {json.dumps(str(root))}\nenabled = true\n"
        f"env_vars = {json.dumps(CONTEXT_KEYS)}\n{END}\n"
    )
    if START in original or END in original:
        if (
            original.count(START) != 1
            or original.count(END) != 1
            or original.index(END) < original.index(START)
        ):
            raise BrokerError("project_config_invalid")
        prefix, tail = original.split(START)
        _, suffix = tail.split(END)
        updated = prefix + block + suffix.removeprefix("\n")
    else:
        updated = original + ("\n" if original and not original.endswith("\n") else "") + block
    tomllib.loads(updated)
    if updated != original:
        fd, staging = tempfile.mkstemp(prefix=".broker-", dir=directory)
        try:
            with os.fdopen(fd, "w") as output:
                output.write(updated)
                output.flush()
                os.fsync(output.fileno())
            if (path.read_text() if path.exists() else "") != original or path.is_symlink():
                raise BrokerError("project_config_changed")
            os.replace(staging, path)
        finally:
            Path(staging).unlink(missing_ok=True)
    return {
        "project_config": str(path),
        "next": "Start a new Codex in this project's Herdr shell and invoke $broker.",
    }


async def serve(project: Path) -> None:
    context = await Context.load(project)
    worker = Worker()
    server = create_server(Broker(context, worker))
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    if task:
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, task.cancel)
    try:
        await server.run_stdio_async()
    finally:
        await worker.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Direct Herdr pane MCP; approvals belong to the Parent Codex."
    )
    parser.add_argument("command", choices=["mcp", "setup", "check"])
    parser.add_argument("--project", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "setup":
            print(json.dumps(setup(args.project)))
        elif args.command == "check":
            context = asyncio.run(Context.load(args.project))
            print(json.dumps({"ok": True, "workspace_id": context.workspace, "pane_id": context.caller}))
        else:
            asyncio.run(serve(args.project))
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    except (BrokerError, OSError, ValueError) as exc:
        print(f"broker: {exc.code if isinstance(exc, BrokerError) else 'startup_failed'}", file=sys.stderr)
        sys.exit(1)
