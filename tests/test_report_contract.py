import asyncio
import json
import time
from datetime import UTC, datetime

import pytest
from herdr_broker.herdr import BrokerError
from herdr_broker.observations import Observations, Screen
from herdr_broker.reports import build_report
from test_mcp import call

IDENTITY = {'pane_id': 'w1:p2', 'terminal_id': 'term_2'}


def candidate(start, end=None, focus=None, anchor=''):
    return dict(start_line=start, end_line=end or start, focus_line=focus or start, anchor=anchor)


def report(text, candidates=None, **extra):
    value = dict(observation_id='obs', summary='결과', items=[], findings=[], uncertainties=[],
                 evidence=candidates if candidates is not None else [candidate(1)])
    value.update(extra)
    return build_report(json.dumps(value), text, 'obs', 'analysis', [], [])


def original(screen, location):
    a, b = location['start'], location['end']
    return screen.text[screen.starts[a['line'] - 1] + a['column']:screen.starts[b['line'] - 1] + b['column']]


def test_requested_answers_and_missing_values_have_distinct_meaning():
    wire = dict(observation_id='obs', summary='OS 확인, RAM 미확인', items=[
        dict(item=1, value='Ubuntu', basis='observed', refs=[1]),
        dict(item=2, value='화면에 용량 없음', basis='unknown', refs=[]),
    ], findings=[], uncertainties=[], evidence=[candidate(1)])
    result = build_report(json.dumps(wire), 'Ubuntu', 'obs', 'analysis', ['OS', 'RAM'], [])
    assert result['report']['items'][0]['item'] == 'OS'
    assert result['report']['items'][0]['evidence_delivery'] == 'full'
    assert result['report']['items'][1]['evidence_delivery'] == 'none'
    assert result['report']['next_checks'] == []
    for indices in ([], [1], [1, 1], [2, 1]):
        bad = dict(wire, items=[dict(item=i, value='x', basis='unknown', refs=[]) for i in indices])
        with pytest.raises(BrokerError, match='worker_invalid_items'):
            build_report(json.dumps(bad), 'Ubuntu', 'obs', 'analysis', ['OS', 'RAM'], [])


@pytest.mark.parametrize('candidates', [[candidate(1, 99)], [candidate(2, 2, 1)], [candidate(1, anchor='fake')]])
def test_invalid_current_evidence_is_not_repaired(candidates):
    with pytest.raises(BrokerError, match='worker_invalid_evidence'):
        report('first\nsecond', candidates)


def test_unicode_partial_overlap_is_extracted_once_and_source_exact():
    text = '\n'.join('내용 ' + str(n) for n in range(6))
    result = report(text, [candidate(1, 4), candidate(3, 6), candidate(1, 4)])
    assert len(result['evidence']) == 1 and result['evidence'][0]['text'] == text
    assert result['evidence'][0]['id'] == 'obs:L0001'
    assert original(Screen(text), result['evidence'][0]['range']) == text
    assert not result['evidence'][0]['partial']


def test_disjoint_excerpts_are_not_joined_and_budget_omission_is_visible():
    result = report('a' * 1600 + '\n' + 'b' * 1600, [candidate(1), candidate(2)],
                    findings=[dict(claim='두 번째', confidence='observed', refs=[2])])
    assert result['evidence'][0]['text'] == 'a' * 1600
    assert result['omitted_evidence'][0]['candidate'] == 2
    assert result['report']['findings'][0]['evidence_delivery'] == 'omitted'
    assert result['report']['findings'][0]['confidence'] == 'observed'
    result = report('first\nignore\nlast', [candidate(1), candidate(3)])
    assert [e['text'] for e in result['evidence']] == ['first', 'last']


def test_long_line_anchor_partial_and_first_duplicate_anchor():
    text = '가' * 3500 + 'CAUSE' + '나' * 4000 + 'CAUSE'
    result = report(text, [candidate(1, anchor='CAUSE')],
                    findings=[dict(claim='오류 위치', confidence='observed', refs=[1])])
    e = result['evidence'][0]
    assert len(e['text']) == 3000 and 'CAUSE' in e['text'] and e['partial']
    assert original(Screen(text), e['range']) == e['text']
    assert e['range']['start']['column'] < 3500 < e['range']['end']['column']
    assert result['report']['findings'][0]['evidence_delivery'] == 'partial'
    with pytest.raises(BrokerError, match='worker_invalid_evidence'):
        report(text, [candidate(1)])


def test_multiline_partial_stays_inside_original_candidate():
    text = '\n'.join(str(n) + 'x' * 998 for n in range(8))
    result = report(text, [candidate(2, 7, 5)])
    e = result['evidence'][0]
    assert len(e['text']) <= 3000 and e['partial']
    assert e['range']['start']['line'] >= 2 and e['range']['end']['line'] <= 7
    assert original(Screen(text), e['range']) == e['text']
    assert '5' not in e['text'][:1]  # focus is 1-based line 5, with preceding context


@pytest.mark.parametrize('text', ['', '\n  \n'])
def test_empty_screen_needs_no_invented_evidence(text):
    result = report(text, [])
    assert result['empty'] and result['evidence'] == []
    with pytest.raises(BrokerError, match='worker_invalid_evidence'):
        report('real output', [])


def test_status_expansion_handles_long_line_without_more_model_fields():
    wire = dict(observation_id='obs', summary='긴 출력', lines=[1], uncertainty='끝부분 미확인')
    result = build_report(json.dumps(wire), '가' * 6000, 'obs', 'status', [], [])
    assert len(result['evidence'][0]['text']) == 3000 and result['evidence'][0]['partial']


async def test_public_items_are_validated_before_capture_and_new_read_never_dedupes(harness):
    peer, broker, server, worker = harness
    first = await call(server, 'pane_read', **IDENTITY, requested_items=['OS', 'RAM'], request_id='same')
    second = await call(server, 'pane_read', **IDENTITY, requested_items=['OS', 'RAM'], request_id='same')
    assert first['observation_id'] != second['observation_id'] and not broker.submissions
    assert [x['item'] for x in first['report']['items']] == ['OS', 'RAM']
    for options in (dict(requested_items=[]), dict(requested_items=[' ']), dict(requested_items=['OS', 'OS']),
                    dict(requested_items=['OS'], purpose='status'), dict(requested_items=['OS'], raw=True)):
        before = len(worker.calls)
        with pytest.raises(Exception):
            await server.call_tool('pane_read', {**IDENTITY, **options})
        assert len(worker.calls) == before
    assert len([1 for m, _ in peer.calls if m == 'pane.read']) == 2


async def test_public_excerpt_is_historical_masked_and_survives_analysis_release(harness):
    peer, broker, server, worker = harness
    peer.text = '\x1b[31merror\x1b[0m\npassword=private\nsynthetic-secret'
    r = await call(server, 'pane_read', **IDENTITY)
    await call(server, 'analysis_release', analysis_id=r['analysis_id'])
    peer.text = 'CHANGED LIVE SCREEN'
    peer.calls.clear()
    count = len(worker.calls)
    excerpt = await call(server, 'pane_excerpt', observation_id=r['observation_id'], start_line=1, end_line=3)
    assert not peer.calls and len(worker.calls) == count
    text = ''.join(e['text'] for e in excerpt['excerpts'])
    assert 'private' not in text and 'synthetic-secret' not in text and '\x1b' not in text
    assert 'error' in text and 'CHANGED' not in text
    assert excerpt['historical'] and excerpt['captured_at'] == r['captured_at']
    assert broker.observations.bytes == len(text.encode())


def metadata():
    return {'captured_at': datetime.now(UTC).isoformat(), 'pane_id': 'p', 'terminal_id': 't'}


async def test_retention_has_timer_capacity_bytes_and_shutdown():
    store = Observations(ttl=0.03, capacity=2, max_bytes=12)
    store.put('a', '한글', metadata(), time.monotonic())
    store.put('b', '가나', metadata(), time.monotonic())
    assert store.bytes == 12
    store.put('c', '12', metadata(), time.monotonic())
    assert 'a' not in store.records and store.bytes == 8
    with pytest.raises(BrokerError, match='snapshot_unavailable'):
        store.excerpt('a', 1, 1)
    store.excerpt('b', 1, 1)
    await asyncio.sleep(0.06)
    assert not store.records and store.bytes == 0
    store.put('d', 'ok', metadata(), time.monotonic())
    store.close()
    assert not store.records


async def test_excerpt_long_line_search_pagination_tamper_and_snapshot_binding():
    store = Observations()
    text = '前' * 6000 + 'NEEDLE' + '後' * 5000
    try:
        store.put('a', text, metadata(), time.monotonic())
        store.put('b', text, metadata(), time.monotonic())
        first = store.excerpt('a', query='NEEDLE')
        assert 'NEEDLE' in first['excerpts'][0]['text'] and first['unreturned_ranges']
        cursor = first['next_cursor']
        with pytest.raises(BrokerError, match='invalid_excerpt_cursor'):
            store.excerpt('b', cursor=cursor)
        with pytest.raises(BrokerError, match='invalid_excerpt_cursor'):
            store.excerpt('a', cursor=cursor[:-3] + 'xyz')
        with pytest.raises(BrokerError, match='invalid_excerpt_selector'):
            store.excerpt('a', query='NEEDLE', cursor=cursor)
        pieces = list(first['excerpts'])
        while cursor:
            result = store.excerpt('a', cursor=cursor)
            pieces.extend(result['excerpts'])
            cursor = result['next_cursor']
        pieces.sort(key=lambda e: e['range']['start']['column'])
        assert ''.join(e['text'] for e in pieces) == text
        assert all(original(Screen(text), e['range']) == e['text'] for e in pieces)
        assert not store.excerpt('a', query='missing')['matched']
        assert len(store.records) == 2  # no query sessions are accumulated
        with pytest.raises(BrokerError, match='invalid_evidence_range'):
            store.excerpt('a', 2, 2)
    finally:
        store.close()


async def test_search_multiple_matches_and_ranges_paginate_without_overlap():
    store = Observations()
    text = '\n'.join(('MATCH' if i % 3 == 0 else 'other') + str(i) + 'x' * 90 for i in range(150))
    try:
        store.put('a', text, metadata(), time.monotonic())
        result = store.excerpt('a', query='MATCH')
        contents = []
        while True:
            contents.extend(e['text'] for e in result['excerpts'])
            if not result['next_cursor']:
                break
            result = store.excerpt('a', cursor=result['next_cursor'])
        assert ''.join(contents) == text
    finally:
        store.close()


def test_covered_low_priority_candidate_is_not_falsely_reported_omitted():
    result = report('a' * 2000 + '\n' + 'b' * 2000,
                    [candidate(1), candidate(2), candidate(1)],
                    findings=[dict(claim='첫 번째 반복 근거', confidence='observed', refs=[3])])
    assert [o['candidate'] for o in result['omitted_evidence']] == [2]
    assert result['report']['findings'][0]['evidence_delivery'] == 'full'


async def test_shutdown_does_not_retain_a_late_completed_capture():
    store = Observations()
    store.close()
    store.put('late', 'screen', metadata(), time.monotonic())
    assert not store.records and store.bytes == 0


@pytest.mark.parametrize('value', ['', '   ', '\n'])
def test_unknown_item_requires_an_explanation(value):
    wire = dict(observation_id='obs', summary='미확인', items=[dict(item=1, value=value, basis='unknown', refs=[])],
                findings=[], uncertainties=[], evidence=[candidate(1)])
    with pytest.raises(BrokerError, match='worker_invalid_report'):
        build_report(json.dumps(wire), 'user@host$', 'obs', 'analysis', ['RAM'], [])


async def test_search_match_at_page_boundary_is_returned_whole():
    store = Observations()
    try:
        text = 'x' * 3999 + 'NEEDLE' + 'y' * 100
        store.put('a', text, metadata(), time.monotonic())
        result = store.excerpt('a', query='NEEDLE')
        assert 'NEEDLE' in result['excerpts'][0]['text']
    finally:
        store.close()


async def test_late_completed_old_capture_does_not_evict_newer_snapshot():
    store = Observations(capacity=1)
    try:
        captured = time.monotonic()
        store.put('newer', 'newer', metadata(), captured)
        store.put('older', 'older', metadata(), captured - 10)
        assert list(store.records) == ['newer'] and store.bytes == 5
    finally:
        store.close()
