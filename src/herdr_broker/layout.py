from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .herdr import BrokerError, Pane

if TYPE_CHECKING:
    from .service import Broker

Direction = Literal["right", "down"]
Write = Callable[[], None]
State = dict[str, Any]


class Leaf(BaseModel):
    model_config = ConfigDict(strict=True)
    type: Literal["pane"]
    pane_id: str


class Split(BaseModel):
    model_config = ConfigDict(strict=True)
    type: Literal["split"]
    direction: Direction
    ratio: float = Field(gt=0, lt=1)
    first: Tree
    second: Tree


Tree = Annotated[Leaf | Split, Field(discriminator="type")]


class Description(BaseModel):
    model_config = ConfigDict(strict=True)
    workspace_id: str
    tab_id: str
    zoomed: bool
    focused_pane_id: str
    root: Tree


def leaves(tree: Tree) -> list[str]:
    if isinstance(tree, Leaf):
        return [tree.pane_id]
    return leaves(tree.first) + leaves(tree.second)


def leaf_pair(tree: Tree, pane_id: str) -> Split | None:
    if isinstance(tree, Leaf):
        return None
    if isinstance(tree.first, Leaf) and isinstance(tree.second, Leaf):
        return tree if pane_id in leaves(tree) else None
    return leaf_pair(tree.first, pane_id) or leaf_pair(tree.second, pane_id)


def replace_node(tree: Tree, original: Tree, replacement: Tree) -> Tree:
    if tree is original:
        return replacement
    if isinstance(tree, Leaf):
        return tree
    return tree.model_copy(
        update={
            "first": replace_node(tree.first, original, replacement),
            "second": replace_node(tree.second, original, replacement),
        }
    )


class Layouts:
    def __init__(self, broker: Broker):
        self.broker = broker
        self.herdr = broker.herdr
        self.lock = asyncio.Lock()

    async def description(self, pane: Pane) -> Description:
        result = await self.herdr.request("layout.export", {"pane_id": pane.pane_id})
        try:
            if result.get("type") != "layout_export":
                raise BrokerError("herdr_invalid_response")
            layout = Description.model_validate(result.get("layout"))
        except ValidationError as exc:
            raise BrokerError("herdr_invalid_response") from exc
        ids = leaves(layout.root)
        if layout.workspace_id != pane.workspace_id or layout.tab_id != pane.tab_id:
            raise BrokerError("layout_changed")
        if pane.pane_id not in ids or layout.focused_pane_id not in ids or len(set(ids)) != len(ids):
            raise BrokerError("herdr_invalid_response")
        return layout

    async def inspect(self, pane: Pane) -> tuple[Description, dict[str, Pane]]:
        layout = await self.description(pane)
        rows = [p for p in await self.herdr.panes(pane.workspace_id) if p.tab_id == pane.tab_id]
        panes = {p.pane_id: p for p in rows}
        if len(panes) != len(rows):
            raise BrokerError("herdr_invalid_response")
        if set(panes) != set(leaves(layout.root)):
            raise BrokerError("layout_changed")
        await self.broker.target(pane.pane_id, pane.terminal_id)
        return layout, panes

    async def view(self, pane: Pane) -> dict[str, Any]:
        layout, panes = await self.inspect(pane)
        # Only validated structure is returned; exported cwd, command and env are discarded.
        return {**layout.model_dump(), "panes": [self.broker.describe(p) for p in panes.values()]}

    async def pane_layout(self, pane_id: str, terminal_id: str) -> dict[str, Any]:
        return await self.view(await self.broker.target(pane_id, terminal_id))

    async def submit(
        self,
        operation: str,
        request_id: str,
        payload: State,
        action: Callable[[Write, State], Awaitable[State]],
    ) -> State:
        async def locked(write: Write, state: State) -> State:
            async with self.lock:
                return await action(write, state)

        return await self.broker.mutate(operation, request_id, payload, locked)

    async def request(self, method: str, params: State, write: Write, state: State) -> State:
        response = await self.herdr.request(method, params, write)
        state.setdefault("steps", []).append(method)
        return response

    def response_pane(self, value: Any, workspace: str) -> Pane:
        try:
            pane = Pane.model_validate(value)
        except ValidationError as exc:
            raise BrokerError("herdr_invalid_response") from exc
        if pane.workspace_id != workspace:
            raise BrokerError("herdr_invalid_response")
        return pane

    async def pane_split(
        self, pane_id: str, terminal_id: str, request_id: str, direction: Direction, ratio: float
    ) -> State:
        async def action(write: Write, state: State) -> State:
            source = await self.broker.target(pane_id, terminal_id)
            response = await self.request(
                "pane.split",
                {
                    "target_pane_id": pane_id,
                    "direction": direction,
                    "ratio": ratio,
                    "focus": False,
                },
                write,
                state,
            )
            if response.get("type") != "pane_info":
                raise BrokerError("herdr_invalid_response")
            pane = self.response_pane(response.get("pane"), source.workspace_id)
            if pane.tab_id != source.tab_id or pane.terminal_id == terminal_id or pane.pane_id == pane_id:
                raise BrokerError("herdr_invalid_response")
            state["pane"] = self.broker.describe(pane)
            await self.broker.target(pane.pane_id, pane.terminal_id)
            return {"changed": True}

        return await self.submit(
            "pane_split",
            request_id,
            {
                "pane_id": pane_id,
                "terminal_id": terminal_id,
                "direction": direction,
                "ratio": ratio,
            },
            action,
        )

    async def pane_close(self, pane_id: str, terminal_id: str, request_id: str) -> State:
        async def action(write: Write, state: State) -> State:
            await self.broker.target(pane_id, terminal_id)
            response = await self.request("pane.close", {"pane_id": pane_id}, write, state)
            if response.get("type") != "ok":
                raise BrokerError("herdr_invalid_response")
            return {"changed": True, "closed_pane_id": pane_id}

        return await self.submit(
            "pane_close", request_id, {"pane_id": pane_id, "terminal_id": terminal_id}, action
        )

    async def pane_swap(
        self, pane_id: str, terminal_id: str, target_pane_id: str, target_terminal_id: str, request_id: str
    ) -> State:
        async def action(write: Write, state: State) -> State:
            source = await self.broker.target(pane_id, terminal_id)
            target = await self.broker.target(target_pane_id, target_terminal_id)
            if (source.workspace_id, source.tab_id) != (target.workspace_id, target.tab_id):
                raise BrokerError("same_tab_required")
            response = await self.request(
                "pane.swap",
                {
                    "source_pane_id": pane_id,
                    "target_pane_id": target_pane_id,
                },
                write,
                state,
            )
            value = response.get("swap")
            if (
                response.get("type") != "pane_swap"
                or not isinstance(value, dict)
                or type(value.get("changed")) is not bool
                or value.get("source_pane_id") != pane_id
                or value.get("target_pane_id") != target_pane_id
                or not isinstance(value.get("focused_pane_id"), str)
                or not value["focused_pane_id"]
                or (value["changed"] and value["focused_pane_id"] != pane_id)
                or value.get("reason") not in (None, "no_neighbor", "same_pane", "not_found", "cross_tab")
                or value["changed"] != (value.get("reason") is None)
            ):
                raise BrokerError("herdr_invalid_response")
            return {
                "changed": value["changed"],
                "reason": value.get("reason"),
                "focused_pane_id": value.get("focused_pane_id"),
                "target_pane_id": target_pane_id,
            }

        return await self.submit(
            "pane_swap",
            request_id,
            {
                "pane_id": pane_id,
                "terminal_id": terminal_id,
                "target_pane_id": target_pane_id,
                "target_terminal_id": target_terminal_id,
            },
            action,
        )

    async def move(
        self, source: Pane, destination: State, write: Write, state: State, focus: bool = False
    ) -> tuple[Pane, bool, str | None]:
        await self.broker.target(source.pane_id, source.terminal_id)
        response = await self.request(
            "pane.move",
            {
                "pane_id": source.pane_id,
                "destination": destination,
                "focus": focus,
            },
            write,
            state,
        )
        value = response.get("move_result")
        if (
            response.get("type") != "pane_move"
            or not isinstance(value, dict)
            or type(value.get("changed")) is not bool
            or value.get("previous_pane_id") != source.pane_id
        ):
            raise BrokerError("herdr_invalid_response")
        pane = self.response_pane(value.get("pane"), source.workspace_id)
        if pane.pane_id != source.pane_id or pane.terminal_id != source.terminal_id:
            raise BrokerError("target_changed")
        state["pane"] = self.broker.describe(pane)
        reason = value.get("reason")
        if reason not in (None, "same_tab", "zoomed_tab") or value["changed"] != (reason is None):
            raise BrokerError("herdr_invalid_response")
        return pane, value["changed"], reason

    async def pane_move(
        self,
        pane_id: str,
        terminal_id: str,
        target_pane_id: str,
        target_terminal_id: str,
        request_id: str,
        direction: Direction,
        ratio: float,
    ) -> State:
        async def action(write: Write, state: State) -> State:
            source = await self.broker.target(pane_id, terminal_id)
            target = await self.broker.target(target_pane_id, target_terminal_id)
            if source.workspace_id != target.workspace_id:
                raise BrokerError("same_workspace_required")
            pane, changed, reason = await self.move(
                source,
                {
                    "type": "tab",
                    "tab_id": target.tab_id,
                    "target_pane_id": target_pane_id,
                    "split": direction,
                    "ratio": ratio,
                },
                write,
                state,
            )
            if changed and pane.tab_id != target.tab_id:
                raise BrokerError("layout_changed")
            return {"changed": changed, "reason": reason}

        return await self.submit(
            "pane_move",
            request_id,
            {
                "pane_id": pane_id,
                "terminal_id": terminal_id,
                "target_pane_id": target_pane_id,
                "target_terminal_id": target_terminal_id,
                "direction": direction,
                "ratio": ratio,
            },
            action,
        )

    async def pane_reorient(
        self, pane_id: str, terminal_id: str, request_id: str, direction: Direction
    ) -> State:
        async def action(write: Write, state: State) -> State:
            selected = await self.broker.target(pane_id, terminal_id)
            original, _ = await self.inspect(selected)
            if original.zoomed:
                raise BrokerError("tab_zoomed")
            pair = leaf_pair(original.root, pane_id)
            if pair is None or not isinstance(pair.first, Leaf) or not isinstance(pair.second, Leaf):
                raise BrokerError("sibling_leaf_pair_required")
            if pair.direction == direction:
                return {"changed": False, "reason": "already_oriented"}
            first = await self.herdr.pane(pair.first.pane_id)
            second = await self.herdr.pane(pair.second.pane_id)
            if any(p.pane_id == pane_id and p.terminal_id != terminal_id for p in (first, second)):
                raise BrokerError("target_changed")
            if any(
                (p.workspace_id, p.tab_id) != (selected.workspace_id, selected.tab_id)
                for p in (first, second)
            ):
                raise BrokerError("layout_changed")
            state["participants"] = [self.broker.describe(first), self.broker.describe(second)]
            moved, changed, reason = await self.move(
                second,
                {
                    "type": "new_tab",
                    "workspace_id": selected.workspace_id,
                    "label": "broker · 임시",
                },
                write,
                state,
            )
            if not changed:
                return {"changed": False, "reason": reason}
            state["temporary_tab_id"] = moved.tab_id
            first_now = await self.broker.target(first.pane_id, first.terminal_id)
            after_detach, _ = await self.inspect(first_now)
            if (
                first_now.tab_id != original.tab_id
                or after_detach.zoomed
                or (after_detach.root != replace_node(original.root, pair, pair.first))
            ):
                raise BrokerError("layout_changed")
            moved_now = await self.broker.target(moved.pane_id, moved.terminal_id)
            if moved_now.tab_id != moved.tab_id:
                raise BrokerError("layout_changed")
            restored, changed, reason = await self.move(
                moved_now,
                {
                    "type": "tab",
                    "tab_id": first.tab_id,
                    "target_pane_id": first.pane_id,
                    "split": direction,
                    "ratio": pair.ratio,
                },
                write,
                state,
                focus=original.focused_pane_id == second.pane_id,
            )
            if not changed or restored.tab_id != original.tab_id:
                raise BrokerError("layout_changed")
            final, _ = await self.inspect(await self.broker.target(first.pane_id, first.terminal_id))
            expected = replace_node(original.root, pair, pair.model_copy(update={"direction": direction}))
            if final.root != expected:
                raise BrokerError("layout_changed")
            return {
                "changed": True,
                "direction": direction,
                "tab_id": original.tab_id,
                "root": final.root.model_dump(),
            }

        return await self.submit(
            "pane_reorient",
            request_id,
            {
                "pane_id": pane_id,
                "terminal_id": terminal_id,
                "direction": direction,
            },
            action,
        )
