"""Compare synthetic status inputs with an optional baseline Worker; no pane input."""
import argparse
import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from time import perf_counter

from herdr_broker.worker import Worker


def load_baseline(path):
    spec = importlib.util.spec_from_file_location("herdr_broker._status_baseline", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.Worker


async def run(args):
    rows = [f"previous OS hardware result {i}: Linux CPU=8 RAM=32768 MiB disk=400G" for i in range(72)]
    rows.append("user@host:~$ ")
    full = "\n".join(rows)
    tail = "\n".join(rows[-8:]).encode()[-1024:].decode(errors="ignore")
    output = {"complete": False, "synthetic": True, "results": []}

    async def sample(worker, label, text, purpose="status", analysis_id=None):
        async def capture():
            return text
        began = perf_counter()
        result = await worker.analyze(capture, "지금 명령을 입력할 수 있는 상태인지 확인해 주세요.", [],
                                      purpose=purpose, analysis_id=analysis_id)
        output["results"].append({"label": label, "seconds": perf_counter() - began, **result})
        args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2))
        print(json.dumps({"label": label, "seconds": output["results"][-1]["seconds"],
                          "usage": result["usage"], "input_sizes": result.get("input_sizes")}), flush=True)
        return result

    if args.baseline_worker:
        baseline = load_baseline(args.baseline_worker)()
        try:
            for label, text in [("baseline_73", full), ("baseline_8", tail)]:
                result = await sample(baseline, label, text)
                await baseline.release(result["analysis_id"])
        finally:
            await baseline.close()
    worker = Worker()
    try:
        for label, text in [("status_8", tail), ("pending_input", "user@host:~$ python3 - <<'PY'\n> print('unfinished')\n> "),
                            ("running", "user@host:~$ sleep 600\n"), ("ambiguous", "\n"),
                            ("status_8_repeat", tail)]:
            result = await sample(worker, label, text)
            if label == "status_8":
                await sample(worker, "analysis_same_context", tail, purpose="analysis", analysis_id=result["analysis_id"])
            await worker.release(result["analysis_id"])
    finally:
        await worker.close()
    output["complete"] = True
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline-worker", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(run(parser.parse_args()))
