from __future__ import annotations

import asyncio
import json
import os
import stat
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError


class BrokerError(Exception):
    def __init__(self, code: str, native_code: str | None = None):
        super().__init__(code)
        self.code = code
        self.native_code = native_code


class Pane(BaseModel):
    model_config = ConfigDict(strict=True)
    pane_id: str = Field(min_length=1, max_length=256)
    terminal_id: str = Field(min_length=1, max_length=256)
    workspace_id: str = Field(min_length=1, max_length=256)
    tab_id: str = Field(min_length=1, max_length=256)
    label: str | None = None
    title: str | None = None
    terminal_title_stripped: str | None = None
    cwd: str | None = None
    foreground_cwd: str | None = None
    agent: str | None = None
    agent_status: str


class Tab(BaseModel):
    model_config = ConfigDict(strict=True)
    tab_id: str
    workspace_id: str
    label: str
    number: int
    pane_count: int


class Workspace(BaseModel):
    model_config = ConfigDict(strict=True)
    workspace_id: str
    number: int
    label: str
    focused: bool
    pane_count: int
    tab_count: int
    active_tab_id: str


class Herdr:
    def __init__(self, endpoint: Path, timeout: float = 5):
        self.endpoint = endpoint
        self.timeout = timeout
        self.identity: tuple[int, int] | None = None

    def check_socket(self) -> None:
        try:
            info = self.endpoint.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                raise BrokerError("herdr_socket_invalid")
            identity = (info.st_dev, info.st_ino)
            if self.identity is not None and identity != self.identity:
                raise BrokerError("herdr_restarted")
            self.identity = identity
        except OSError as exc:
            raise BrokerError("herdr_unavailable") from exc

    async def request(
        self,
        method: str,
        params: dict[str, Any],
        before_write: Callable[[], None] | None = None,
    ) -> dict[str, Any]:
        self.check_socket()
        writer: asyncio.StreamWriter | None = None
        try:
            async with asyncio.timeout(self.timeout):
                reader, writer = await asyncio.open_unix_connection(str(self.endpoint), limit=4 * 1024 * 1024)
                self.check_socket()
                request_id = str(uuid4())
                payload = json.dumps(
                    {"id": request_id, "method": method, "params": params}, ensure_ascii=False
                )
                if before_write:
                    before_write()
                writer.write(payload.encode() + b"\n")
                await writer.drain()
                line = await reader.readline()
                if not line:
                    raise BrokerError("herdr_disconnected")
                response = json.loads(line)
                if not isinstance(response, dict) or response.get("id") != request_id:
                    raise BrokerError("herdr_invalid_response")
                if "error" in response:
                    error = response["error"]
                    raise BrokerError(
                        "herdr_rejected", error.get("code") if isinstance(error, dict) else None
                    )
                result = response.get("result")
                if not isinstance(result, dict):
                    raise BrokerError("herdr_invalid_response")
                return result
        except TimeoutError as exc:
            raise BrokerError("herdr_timeout") from exc
        except (OSError, ValueError, UnicodeError) as exc:
            raise BrokerError(
                "herdr_invalid_response" if isinstance(exc, ValueError) else "herdr_unavailable"
            ) from exc
        finally:
            if writer:
                writer.close()
                try:
                    await writer.wait_closed()
                except (OSError, asyncio.CancelledError):
                    pass

    async def check(self) -> None:
        result = await self.request("ping", {})
        if result.get("type") != "pong" or result.get("version") != "0.9.0" or result.get("protocol") != 22:
            raise BrokerError("herdr_unsupported")

    async def pane(self, pane_id: str) -> Pane:
        result = await self.request("pane.get", {"pane_id": pane_id})
        try:
            pane = Pane.model_validate(result["pane"])
            if result.get("type") != "pane_info" or pane.pane_id != pane_id:
                raise BrokerError("herdr_invalid_response")
            return pane
        except (KeyError, ValidationError) as exc:
            raise BrokerError("herdr_invalid_response") from exc

    async def panes(self, workspace: str) -> list[Pane]:
        result = await self.request("pane.list", {"workspace_id": workspace})
        try:
            if result.get("type") != "pane_list" or not isinstance(result.get("panes"), list):
                raise BrokerError("herdr_invalid_response")
            panes = [Pane.model_validate(row) for row in result["panes"]]
            if any(p.workspace_id != workspace for p in panes):
                raise BrokerError("herdr_invalid_response")
            return panes
        except ValidationError as exc:
            raise BrokerError("herdr_invalid_response") from exc

    async def tabs(self, workspace: str) -> list[Tab]:
        result = await self.request("tab.list", {"workspace_id": workspace})
        try:
            if result.get("type") != "tab_list" or not isinstance(result.get("tabs"), list):
                raise BrokerError("herdr_invalid_response")
            tabs = [Tab.model_validate(row) for row in result["tabs"]]
            if any(t.workspace_id != workspace for t in tabs):
                raise BrokerError("herdr_invalid_response")
            return tabs
        except ValidationError as exc:
            raise BrokerError("herdr_invalid_response") from exc

    async def workspaces(self) -> list[Workspace]:
        result = await self.request("workspace.list", {})
        try:
            if result.get("type") != "workspace_list" or not isinstance(result.get("workspaces"), list):
                raise BrokerError("herdr_invalid_response")
            return [Workspace.model_validate(row) for row in result["workspaces"]]
        except ValidationError as exc:
            raise BrokerError("herdr_invalid_response") from exc

    async def process_info(self, pane_id: str) -> dict[str, Any]:
        result = await self.request("pane.process_info", {"pane_id": pane_id})
        info = result.get("process_info")
        if (
            result.get("type") != "pane_process_info"
            or not isinstance(info, dict)
            or info.get("pane_id") != pane_id
            or not isinstance(info.get("foreground_processes"), list)
            or any(
                not isinstance(process, dict) or not isinstance(process.get("name"), str)
                for process in info["foreground_processes"]
            )
        ):
            raise BrokerError("herdr_invalid_response")
        return info
