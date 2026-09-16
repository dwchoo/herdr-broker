"""Measure Worker-owned context changes using synthetic text and standard speed."""
import argparse
import asyncio
import importlib.util
import json
import sys
from pathlib import Path
from time import perf_counter

from herdr_broker.worker import Worker


async def run(args):
    spec = importlib.util.spec_from_file_location('herdr_broker._profile_baseline', args.baseline_worker)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    output = {'synthetic': True, 'complete': False, 'samples': []}
    for profile, cls in [('baseline', module.Worker), ('current', Worker)]:
        worker = cls()
        try:
            for label in (['status'] if profile == 'baseline' else ['status', 'analysis', 'status_1k']):
                purpose = 'analysis' if label == 'analysis' else 'status'
                async def capture():
                    if label == 'status_1k':
                        history = ''.join(f'previous hardware output {i}: Linux CPU=8 RAM=32768 MiB disk=400G\n' for i in range(30))
                        return (history + 'user@host:~$ ').encode()[-1024:].decode()
                    return 'user@host:~$ printf "done\\n"\ndone\nuser@host:~$ '
                began = perf_counter()
                result = await worker.analyze(capture, '명령 결과와 prompt 복귀 상태를 확인해 주세요.', [], purpose=purpose)
                output['samples'].append({
                    'profile': profile, 'label': label, 'purpose': purpose, 'effort': result['effort'],
                    'service_tier_requested': result.get('service_tier_requested'),
                    'seconds': perf_counter() - began, 'usage': result['usage'],
                    'input_sizes': result['input_sizes'], 'timings_ms': result['timings_ms'],
                })
                print(json.dumps(output['samples'][-1], ensure_ascii=False), flush=True)
                args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2))
                await worker.release(result['analysis_id'])
        finally:
            await worker.close()
    output['complete'] = True
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline-worker', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    asyncio.run(run(parser.parse_args()))
