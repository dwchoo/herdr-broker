"""Run from a real project Herdr shell. Leaves panes and demo files intact."""

import argparse
import asyncio
import json
import os
import shlex
import sys
from pathlib import Path
from uuid import uuid4

from mcp.client import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[1]


def verify_output(result, expected, marker):
    observed = {row["text"].removesuffix("\\u000d") for row in result["evidence"]}
    if expected not in observed or marker not in observed:
        raise RuntimeError("Worker evidence does not confirm the actual output and marker; do not replay")


async def main(target_code, output):
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "herdr_broker", "mcp"],
        cwd=ROOT,
        env=dict(os.environ),
    )
    evidence = {"runtime": "Python MCP + openai-codex 0.154.0", "calls": []}
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as client:
            await client.initialize()
            evidence["tools"] = [t.name for t in (await client.list_tools()).tools]

            async def call(name, args):
                result = await client.call_tool(name, args)
                if result.is_error:
                    raise RuntimeError(str(result.content))
                value = result.structured_content
                evidence["calls"].append({"tool": name, "result": value})
                output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
                return value

            inventory = await call("pane_list", {})
            candidates = [p for p in inventory["panes"] if p["pane_code"] == target_code]
            if len(candidates) != 1:
                raise RuntimeError("Acceptance needs one explicitly selected numeric target")
            target = candidates[0]
            identity = {k: target[k] for k in ("pane_id", "terminal_id")}
            evidence["target"] = identity
            # The supervising agent verifies that this is an idle local shell before invoking this script.
            await call(
                "pane_read", {**identity, "objective": "현재 프로그램과 입력 대기 상태를 요약해 주세요."}
            )
            marker = "BROKER_DEMO_" + uuid4().hex[:10]
            filename = "/tmp/herdr-simple-" + uuid4().hex + ".sh"
            commands = [
                f"printf '%s\\n' '#!/bin/sh' 'echo before' > {shlex.quote(filename)}; cat {shlex.quote(filename)}; echo {marker}_READ",
                f"sed -i '' 's/before/after/' {shlex.quote(filename)}; cat {shlex.quote(filename)}; echo {marker}_EDIT",
                f"sh {shlex.quote(filename)}; echo {marker}_RUN",
            ]
            for index, command in enumerate(commands):
                sent = await call(
                    "pane_send", {**identity, "request_id": str(uuid4()), "text": command, "keys": ["Enter"]}
                )
                if sent["submission"] != "accepted":
                    raise RuntimeError("input not acknowledged; do not replay")
                await asyncio.sleep(0.5)
                result = await call(
                    "pane_read",
                    {
                        **identity,
                        "objective": f"방금 명령의 출력에서 {'파일 내용 before' if index == 0 else '수정 내용 after' if index == 1 else '실행 출력 after'}와 완료 marker를 확인해 주세요. 입력한 명령 자체와 실제 출력은 구분하고, 실제 내용과 marker의 줄을 각각 evidence로 인용하세요.",
                    },
                )
                verify_output(result, ("echo before", "echo after", "after")[index], marker + ("_READ", "_EDIT", "_RUN")[index])
            # Idempotent rename preserves the existing visible layout and label.
            await call("pane_rename", {**identity, "name": target["label"]})
            evidence["demo_file"] = filename
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as client:
            await client.initialize()
            result = await client.call_tool("pane_list", {})
            matched = [
                p for p in result.structured_content["panes"] if p["terminal_id"] == identity["terminal_id"]
            ]
            assert len(matched) == 1 and matched[0]["pane_code"] == target_code
            evidence["restart_same_terminal_and_label"] = True
    evidence["complete"] = True
    output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"ok": True, "proof": str(output), "demo_file": filename}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(main(args.target, args.output))
