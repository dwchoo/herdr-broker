from __future__ import annotations

import asyncio
import json
import os
import pwd
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .herdr import BrokerError, Herdr

CONTEXT_KEYS = ("HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_SOCKET_PATH")


def project_path(project: Path) -> Path:
    root = project.resolve(strict=True)
    if not root.is_dir() or not Path.cwd().resolve().is_relative_to(root):
        raise BrokerError("project_context_required")
    return root


def local_settings() -> dict[str, Any]:
    path = Path(pwd.getpwuid(os.getuid()).pw_dir) / ".config/herdr-broker/config.json"
    try:
        info = path.lstat()
    except FileNotFoundError:
        return {}
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or info.st_size > 16384
    ):
        raise BrokerError("config_invalid")
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or set(data) - {"herdr_socket", "codex_binary", "redaction_patterns"}:
            raise ValueError()
        if "herdr_socket" in data and (
            not isinstance(data["herdr_socket"], str) or not Path(data["herdr_socket"]).is_absolute()
        ):
            raise ValueError()
        patterns = data.get("redaction_patterns", [])
        if (
            not isinstance(patterns, list)
            or len(patterns) > 16
            or any(not isinstance(p, str) or not 1 <= len(p) <= 256 for p in patterns)
        ):
            raise ValueError()
        return data
    except (ValueError, OSError) as exc:
        raise BrokerError("config_invalid") from exc


def is_descendant(processes: str, pid: int, shell: int, uid: int) -> bool:
    rows = {}
    for line in processes.splitlines():
        values = line.split()
        if len(values) == 3 and all(v.isdigit() for v in values):
            current, parent, owner = map(int, values)
            rows[current] = (parent, owner)
    seen: set[int] = set()
    while pid > 1 and len(seen) < 64 and pid not in seen:
        seen.add(pid)
        row = rows.get(pid)
        if row is None or row[1] != uid:
            return False
        if pid == shell:
            return True
        pid = row[0]
    return False


@dataclass
class Context:
    herdr: Herdr
    project: Path
    workspace: str | None
    caller: str | None
    terminal: str | None
    shell_pid: int | None
    patterns: list[str]

    @classmethod
    async def load(cls, project: Path) -> Context:
        root = project_path(project)
        inside = any(k in os.environ for k in CONTEXT_KEYS)
        if inside and (os.environ.get("HERDR_ENV") != "1" or any(not os.environ.get(k) for k in CONTEXT_KEYS)):
            raise BrokerError("herdr_context_required")
        config = local_settings()
        default = Path(pwd.getpwuid(os.getuid()).pw_dir) / ".config/herdr/herdr.sock"
        try:
            endpoint = Path(config.get("herdr_socket", default)).resolve(strict=True)
            if inside and endpoint != Path(os.environ["HERDR_SOCKET_PATH"]).resolve(strict=True):
                raise BrokerError("herdr_context_mismatch")
            herdr = Herdr(endpoint)
            await herdr.check()
            if not inside:
                return cls(herdr, root, None, None, None, None, config.get("redaction_patterns", []))
            pane = await herdr.pane(os.environ["HERDR_PANE_ID"])
            # A live terminal can move tabs while retaining its inherited environment.
            if pane.workspace_id != os.environ["HERDR_WORKSPACE_ID"]:
                raise BrokerError("herdr_context_mismatch")
            shell = (await herdr.process_info(pane.pane_id)).get("shell_pid")
            if not isinstance(shell, int) or shell <= 1:
                raise BrokerError("herdr_context_mismatch")
            process = await asyncio.create_subprocess_exec(
                "/bin/ps",
                "-axo",
                "pid=,ppid=,uid=",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env={"LC_ALL": "C", "PATH": "/usr/bin:/bin"},
            )
            try:
                output, _ = await asyncio.wait_for(process.communicate(), 2)
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
            if process.returncode or not is_descendant(output.decode(), os.getpid(), shell, os.getuid()):
                raise BrokerError("herdr_context_mismatch")
            context = cls(
                herdr,
                root,
                pane.workspace_id,
                pane.pane_id,
                pane.terminal_id,
                shell,
                config.get("redaction_patterns", []),
            )
            await context.verify()
            return context
        except (OSError, TimeoutError) as exc:
            raise BrokerError("herdr_context_mismatch") from exc

    async def verify(self) -> None:
        project_path(self.project)
        self.herdr.check_socket()
        if self.caller is None:
            return
        pane = await self.herdr.pane(self.caller)
        if pane.terminal_id != self.terminal or pane.workspace_id != self.workspace:
            raise BrokerError("herdr_context_changed")
        if (await self.herdr.process_info(self.caller)).get("shell_pid") != self.shell_pid:
            raise BrokerError("herdr_context_changed")
