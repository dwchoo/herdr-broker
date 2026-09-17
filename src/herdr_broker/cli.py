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
from typing import Any, get_args

from .context import CONTEXT_KEYS, Context, project_path
from .herdr import BrokerError
from .options import Effort, FastMode, LengthMode, WorkerOptions, export_templates
from .server import create_server
from .service import Broker
from .worker import Worker

START = "# herdr-broker project MCP: begin"
END = "# herdr-broker project MCP: end"


def setup(project: Path, source: str | None = None, options: WorkerOptions | None = None) -> dict[str, Any]:
    root = project_path(project)
    options = options or WorkerOptions()
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
    checkout = (root / "src/herdr_broker/cli.py").resolve() == Path(__file__).resolve()
    command = uv
    if checkout and source is None:
        args = ["run", "--locked", "--project", str(root), "herdr-broker"]
    else:
        if source is None:
            package = distribution("herdr-broker")
            direct = json.loads(package.read_text("direct_url.json") or "{}")
            source = direct.get("url", "herdr-broker==" + package.version)
            vcs = direct.get("vcs_info")
            if vcs:
                source = "git+" + source + "@" + (vcs.get("requested_revision") or vcs["commit_id"])
        command = shutil.which("uvx") or ""
        if not command:
            raise BrokerError("uvx_required")
        args = ["--from", source, "herdr-broker"]
    args += ["mcp", "--project", str(root), *options.arguments()]
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
        "next": "Start a new Codex in this project and invoke $broker. Outside Herdr, select a workspace from workspace_list.",
    }


async def serve(project: Path, options: WorkerOptions | None = None) -> None:
    context = await Context.load(project)
    worker = Worker(options=options)
    broker = Broker(context, worker)
    server = create_server(broker)
    await run_stdio(server, worker, broker)


async def run_stdio(server: Any, worker: Worker, broker: Broker | None = None) -> None:
    loop = asyncio.get_running_loop()
    stopping: asyncio.Task[None] | None = None
    cleanup: asyncio.Task[None] | None = None

    def begin_cleanup() -> asyncio.Task[None]:
        nonlocal cleanup
        if cleanup is None:
            if broker is not None:
                broker.observations.close()
            cleanup = asyncio.create_task(worker.close())
        return cleanup

    async def stop(sig: signal.Signals) -> None:
        try:
            await asyncio.shield(begin_cleanup())
        except Exception as exc:
            print(f"broker: {exc.code if isinstance(exc, BrokerError) else 'shutdown_failed'}",
                  file=sys.stderr, flush=True)
        finally:
            # The pinned MCP transport can remain blocked in a stdin reader thread
            # after cancellation. Reapply the requested signal only after SDK cleanup.
            loop.remove_signal_handler(sig)
            signal.signal(sig, signal.SIG_DFL)
            os.kill(os.getpid(), sig)

    def request_stop(sig: signal.Signals) -> None:
        nonlocal stopping
        if stopping is None:
            stopping = asyncio.create_task(stop(sig))

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, request_stop, sig)
    worker.warmup()
    try:
        await server.run_stdio_async()
    finally:
        await asyncio.shield(begin_cleanup())
        if stopping is not None:
            await asyncio.shield(stopping)
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(sig)


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Direct Herdr pane MCP; approvals belong to the Parent Codex."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("mcp", "setup", "check"):
        sub = commands.add_parser(command, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
        sub.add_argument("--project", type=Path, required=True)
        if command == "check":
            continue
        defaults = WorkerOptions()
        for purpose in ("analysis", "status"):
            sub.add_argument(f"--{purpose}-model", default=getattr(defaults, f"{purpose}_model"),
                             help=f"{purpose} Worker model")
            sub.add_argument(f"--{purpose}-effort", choices=get_args(Effort),
                             default=getattr(defaults, f"{purpose}_effort"), help=f"{purpose} reasoning effort")
        sub.add_argument("--response-length-mode", choices=get_args(LengthMode), default="medium",
                         help="Analysis response budget")
        sub.add_argument("--fast-mode", choices=get_args(FastMode), default="off", help="Purposes requesting Fast")
        sub.add_argument("--template-dir", type=Path, help="Markdown templates; relative to --project")
        if command == "setup":
            sub.add_argument("--source", help="Explicit uvx package source, e.g. git+https://...git@main")
    templates = commands.add_parser("templates", help="Export editable response templates without authentication")
    templates.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> None:
    parser = argument_parser()
    args = parser.parse_args()
    try:
        if args.command == "templates":
            print(json.dumps({"templates": export_templates(args.output_dir)}))
            return
        if args.command == "check":
            context = asyncio.run(Context.load(args.project))
            print(json.dumps({"ok": True, "connection": "herdr" if context.caller else "local",
                              "workspace_id": context.workspace, "pane_id": context.caller}))
            return
        if not args.analysis_model.strip() or not args.status_model.strip():
            parser.error("model names must not be blank")
        if args.command == "setup" and args.source is not None and not args.source.strip():
            parser.error("--source must not be blank")
        directory = args.template_dir
        if directory is not None:
            directory = (args.project / directory).resolve()
        options = WorkerOptions(args.analysis_model, args.analysis_effort, args.status_model, args.status_effort,
                                args.response_length_mode, args.fast_mode, directory)
        if args.command == "setup":
            print(json.dumps(setup(args.project, args.source, options)))
        else:
            asyncio.run(serve(args.project, options))
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    except (BrokerError, OSError, ValueError) as exc:
        print(f"broker: {exc.code if isinstance(exc, BrokerError) else 'startup_failed'}", file=sys.stderr)
        sys.exit(1)
