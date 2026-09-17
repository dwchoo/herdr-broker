from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
from pathlib import Path
from typing import Any, get_args

from .context import Context
from .herdr import BrokerError
from .options import Effort, FastMode, LengthMode, WorkerOptions, export_templates
from .server import create_server
from .service import Broker
from .skills import setup
from .worker import Worker


async def serve(options: WorkerOptions | None = None) -> None:
    context = await Context.load()
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
    for command in ("mcp", "check"):
        sub = commands.add_parser(command, formatter_class=argparse.ArgumentDefaultsHelpFormatter)
        sub.add_argument("--project", type=Path, help="Deprecated: relative template base only; no project boundary")
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
        sub.add_argument("--template-dir", type=Path, help="Markdown templates; relative to startup cwd")
    installer = commands.add_parser("setup", help="Install the optional broker Skill; does not write MCP config")
    installer.add_argument("--directory", type=Path, default=Path.cwd(), help="Target project directory (default: cwd)")
    templates = commands.add_parser("templates", help="Export editable response templates without authentication")
    templates.add_argument("--output-dir", type=Path, required=True)
    return parser


def main() -> None:
    parser = argument_parser()
    if len(sys.argv) > 1 and sys.argv[1] == "setup":
        old = ("--project", "--source", "--analysis-model", "--analysis-effort", "--status-model",
               "--status-effort", "--response-length-mode", "--fast-mode", "--template-dir")
        if any(arg.split("=", 1)[0] in old for arg in sys.argv[2:]):
            parser.error("setup now installs only the optional Skill. Register MCP in config.toml; "
                         "use setup --directory <path> for the Skill destination.")
    args = parser.parse_args()
    try:
        if args.command == "setup":
            print(json.dumps(setup(args.directory)))
            return
        if args.command == "templates":
            print(json.dumps({"templates": export_templates(args.output_dir)}))
            return
        if args.project is not None:
            print("broker: --project is deprecated; remove it and config cwd. "
                  "Use an absolute --template-dir when migrating relative templates.", file=sys.stderr)
        if args.command == "check":
            context = asyncio.run(Context.load())
            print(json.dumps({"ok": True, "connection": "herdr" if context.caller else "local",
                              "workspace_id": context.workspace, "pane_id": context.caller}))
            return
        if not args.analysis_model.strip() or not args.status_model.strip():
            parser.error("model names must not be blank")
        directory = args.template_dir
        if directory is not None:
            directory = ((args.project or Path.cwd()) / directory).resolve()
        options = WorkerOptions(args.analysis_model, args.analysis_effort, args.status_model, args.status_effort,
                                args.response_length_mode, args.fast_mode, directory)
        asyncio.run(serve(options))
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    except (BrokerError, OSError, ValueError) as exc:
        print(f"broker: {exc.code if isinstance(exc, BrokerError) else 'startup_failed'}", file=sys.stderr)
        sys.exit(1)
