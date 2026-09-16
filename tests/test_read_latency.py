import pytest
from test_mcp import call

IDENTITY = {"pane_id": "w1:p2", "terminal_id": "term_2"}


async def test_default_read_limits_history_but_preserves_pending_input(harness):
    peer, _, server, worker = harness
    peer.text = '\n'.join(f'old build {i}' for i in range(1000)) + '\nuser@host:~$ unfinished'
    result = await call(server, 'pane_read', **IDENTITY, objective='OS 정보와 현재 입력 상태')
    text, _ = worker.calls[-1]
    assert len(text.split('\n')) == 80
    assert text.endswith('user@host:~$ unfinished')
    assert 'old build 0\n' not in text
    assert result['max_lines'] == 80 and result['truncated'] and result['effort'] == 'low'
    assert result['timings_ms']['capture'] >= 0
    assert result['timings_ms']['total'] >= result['timings_ms']['capture']
    assert [p['lines'] for m, p in peer.calls if m == 'pane.read'] == [80]


async def test_explicit_range_effort_and_raw_compatibility(harness):
    peer, _, server, worker = harness
    peer.text = '\n'.join(str(i) for i in range(250))
    result = await call(server, 'pane_read', **IDENTITY, max_lines=200, effort='medium')
    assert len(worker.calls[-1][0].split('\n')) == 200
    assert result['max_lines'] == 200 and result['effort'] == 'medium'
    raw = await call(server, 'pane_read', **IDENTITY, raw=True)
    assert raw['text'] == peer.text and raw['max_lines'] == 1000
    tail = await call(server, 'pane_read', **IDENTITY, raw=True, max_lines=2)
    assert tail['text'] == '248\n249' and tail['truncated']


@pytest.mark.parametrize('options', [{'max_lines': 0}, {'max_lines': 1001}, {'effort': 'invalid'}])
async def test_invalid_read_options_never_capture(harness, options):
    peer, _, server, _ = harness
    with pytest.raises(Exception):
        await server.call_tool('pane_read', {**IDENTITY, **options})
    assert not any(m == 'pane.read' for m, _ in peer.calls)


async def test_replacement_during_analysis_rejects_result(harness, monkeypatch):
    peer, _, server, worker = harness

    async def analyze(text, objective, patterns, effort, timings):
        peer.panes[1]["terminal_id"] = "replacement"
        return {"report": {"summary": "old screen"}}

    monkeypatch.setattr(worker, "_analyze", analyze)
    with pytest.raises(Exception, match="target_changed"):
        await server.call_tool("pane_read", IDENTITY)
    assert not any(m == "pane.send_input" for m, _ in peer.calls)
