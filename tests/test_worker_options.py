import json
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import get_args
from unittest.mock import AsyncMock

import pytest
from conftest import StubWorker
from herdr_broker.cli import argument_parser, setup
from herdr_broker.herdr import BrokerError
from herdr_broker.options import Effort, WorkerOptions, export_templates, load_templates
from herdr_broker.reports import BUDGETS, analysis_contract, build_report
from herdr_broker.sdk_runtime import analysis_profile, validate_model
from openai_codex.types import ReasoningEffort
from test_mcp import call
from test_report_contract import candidate


def test_cli_defaults_choices_and_sdk_enum():
    parser = argument_parser()
    args = parser.parse_args(['mcp', '--project', '/tmp'])
    assert args.analysis_model == args.status_model == 'gpt-5.6-luna'
    assert (args.analysis_effort, args.status_effort, args.fast_mode, args.response_length_mode) == (
        'medium', 'low', 'off', 'medium')
    assert set(get_args(Effort)) == {e.value for e in ReasoningEffort}
    for flag, bad in [('--fast-mode', 'true'), ('--response-length-mode', 'wide'), ('--status-effort', 'invalid')]:
        with pytest.raises(SystemExit):
            parser.parse_args(['mcp', '--project', '/tmp', flag, bad])
    assert parser.parse_args(['templates', '--output-dir', '/tmp']).command == 'templates'


def test_setup_source_options_preserves_config_and_is_repeatable(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    directory = tmp_path / '.codex'
    directory.mkdir()
    path = directory / 'config.toml'
    prefix = 'approval_policy="never"\n[mcp_servers.other]\ncommand="other"\n'
    path.write_text(prefix)
    options = WorkerOptions(status_model='status-model', analysis_effort='high', fast_mode='analysis',
                            response_length_mode='auto', template_dir=tmp_path / 'templates')
    source = 'git+https://github.com/dwchoo/herdr-broker.git@main'
    setup(tmp_path, source, options)
    first = path.read_text()
    setup(tmp_path, source, options)
    assert path.read_text() == first and first.startswith(prefix)
    config = tomllib.loads(first)['mcp_servers']['herdr_broker']
    assert config['command'].endswith('uvx')
    assert config['args'] == ['--from', source, 'herdr-broker', 'mcp', '--project', str(tmp_path), *options.arguments()]
    assert '--refresh' not in config['args']


def test_installed_setup_keeps_git_branch(tmp_path, monkeypatch):
    from types import SimpleNamespace

    import herdr_broker.cli as cli
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(cli, 'distribution', lambda _: SimpleNamespace(version='0.2.0', read_text=lambda _: json.dumps({
        'url': 'https://example.test/project.git', 'vcs_info': {'requested_revision': 'main', 'commit_id': 'abcdef'}
    })))
    setup(tmp_path)
    args = tomllib.loads((tmp_path / '.codex/config.toml').read_text())['mcp_servers']['herdr_broker']['args']
    assert args[1] == 'git+https://example.test/project.git@main'


def test_cli_templates_without_context_and_relative_template_dir(tmp_path):
    target = tmp_path / 'templates'
    result = subprocess.run([sys.executable, '-m', 'herdr_broker', 'templates', '--output-dir', str(target)],
                            capture_output=True, text=True, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    assert len(json.loads(result.stdout)['templates']) == 2
    result = subprocess.run([sys.executable, '-m', 'herdr_broker', 'setup', '--project', str(tmp_path),
                             '--source', 'git+https://example.test/repo.git@main', '--template-dir', 'templates'],
                            capture_output=True, text=True, cwd=tmp_path)
    assert result.returncode == 0, result.stderr
    args = tomllib.loads((tmp_path / '.codex/config.toml').read_text())['mcp_servers']['herdr_broker']['args']
    assert args[-2:] == ['--template-dir', str(target)]


def test_templates_export_and_validation(tmp_path):
    exported = export_templates(tmp_path)
    assert {Path(p).name for p in exported} == {'analysis.md', 'status.md'}
    original = (tmp_path / 'status.md').read_bytes()
    with pytest.raises(BrokerError, match='template_already_exists'):
        export_templates(tmp_path)
    assert (tmp_path / 'status.md').read_bytes() == original
    path = tmp_path / 'analysis.md'
    path.write_text('# 분석\n나의 응답 지침', encoding='utf-8')
    assert '나의 응답 지침' in load_templates(tmp_path)['analysis']
    for data in (b'', b' \n', b'\xff', b'x' * 8193):
        path.write_bytes(data)
        with pytest.raises(BrokerError, match='worker_template_invalid'):
            load_templates(tmp_path)
    path.write_bytes(b'x' * 8192)
    assert len(load_templates(tmp_path)['analysis']) == 8192
    path.unlink()
    with pytest.raises(BrokerError, match='worker_template_invalid'):
        load_templates(tmp_path)


def test_catalog_two_selected_models_and_validation(sdk_home, tmp_path):
    cache = sdk_home / 'models_cache.json'
    data = json.loads(cache.read_text())
    data['models'] += [dict(data['models'][0], slug='status-model'), dict(data['models'][0], slug='unused')]
    cache.write_text(json.dumps(data))
    _, path = analysis_profile(str(tmp_path), ('status-model', 'gpt-5.6-luna'))
    selected = json.loads(path.read_text())['models']
    assert [m['slug'] for m in selected] == ['status-model', 'gpt-5.6-luna']
    assert all(m['tool_mode'] == 'direct' and not m['supports_search_tool'] for m in selected)
    validate_model(selected[0], 'low', 'fast')
    with pytest.raises(BrokerError, match='worker_effort_unsupported'):
        validate_model(selected[0], 'ultra', 'default')
    with pytest.raises(BrokerError, match='worker_fast_unsupported'):
        validate_model(dict(selected[0], service_tiers=[]), 'low', 'fast')


@pytest.mark.parametrize('mode,expected', [('off', ['default', 'default']), ('analysis', ['default', 'fast']),
                                          ('status', ['fast', 'default']), ('all', ['fast', 'fast'])])
async def test_public_fast_routing_inheritance_and_override(harness, mode, expected):
    _, broker, server, _ = harness
    worker = StubWorker(options=WorkerOptions(fast_mode=mode, status_effort='high'))
    broker.worker = worker
    try:
        identity = dict(pane_id='w1:p2', terminal_id='term_2')
        results = [await call(server, 'pane_read', **identity, purpose=p) for p in ('status', 'analysis')]
        assert [r['service_tier_requested'] for r in results] == expected
        assert results[0]['effort'] == 'high'
        r = await call(server, 'pane_read', **identity, purpose='status', effort='low', service_tier='default')
        assert r['effort'] == 'low' and r['service_tier_requested'] == 'default'
        r = await call(server, 'pane_read', **identity, purpose='status', effort=None, service_tier=None)
        assert r['effort'] == 'high' and r['service_tier_requested'] == expected[0]
    finally:
        await worker.close()


@pytest.mark.parametrize('mode', ['short', 'medium', 'long'])
def test_length_boundaries_unicode_and_exact_evidence(mode):
    factor = {'short': 0.5, 'medium': 1, 'long': 2}[mode]
    text = '가' * 7000 + '원인' + '나' * 1000
    wire = dict(observation_id='obs', summary='가' * int(160 * factor), items=[], findings=[], uncertainties=[],
                evidence=[candidate(1, anchor='원인')])
    result = build_report(json.dumps(wire), text, 'obs', 'analysis', [], [], mode)
    assert result['response_length_mode'] == result['response_length_used'] == mode
    excerpt = result['evidence'][0]
    assert len(excerpt['text']) == BUDGETS[mode][1] and '원인' in excerpt['text']
    assert excerpt['partial']
    wire['summary'] += '가'
    with pytest.raises(BrokerError, match='worker_invalid_report'):
        build_report(json.dumps(wire), text, 'obs', 'analysis', [], [], mode)


def test_short_aggregate_counts_item_labels():
    wire = dict(observation_id='obs', summary='가' * 80,
                items=[dict(item=i+1, value='가' * 30, basis='unknown', refs=[]) for i in range(6)],
                findings=[], uncertainties=['추가'], evidence=[candidate(1)])
    # 80 + six (40-char labels + 30-char values) = 500, before the uncertainty.
    labels = [str(i) + '가' * 39 for i in range(6)]
    with pytest.raises(BrokerError, match='worker_report_too_large'):
        build_report(json.dumps(wire), 'result', 'obs', 'analysis', labels, [], 'short')
    wire['uncertainties'] = []
    assert build_report(json.dumps(wire), 'result', 'obs', 'analysis', labels, [], 'short')['report']


@pytest.mark.parametrize('choice', ['medium', 'long'])
def test_auto_validates_selected_budget(choice):
    wire = dict(observation_id='obs', response_length=choice, summary='가' * 161,
                items=[], findings=[], uncertainties=[], evidence=[candidate(1)])
    if choice == 'medium':
        with pytest.raises(BrokerError, match='worker_invalid_report'):
            build_report(json.dumps(wire), 'result', 'obs', 'analysis', [], [], 'auto')
    else:
        result = build_report(json.dumps(wire), 'result', 'obs', 'analysis', [], [], 'auto')
        assert result['response_length_used'] == 'long'
    wire.pop('response_length')
    with pytest.raises(BrokerError, match='worker_invalid_report'):
        build_report(json.dumps(wire), 'result', 'obs', 'analysis', [], [], 'auto')
    assert analysis_contract('auto').model_json_schema()['properties']['response_length']['enum'] == ['medium', 'long']


async def test_invalid_profile_does_not_capture_or_block_metadata(harness, sdk_home, tmp_path):
    from herdr_broker.worker import Worker
    peer, broker, server, _ = harness
    worker = Worker(options=WorkerOptions(status_effort='ultra'))
    broker.worker = worker
    try:
        with pytest.raises(Exception, match='worker_effort_unsupported'):
            await server.call_tool('pane_read', dict(pane_id='w1:p2', terminal_id='term_2'))
        assert 'pane.read' not in [method for method, _ in peer.calls]
        assert (await call(server, 'pane_list'))['panes']
        assert worker.runtime is None
    finally:
        await worker.close()


async def test_unsupported_call_override_does_not_capture_or_poison_worker():
    worker = StubWorker()
    capture = AsyncMock(return_value='prompt')
    try:
        with pytest.raises(BrokerError, match='worker_effort_unsupported'):
            await worker.analyze(capture, '', [], effort='ultra')
        capture.assert_not_called()
        assert (await worker.analyze(capture, '', []))['effort'] == 'medium'
    finally:
        await worker.close()
