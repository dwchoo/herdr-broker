"""Compare synthetic baseline/current reports with the real SDK at standard speed."""
import argparse
import asyncio
import importlib.util
import json
import statistics
import sys
from pathlib import Path
from time import perf_counter

import herdr_broker.worker as worker_module
from herdr_broker.worker import Worker

SHORT = 'user@host$ printf "done\\n"\ndone\nuser@host$'
ONE_K = ('older output ignored ' * 60 + '\nuser@host$')[-1024:]
HARDWARE = 'OS: Ubuntu 24.04\nCPU: 8 logical CPUs\nMemory: 32768 MiB\nuser@host$'
LOG = '\n'.join(f'test_{n} passed' for n in range(72)) + '\nerror TS2305: module has no exported member Widget\nBuild FAILED\nuser@host$'
SCENARIOS = [
    ('status', SHORT, '상태와 명령 결과를 확인', 'status', None),
    ('status_1k', ONE_K, '현재 prompt와 미완성 입력을 확인', 'status', None),
    ('hardware', HARDWARE, 'OS, CPU, RAM 정보를 확인', 'analysis', ['OS', 'CPU', 'RAM']),
    ('build', LOG, '실패 원인과 성공 여부를 확인', 'analysis', ['성공 여부', '실패 원인']),
]
QUALITY = [
    ('error_then_success', 'fatal: disk full\ncleanup successful\nuser@host$', '작업 성공 여부와 오류를 확인', ['성공 여부', '오류']),
    ('echo_only', 'user@host$ echo SUCCESS_MARKER', '명령이 실행 완료됐는지 확인', ['실행 완료 여부']),
    ('running', 'downloading: 43%\n', '진행 상태를 확인', ['진행 상태']),
    ('early_cause', 'fatal: missing configuration\n' + '\n'.join('cleanup OK' for _ in range(75)), '최초 실패 원인을 확인', ['실패 원인']),
    ('long_error', 'x' * 4000 + 'ERROR: missing CONFIG_PATH' + 'y' * 1000, '오류 원인을 확인', ['오류 원인']),
    ('missing', 'OS: Ubuntu\nuser@host$', 'OS, RAM을 확인', ['OS', 'RAM']),
]


async def run(args):
    spec = importlib.util.spec_from_file_location('herdr_broker._report_baseline', args.baseline_worker)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    output = dict(complete=False, synthetic=True, samples=[], quality=[])
    if args.resume_baseline:
        previous = json.loads(args.resume_baseline.read_text())
        output['samples'] = [r for r in previous['samples'] if r['profile'] == 'baseline']
    last_wire = {}
    original_build = worker_module.build_report

    def inspect_synthetic(final, *params):
        last_wire['text'] = final
        return original_build(final, *params)

    worker_module.build_report = inspect_synthetic

    def save():
        args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2))

    profiles = [('current', Worker)] if args.resume_baseline else [('baseline', module.Worker), ('current', Worker)]
    for profile, cls in profiles:
        for label, text, objective, purpose, items in SCENARIOS:
            worker = cls()
            analysis_id = None
            try:
                for repeat in range(6):
                    async def capture():
                        return text
                    began = perf_counter()
                    kwargs = {'purpose': purpose, 'analysis_id': analysis_id}
                    if profile == 'current' and items:
                        kwargs['requested_items'] = items
                    try:
                        result = await worker.analyze(capture, objective, [], **kwargs)
                        analysis_id = result['analysis_id']
                        sample = dict(profile=profile, scenario=label, warm=repeat > 0,
                            seconds=perf_counter() - began, usage=result['usage'], input_sizes=result['input_sizes'],
                            timings_ms=result['timings_ms'], report=result['report'], evidence=result['evidence'],
                            response_bytes=len(json.dumps(result, ensure_ascii=False).encode()),
                            pid=worker.runtime.process.pid)
                    except Exception as exc:
                        sample = dict(profile=profile, scenario=label, warm=repeat > 0,
                                      seconds=perf_counter() - began, error=getattr(exc, 'code', type(exc).__name__), synthetic_wire=last_wire.get('text'))
                        analysis_id = None
                    output['samples'].append(sample)
                    save()
                    print(json.dumps({k: v for k, v in sample.items() if k not in ('report', 'evidence', 'synthetic_wire')}, ensure_ascii=False), flush=True)
            finally:
                await worker.close()
    worker = Worker()
    try:
        for label, text, objective, items in QUALITY:
            async def capture():
                return text
            try:
                result = await worker.analyze(capture, objective, [], requested_items=items)
                output['quality'].append(dict(scenario=label, report=result['report'], evidence=result['evidence'],
                                              usage=result['usage'], seconds=result['timings_ms']))
            except Exception as exc:
                output['quality'].append(dict(scenario=label, error=getattr(exc, 'code', type(exc).__name__), synthetic_wire=last_wire.get('text')))
            save()
    finally:
        await worker.close()
    output['summary'] = []
    for p in ('baseline', 'current'):
        for label, *_ in SCENARIOS:
            warm = [r for r in output['samples'] if r['profile'] == p and r['scenario'] == label and r['warm']]
            successful = [r for r in warm if 'error' not in r]
            output['summary'].append(dict(profile=p, scenario=label, warm_successes=len(successful),
                failures=sum('error' in r for r in warm), sample_requirement_met=len(successful) == 5,
                median_seconds=statistics.median(r['seconds'] for r in successful) if successful else None,
                max_seconds=max((r['seconds'] for r in successful), default=None)))
    output['sample_requirements_met'] = all(r['sample_requirement_met'] for r in output['summary'])
    output['quality_requires_review'] = True
    output['complete'] = True
    save()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline-worker', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--resume-baseline', type=Path)
    asyncio.run(run(parser.parse_args()))
