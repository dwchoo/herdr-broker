"""Supervised public-MCP latency probe on a disposable Herdr terminal."""
import argparse
import asyncio
import json
import os
import statistics
import sys
from pathlib import Path
from time import perf_counter
from uuid import uuid4

from mcp.client import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[1]


def output_and_prompt_visible(result, marker, prompt):
    rows = [(int(row["id"].rsplit(":", 1)[-1][1:]), row["text"].removesuffix("\\u000d").rstrip())
            for row in result["evidence"]]
    return any(j > i and later == prompt.rstrip() for i, text in rows if text == marker
               for j, later in rows)


async def run(args):
    proof = {"complete": False, "calls": [], "pairs": [], "ssh_tested": False}
    params = StdioServerParameters(command=sys.executable,
                                  args=["-m", "herdr_broker", "mcp"],
                                  cwd=ROOT, env=dict(os.environ))
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as client:
            await client.initialize()

            async def call(tool, **arguments):
                began = perf_counter()
                response = await client.call_tool(tool, arguments)
                value = response.structured_content
                proof["calls"].append({"tool": tool, "seconds": perf_counter() - began,
                                       "error": response.is_error, "result": value})
                args.output.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
                if response.is_error:
                    raise RuntimeError(str(response.content))
                return value

            def identity(pane):
                return {key: pane[key] for key in ("pane_id", "terminal_id")}

            before = await call("pane_list", workspace_id=args.workspace)
            assert not before["truncated"]
            anchor = next(p for p in before["panes"] if p["pane_id"] == args.anchor)
            original = await call("pane_layout", **identity(anchor))
            if args.inspect_ssh:
                ssh = next(p for p in before["panes"] if p["pane_id"] == args.inspect_ssh)
                if args.observe_marker:
                    result = await call("pane_read", **identity(ssh), purpose="analysis",
                                        max_lines=20,
                                        objective=
                                        f"기존 {args.observe_marker}의 실제 출력과 이후 prompt {args.prompt!r}를 확인하세요. marker와 prompt 각각의 실제 행을 evidence로 인용하세요. 입력 echo는 결과가 아닙니다. 입력은 보내지 마세요.")
                    assert output_and_prompt_visible(result, args.observe_marker, args.prompt)
                    proof["existing_output_confirmed"] = True
                else:
                    result = await call("pane_read", **identity(ssh), purpose="status", objective=
                                        "OS·하드웨어 조회를 하려 합니다. 현재 프로그램, prompt 복귀, 미완성 입력, 실행 중인 명령 여부와 기존 관련 결과의 존재를 간결하게 확인하세요. 입력은 보내지 마세요.")
                await call("analysis_release", analysis_id=result["analysis_id"])
                proof["ssh_status_only"] = True
            else:
                local = (next(p for p in before["panes"] if p["pane_id"] == args.ssh_pane)
                         if args.ssh_pane else
                         (await call("pane_split", **identity(anchor), request_id=uuid4().hex))["pane"])
                try:
                    analysis_id = None
                    if args.ssh_pane:
                        preflight = await call("pane_read", **identity(local), purpose="status", objective=
                                               "OS·하드웨어 조회 전에 현재 프로그램·prompt·미완성 입력·명령 실행 중 여부를 확인하세요.")
                        analysis_id = preflight["analysis_id"]
                        print("SSH_PREFLIGHT=" + json.dumps(preflight, ensure_ascii=False), flush=True)
                        if (await asyncio.to_thread(sys.stdin.readline)).strip() != "continue":
                            raise RuntimeError("SSH preflight was not accepted; no input sent")
                    else:
                        await call("pane_rename", **identity(local), name="SDK 검증", numbered=True)
                    for repeat in range(3):
                        began = perf_counter()
                        status = await call("pane_read", **identity(local), purpose="status",
                                            analysis_id=analysis_id, objective=
                                            "OS·하드웨어 조회 전 상태 확인입니다. 대상 shell의 프로그램, prompt 복귀, 미완성 입력·실행 중 여부와 기존 관련 결과 유무를 간결하게 확인하세요.")
                        analysis_id = status["analysis_id"]
                        nonce = uuid4().hex[:12]
                        command = (f"printf 'SDK_%s\\n' {nonce}; uname -srm; getconf _NPROCESSORS_ONLN; "
                                   "(sysctl -n hw.memsize 2>/dev/null || awk '/MemTotal/{print}' /proc/meminfo); df -h /")
                        submitted = await call("pane_execute", **identity(local), request_id=uuid4().hex,
                                               command=command)
                        assert submitted["submission"] == "accepted"
                        observations = []
                        for _ in range(3):
                            result = await call("pane_read", **identity(local), analysis_id=analysis_id,
                                                purpose="analysis", objective=
                                                f"이번 SDK_{nonce} 다음의 OS·CPU 수·RAM·디스크 결과를 요약하세요. SDK_{nonce} 독립 출력 행과 이후 prompt {args.prompt!r} 행을 반드시 각각 evidence로 인용하세요. 입력 echo는 결과가 아닙니다. 완료 불확실 시 명시하세요.")
                            observations.append({"timings_ms": result["timings_ms"], "usage": result["usage"]})
                            if output_and_prompt_visible(result, f"SDK_{nonce}", args.prompt):
                                break
                        else:
                            raise RuntimeError("Output and returned prompt were not confirmed; do not replay")
                        assert result["effort"] == "high" and status["effort"] == "low"
                        assert result["analysis_id"] == analysis_id and result["sdk_reused"]
                        proof["pairs"].append({"repeat": repeat, "seconds": perf_counter() - began,
                                                "before": status["timings_ms"], "after": result["timings_ms"],
                                                "result_observations": observations, "completion_observed": True,
                                                "warm": status["sdk_reused"],
                                                "before_usage": status["usage"], "after_usage": result["usage"]})
                    await call("analysis_release", analysis_id=analysis_id)
                finally:
                    if not args.ssh_pane:
                        await call("pane_close", **identity(local), request_id=uuid4().hex)
                after = await call("pane_list", workspace_id=args.workspace)
                def signature(pane):
                    return pane["pane_id"], pane["terminal_id"], pane["tab_id"]
                assert sorted(map(signature, before["panes"])) == sorted(map(signature, after["panes"]))
                assert (await call("pane_layout", **identity(anchor)))["root"] == original["root"]
                proof["existing_terminals_and_layout_preserved"] = True
                proof["ssh_tested"] = bool(args.ssh_pane)
    if proof["pairs"]:
        warm = [p["seconds"] for p in proof["pairs"] if p["warm"]]
        proof["warm_pair_median_seconds"] = statistics.median(warm)
        proof["warm_pair_max_seconds"] = max(warm)
    proof["complete"] = True
    args.output.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
    print(json.dumps({key: value for key, value in proof.items() if key not in {"calls", "pairs"}}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--anchor", required=True)
    parser.add_argument("--inspect-ssh")
    parser.add_argument("--ssh-pane")
    parser.add_argument("--observe-marker")
    parser.add_argument("--prompt", default="$")
    parser.add_argument("--output", required=True, type=Path)
    asyncio.run(run(parser.parse_args()))
