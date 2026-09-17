from __future__ import annotations

import os
import stat
import uuid
from contextlib import ExitStack
from importlib.resources import files
from pathlib import Path
from typing import Any

from .herdr import BrokerError


def setup(directory: Path) -> dict[str, Any]:
    """Copy the packaged Skill without following managed symlinks or replacing files."""
    target = directory.absolute() / ".agents/skills/broker/SKILL.md"
    content = files("herdr_broker").joinpath("resources/broker.md").read_bytes()
    changed = False
    try:
        root = directory.resolve(strict=True)
        target = root / ".agents/skills/broker/SKILL.md"
        with ExitStack() as stack:
            parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            stack.callback(os.close, parent)
            for part in (".agents", "skills", "broker"):
                try:
                    os.mkdir(part, dir_fd=parent)
                except FileExistsError:
                    pass
                if stat.S_ISLNK(os.stat(part, dir_fd=parent, follow_symlinks=False).st_mode):
                    raise BrokerError(f"symlink in Skill path: {part}")
                parent = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                stack.callback(os.close, parent)
            staging = ".broker-" + uuid.uuid4().hex
            fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644, dir_fd=parent)
            try:
                with os.fdopen(fd, "wb") as output:
                    output.write(content)
                    output.flush()
                    os.fsync(output.fileno())
                try:
                    # Publish only complete bytes, atomically, without replacing an existing name.
                    os.link(staging, "SKILL.md", src_dir_fd=parent, dst_dir_fd=parent)
                    changed = True
                except FileExistsError:
                    if stat.S_ISLNK(os.stat("SKILL.md", dir_fd=parent, follow_symlinks=False).st_mode):
                        raise BrokerError("SKILL.md is a symlink")
                    existing = os.open("SKILL.md", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                       dir_fd=parent)
                    with os.fdopen(existing, "rb") as source:
                        info = os.fstat(source.fileno())
                        if not stat.S_ISREG(info.st_mode):
                            raise BrokerError("SKILL.md is not a regular file")
                        if info.st_size != len(content) or source.read(len(content) + 1) != content:
                            raise BrokerError("SKILL.md differs from the packaged Skill")
            finally:
                os.unlink(staging, dir_fd=parent)
    except (OSError, BrokerError) as exc:
        reason = exc.strerror if isinstance(exc, OSError) else exc.code
        raise BrokerError(f"skill_install_conflict: {target}; {reason}; existing files preserved") from exc
    return {"skill_path": str(target), "changed": changed,
            "next": "MCP configuration is unchanged. If $broker is not visible, start a new Codex session."}
