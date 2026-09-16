"""Exercise layout tools using disposable panes; retain every pre-existing terminal."""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

from herdr_broker.context import Context
from mcp.client import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[1]


async def run(workspace_id, anchor_id, output):
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "herdr_broker", "mcp", "--project", str(ROOT)],
        cwd=ROOT,
        env=dict(os.environ),
    )
    context = await Context.load(ROOT)
    evidence = {"calls": [], "complete": False}
    created = []
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as client:
            await client.initialize()

            async def call(name, arguments):
                result = await client.call_tool(name, arguments)
                value = result.structured_content
                evidence["calls"].append({"tool": name, "result": value, "error": result.is_error})
                output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
                if result.is_error:
                    raise RuntimeError(str(result.content))
                if value.get("submission") not in (None, "accepted"):
                    raise RuntimeError(f"Mutation did not finish: {value}; do not replay")
                return value

            def identity(pane):
                return {key: pane[key] for key in ("pane_id", "terminal_id")}

            async def mutate(name, pane, **extra):
                return await call(name, {**identity(pane), "request_id": str(uuid4()), **extra})

            workspaces = await call("workspace_list", {})
            evidence["connection"] = workspaces["connection"]
            await call("tab_list", {"workspace_id": workspace_id})
            before = await call("pane_list", {"workspace_id": workspace_id})
            if before["truncated"]:
                raise RuntimeError("Use a small acceptance workspace")
            anchor = next(p for p in before["panes"] if p["pane_id"] == anchor_id)
            original = await call("pane_layout", identity(anchor))
            try:
                first = (await mutate("pane_split", anchor, direction="right"))["pane"]
                created.append(first)
                await call("pane_rename", {**identity(first), "numbered": True, "name": "배치 테스트"})
                second = (await mutate("pane_split", first, direction="down"))["pane"]
                created.append(second)
                pids = {
                    p["pane_id"]: (await context.herdr.process_info(p["pane_id"]))["shell_pid"]
                    for p in created
                }
                await call("pane_layout", identity(first))
                await mutate("pane_reorient", first, direction="right")
                await mutate(
                    "pane_swap",
                    first,
                    target_pane_id=second["pane_id"],
                    target_terminal_id=second["terminal_id"],
                )
                await mutate("pane_reorient", first, direction="down")
                await call("pane_layout", identity(first))
                # Fixture setup: move only our disposable pane into a new tab, then exercise public move.
                setup = await context.herdr.request(
                    "pane.move",
                    {
                        "pane_id": second["pane_id"],
                        "destination": {
                            "type": "new_tab",
                            "workspace_id": workspace_id,
                            "label": "broker 배치 검증",
                        },
                        "focus": False,
                    },
                )
                assert setup["move_result"]["changed"]
                await mutate(
                    "pane_move",
                    first,
                    target_pane_id=second["pane_id"],
                    target_terminal_id=second["terminal_id"],
                    direction="right",
                )
                await mutate(
                    "pane_move",
                    first,
                    target_pane_id=anchor["pane_id"],
                    target_terminal_id=anchor["terminal_id"],
                    direction="right",
                )
                for pane in created:
                    current = await context.herdr.pane(pane["pane_id"])
                    assert current.terminal_id == pane["terminal_id"]
                    assert (await context.herdr.process_info(pane["pane_id"]))["shell_pid"] == pids[
                        pane["pane_id"]
                    ]
                evidence["same_terminal_ids_and_shell_pids"] = True
            finally:
                # Delete only test-created terminals, with their exact identities; never old panes.
                for pane in reversed(created):
                    await mutate("pane_close", pane)
            after = await call("pane_list", {"workspace_id": workspace_id})
            restored = await call("pane_layout", identity(anchor))
            assert restored["root"] == original["root"]
            assert {(p["pane_id"], p["terminal_id"], p["tab_id"]) for p in before["panes"]} == {
                (p["pane_id"], p["terminal_id"], p["tab_id"]) for p in after["panes"]
            }
            evidence["existing_panes_and_layout_preserved"] = True
            evidence["complete"] = True
            output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
            print(json.dumps({"ok": True, "proof": str(output), "connection": workspaces["connection"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--anchor", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(run(args.workspace, args.anchor, args.output))
