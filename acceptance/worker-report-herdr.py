"""Public MCP check in a disposable local pane; existing terminals are untouched."""
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


async def run(args):
    proof = {'complete': False, 'ssh_tested': False, 'calls': []}
    params = StdioServerParameters(command=sys.executable,
        args=['-m', 'herdr_broker', 'mcp'], cwd=ROOT, env=dict(os.environ))
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as client:
            await client.initialize()

            async def call(tool, **arguments):
                response = await client.call_tool(tool, arguments)
                if response.is_error:
                    raise RuntimeError(str(response.content))
                value = response.structured_content
                proof['calls'].append({'tool': tool, 'result': value})
                args.output.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
                return value

            before = await call('pane_list', workspace_id=args.workspace)
            assert not before['truncated']
            anchor = next(p for p in before['panes'] if p['pane_id'] == args.anchor)
            identity = {k: anchor[k] for k in ('pane_id', 'terminal_id')}
            layout = await call('pane_layout', **identity)
            created = (await call('pane_split', **identity, request_id=uuid4().hex, direction='down'))['pane']
            target = {k: created[k] for k in ('pane_id', 'terminal_id')}
            try:
                await call('pane_rename', **target, name='보고 계약 검증', numbered=True)
                status = await call('pane_read', **target, purpose='status', objective='새 테스트 pane의 프로그램과 prompt, 미완성 입력 여부를 확인')
                print('PREFLIGHT=' + json.dumps(status, ensure_ascii=False), flush=True)
                if (await asyncio.to_thread(sys.stdin.readline)).strip() != 'continue':
                    raise RuntimeError('Preflight not accepted; no input sent')
                sent = await call('pane_execute', **target, request_id=uuid4().hex,
                    command="printf '%s\\n' 'BROKER_REPORT_PROBE' 'OS: SyntheticOS' 'CPU: 8 cores'")
                assert sent['submission'] == 'accepted' and sent['completion'] == 'not_observed'
                report = await call('pane_read', **target, requested_items=['OS', 'CPU', 'RAM'],
                    objective='BROKER_REPORT_PROBE 다음 실제 출력의 OS·CPU·RAM을 확인. 입력 echo를 결과와 구별',
                    analysis_id=status['analysis_id'])
                assert report['context_mode'] == 'independent' and not report['context_reused']
                print('REPORT=' + json.dumps(report, ensure_ascii=False), flush=True)
                observation = report['observation_id']
                await call('analysis_release', analysis_id=report['analysis_id'])
                original = await call('pane_excerpt', observation_id=observation,
                                      start_line=1, end_line=report['captured_lines'])
                await call('pane_execute', **target, request_id=uuid4().hex,
                           command="printf '%s\\n' 'LIVE_SCREEN_CHANGED_AFTER_SNAPSHOT'")
                changed = await call('pane_read', **target, purpose='status',
                                     objective='LIVE_SCREEN_CHANGED_AFTER_SNAPSHOT의 독립 출력 행과 prompt 복귀를 확인. 입력 echo만으로 실행을 단정하지 않기')
                current = await call('pane_excerpt', observation_id=changed['observation_id'],
                                     start_line=1, end_line=changed['captured_lines'])
                current_lines = [line.replace('\\u000d', '').strip()
                                 for excerpt in current['excerpts'] for line in excerpt['text'].splitlines()]
                assert 'LIVE_SCREEN_CHANGED_AFTER_SNAPSHOT' in current_lines
                await call('analysis_release', analysis_id=changed['analysis_id'])
                proof['live_changed_output_observed'] = True
                historical = await call('pane_excerpt', observation_id=observation,
                                        start_line=1, end_line=report['captured_lines'])
                assert historical['excerpts'] == original['excerpts']
                text = '\n'.join(e['text'] for e in historical['excerpts'])
                assert 'LIVE_SCREEN_CHANGED_AFTER_SNAPSHOT' not in text and historical['historical']
                lines = [line.replace('\\u000d', '').strip() for line in text.splitlines()]
                assert 'OS: SyntheticOS' in lines and 'CPU: 8 cores' in lines
                answers = report['report']['items']
                assert 'SyntheticOS' in answers[0]['value'] and '8' in answers[1]['value']
                assert answers[2]['basis'] == 'unknown'
                proof['historical_snapshot_after_release'] = True
            finally:
                await call('pane_close', **target, request_id=uuid4().hex)
            after = await call('pane_list', workspace_id=args.workspace)
            def signature(p):
                return p['pane_id'], p['terminal_id'], p['tab_id']
            assert sorted(map(signature, before['panes'])) == sorted(map(signature, after['panes']))
            assert (await call('pane_layout', **identity))['root'] == layout['root']
            proof['existing_terminals_and_layout_preserved'] = True
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as client:
            await client.initialize()
            response = await client.call_tool('pane_excerpt', {'observation_id': observation, 'start_line': 1, 'end_line': 1})
            assert response.is_error and 'snapshot_unavailable' in str(response.content)
            proof['restart_expires_snapshot'] = True
    proof['complete'] = True
    args.output.write_text(json.dumps(proof, ensure_ascii=False, indent=2))
    print('COMPLETE=' + json.dumps({k: v for k, v in proof.items() if k != 'calls'}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--anchor', required=True)
    parser.add_argument('--output', type=Path, required=True)
    asyncio.run(run(parser.parse_args()))
