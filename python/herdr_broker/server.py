from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Annotated, Any

from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

from .herdr import BrokerError
from .layout import Direction, Layouts
from .service import Broker
from .worker import Effort, Purpose

Id = Annotated[str, Field(min_length=1, max_length=256)]
Offset = Annotated[int, Field(ge=0, le=1000000)]
Ratio = Annotated[float, Field(ge=0.1, le=0.9)]


def create_server(broker: Broker) -> MCPServer[Any]:
    server: MCPServer[Any] = MCPServer(
        "herdr-broker",
        version="0.2.0",
        log_level="WARNING",
        instructions="Use workspace_list and pane_list to interpret names and imperfect references. Outside Herdr choose an explicit workspace_id for listing. Select exact pane_id and terminal_id. Use pane_split for a new terminal; pane_layout, pane_swap, pane_move and pane_reorient arrange live panes. pane_close ends a terminal. Work through visible pane commands. Status reads 8 recent lines / 1 KiB with Luna/low; analysis reads 80 lines with Luna/high. Expand max_lines explicitly only when the tail is insufficient. Continue the same task with analysis_id and release it when done. Include the user objective to assess existing results before rerunning work. Apply your own approval policy; no Broker approval or attachment is required.",
    )
    read = ToolAnnotations(read_only_hint=True, destructive_hint=False)
    rename = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True)
    mutation = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False)
    layouts = Layouts(broker)

    async def invoke(operation: Callable[..., Awaitable[dict[str, Any]]], *args: Any) -> dict[str, Any]:
        try:
            await broker.context.verify()
            return await operation(*args)
        except BrokerError as exc:
            raise ToolError(exc.code) from exc

    @server.tool(annotations=read)
    async def workspace_list() -> dict[str, Any]:
        """List local Herdr workspaces and verified caller/default context. Metadata only. Outside Herdr select a workspace_id from this inventory before tab/pane listing."""
        return await invoke(broker.workspace_list)

    @server.tool(annotations=read)
    async def tab_list(workspace_id: Id | None = None) -> dict[str, Any]:
        """List tabs in the selected workspace. Defaults to the verified Herdr caller workspace; outside Herdr workspace_id is required."""
        return await invoke(broker.tab_list, workspace_id)

    @server.tool(annotations=read)
    async def pane_list(
        tab_id: Id | None = None, offset: Offset = 0, workspace_id: Id | None = None
    ) -> dict[str, Any]:
        """Discover selected workspace panes, aliases, IDs, locations and processes. Outside Herdr workspace_id is required. Follow next_offset. Interpret incomplete references with this inventory and conversation, then use exact IDs. No screen capture, Worker or rename."""
        return await invoke(broker.pane_list, tab_id, offset, workspace_id)

    @server.tool(annotations=read)
    async def pane_read(
        pane_id: Id,
        terminal_id: Id,
        objective: Annotated[str, Field(max_length=4096)] = "현재 화면과 작업 상태를 요약해 주세요.",
        raw: bool = False,
        offset: Offset = 0,
        effort: Effort | None = None,
        max_lines: Annotated[int, Field(ge=1, le=1000)] | None = None,
        purpose: Purpose = "analysis",
        analysis_id: Id | None = None,
    ) -> dict[str, Any]:
        """Read with Luna: status uses low and 8 recent lines / 1 KiB for prompt/pending input/running state; analysis uses high and 80 lines / 64 KiB for interpretation. Explicit effort overrides apply per turn. Include the user objective and assess existing results before rerunning commands. Carry analysis_id only for the same task/target; expired IDs require rediscovery and a new read. Evidence belongs to the current observation, never input echo. Expand max_lines up to 1000 when needed. Raw is only for requested original text and never changes analysis context. No automatic input, retry, delta or model fallback."""
        return await invoke(broker.pane_read, pane_id, terminal_id, objective, raw, offset,
                            effort, max_lines, purpose, analysis_id)

    @server.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=True))
    async def analysis_release(analysis_id: Id) -> dict[str, Any]:
        """Release this task's idle analysis context when finished. Leaves SDK, panes and terminal work alive. Unknown IDs are harmless; busy contexts must finish first. Unsubscribe does not prove immediate SDK memory unload."""
        return await invoke(broker.worker.release, analysis_id)

    @server.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True))
    async def pane_send(
        pane_id: Id,
        terminal_id: Id,
        request_id: Id,
        text: Annotated[str, Field(max_length=65536)] = "",
        keys: Annotated[list[Annotated[str, Field(min_length=1, max_length=64)]], Field(max_length=32)] = [],
    ) -> dict[str, Any]:
        """Type exact text/keys without implicit submission; use pane_execute for shell commands to run now. Pasted newlines may not submit; Enter is never added here. Reuse request_id only to query its compact receipt. Unknown delivery must not be replayed. ACK is not completion; read afterwards."""
        return await invoke(broker.pane_send, pane_id, terminal_id, request_id, text, keys)

    @server.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False))
    async def pane_execute(
        pane_id: Id,
        terminal_id: Id,
        request_id: Id,
        command: Annotated[str, Field(max_length=65536)],
    ) -> dict[str, Any]:
        """Submit a nonblank shell command (including heredocs) and one explicit Enter together under your approval policy. Command text is unchanged; no wrapper or automatic observation. Check the current program first. ACK is not completion: use pane_read to verify actual output/errors and prompt return, not echoed code or markers. Never replay unknown delivery; duplicates return compact receipts."""
        return await invoke(broker.pane_execute, pane_id, terminal_id, request_id, command)

    @server.tool(annotations=rename)
    async def pane_rename(
        pane_id: Id, terminal_id: Id, name: Annotated[str, Field(max_length=120)] = "", numbered: bool = False
    ) -> dict[str, Any]:
        """Explicitly rename a pane. numbered=true preserves/allocates a current-workspace four-digit alias in Herdr's label; empty name then preserves the existing name. No global registry or permanent uniqueness."""
        return await invoke(broker.pane_rename, pane_id, terminal_id, name, numbered)

    @server.tool(annotations=rename)
    async def tab_rename(
        tab_id: Id, name: Annotated[str, Field(min_length=1, max_length=120)], workspace_id: Id | None = None
    ) -> dict[str, Any]:
        """Rename a tab in the current workspace without moving or recreating panes."""
        return await invoke(broker.tab_rename, tab_id, name, workspace_id)

    @server.tool(annotations=read)
    async def pane_layout(pane_id: Id, terminal_id: Id) -> dict[str, Any]:
        """Inspect a pane's tab split tree and identities without screen reads. right means left/right; down means top/bottom. Read before arranging panes."""
        return await invoke(layouts.pane_layout, pane_id, terminal_id)

    @server.tool(annotations=mutation)
    async def pane_split(
        pane_id: Id, terminal_id: Id, request_id: Id, direction: Direction = "right", ratio: Ratio = 0.5
    ) -> dict[str, Any]:
        """Create a fresh shell beside an exact pane, keeping focus: right=side by side, down=stacked. ratio is the original pane's share. Defaults to right for 'make a pane'. Return new identity; then use pane_rename(numbered=true) to assign its alias. No SSH/program cloning. Never replay unknown results."""
        return await invoke(layouts.pane_split, pane_id, terminal_id, request_id, direction, ratio)

    @server.tool(annotations=ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False))
    async def pane_close(pane_id: Id, terminal_id: Id, request_id: Id) -> dict[str, Any]:
        """Close exactly this terminal. Its running work may terminate; closing the caller may disconnect this MCP. Apply the Parent's approval policy. Duplicate IDs do not close again."""
        return await invoke(layouts.pane_close, pane_id, terminal_id, request_id)

    @server.tool(annotations=mutation)
    async def pane_swap(
        pane_id: Id, terminal_id: Id, target_pane_id: Id, target_terminal_id: Id, request_id: Id
    ) -> dict[str, Any]:
        """Swap two exact panes in the same tab, retaining terminal processes, split shape and ratios. Herdr focuses the source pane. Inspect pane_layout afterwards."""
        return await invoke(
            layouts.pane_swap, pane_id, terminal_id, target_pane_id, target_terminal_id, request_id
        )

    @server.tool(annotations=mutation)
    async def pane_move(
        pane_id: Id,
        terminal_id: Id,
        target_pane_id: Id,
        target_terminal_id: Id,
        request_id: Id,
        direction: Direction = "right",
        ratio: Ratio = 0.5,
    ) -> dict[str, Any]:
        """Move a live pane beside an exact target in another existing tab of the same workspace. right=side by side, down=stacked. Empty source tabs may disappear. Same-tab requests are no-ops; use swap or reorient there. Never recreate terminals or replay unknown results."""
        return await invoke(
            layouts.pane_move,
            pane_id,
            terminal_id,
            target_pane_id,
            target_terminal_id,
            request_id,
            direction,
            ratio,
        )

    @server.tool(annotations=mutation)
    async def pane_reorient(
        pane_id: Id, terminal_id: Id, request_id: Id, direction: Direction
    ) -> dict[str, Any]:
        """Change the shared split of two sibling leaf panes to right (side by side) or down (stacked). Keeps order, ratio and live terminals via a temporary tab; no layout.apply. Nested groups/zoomed tabs are rejected. On partial/unknown results inspect progress and inventory; never automatically repeat or close a stranded pane."""
        return await invoke(layouts.pane_reorient, pane_id, terminal_id, request_id, direction)

    return server
