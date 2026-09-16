"""Verify exact execution on a disposable local pane and an explicitly selected idle SSH pane."""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from uuid import uuid4

from mcp.client import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[1]


def output_and_prompt_visible(result, marker, prompt):
    rows = [(int(row["id"].rsplit(":", 1)[-1][1:]), row["text"].removesuffix("\\u000d").rstrip()) for row in result["evidence"]]
    outputs = [number for number, text in rows if text == marker]
    prompts = [number for number, text in rows if text == prompt.rstrip()]
    return any(prompt_line > output_line for output_line in outputs for prompt_line in prompts)


async def run(workspace, anchor_id, local_prompt, ssh_id, ssh_prompt, output):
    proof = {"complete": False, "calls": [], "ssh_tested": False}
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "herdr_broker", "mcp", "--project", str(ROOT)],
        cwd=ROOT,
        env=dict(os.environ),
    )
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as client:
            await client.initialize()

            async def call(name, arguments):
                response = await client.call_tool(name, arguments)
                value = response.structured_content
                proof["calls"].append({"tool": name, "result": value, "error": response.is_error})
                output.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + "\n")
                if response.is_error or value.get("submission") not in (None, "accepted"):
                    raise RuntimeError(f"Call failed; do not replay: {response.content}")
                return value

            def identity(pane):
                return {key: pane[key] for key in ("pane_id", "terminal_id")}

            async def read(pane, objective):
                return await call("pane_read", {**identity(pane), "objective": objective})

            async def confirm(pane, marker, prompt):
                # ACK may precede the next terminal frame. Only observe again; never resend input.
                for _ in range(3):
                    await asyncio.sleep(0.5)
                    result = await read(
                        pane,
                        f"{marker}가 입력 코드의 echo가 아닌 독립된 실제 출력 행인지, 이후 shell prompt {prompt!r}가 돌아왔는지 확인해 주세요. marker와 그 뒤 prompt의 실제 행을 모두 evidence로 인용하세요.",
                    )
                    if output_and_prompt_visible(result, marker, prompt):
                        print(json.dumps({"pane": pane["pane_id"], "verified_marker": marker}), flush=True)
                        return
                raise RuntimeError("Worker did not cite actual output and a later prompt; do not replay")

            async def execute(pane, multiline, prompt):
                tag = uuid4().hex[:12]
                command = (
                    f"python3 - <<'PY'\nprint('BROKER_' + '{tag}')\nPY\n"
                    if multiline else f"printf 'BROKER_%s\\n' {tag}"
                )
                args = {**identity(pane), "request_id": str(uuid4()), "command": command}
                first = await call("pane_execute", args)
                duplicate = await call("pane_execute", args)
                assert first["completion"] == "not_observed"
                assert duplicate["duplicate"] and duplicate["details_retained"] is False
                await confirm(pane, "BROKER_" + tag, prompt)

            await call("workspace_list", {})
            before = await call("pane_list", {"workspace_id": workspace})
            if before["truncated"]:
                raise RuntimeError("Use a small acceptance workspace")
            anchor = next(p for p in before["panes"] if p["pane_id"] == anchor_id)
            original = await call("pane_layout", identity(anchor))
            if ssh_id:
                # The supervising agent must verify idle state through pane_read before selecting this pane.
                ssh = next(p for p in before["panes"] if p["pane_id"] == ssh_id)
                await execute(ssh, False, ssh_prompt)
                await execute(ssh, True, ssh_prompt)
                proof["ssh_tested"] = True
            local = (await call("pane_split", {**identity(anchor), "request_id": str(uuid4())}))["pane"]
            try:
                await call("pane_rename", {**identity(local), "name": "실행 검증", "numbered": True})
                await read(local, "새 local shell이 입력 대기 중인지 확인해 주세요.")
                tag = uuid4().hex[:12]
                await call("pane_send", {
                    **identity(local), "request_id": str(uuid4()), "text": f"printf 'BROKER_%s\\n' {tag}",
                })
                pending = await read(local, "입력만 한 printf 명령이 아직 실행되지 않았는지 확인해 주세요. 입력 echo와 실제 출력·프롬프트 복귀를 구분하세요.")
                assert all(row["text"].removesuffix("\\u000d") != "BROKER_" + tag for row in pending["evidence"])
                await call("pane_send", {**identity(local), "request_id": str(uuid4()), "keys": ["Enter"]})
                await confirm(local, "BROKER_" + tag, local_prompt)
                await execute(local, False, local_prompt)
                await execute(local, True, local_prompt)
            finally:
                await call("pane_close", {**identity(local), "request_id": str(uuid4())})
            after = await call("pane_list", {"workspace_id": workspace})
            def signature(pane):
                return pane["pane_id"], pane["terminal_id"], pane["tab_id"]
            assert sorted(map(signature, before["panes"])) == sorted(map(signature, after["panes"]))
            assert (await call("pane_layout", identity(anchor)))["root"] == original["root"]
            proof["existing_terminals_and_layout_preserved"] = True
    proof["complete"] = True
    output.write_text(json.dumps(proof, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"ok": True, "proof": str(output), "ssh_tested": proof["ssh_tested"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--anchor", required=True)
    parser.add_argument("--local-prompt", required=True, help="Exact prompt text expected in the new local shell")
    parser.add_argument("--ssh-pane")
    parser.add_argument("--ssh-prompt", help="Exact prompt text from the supervised idle SSH observation")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.ssh_pane and not args.ssh_prompt:
        parser.error("--ssh-pane requires --ssh-prompt")
    asyncio.run(run(args.workspace, args.anchor, args.local_prompt, args.ssh_pane, args.ssh_prompt, args.output))
