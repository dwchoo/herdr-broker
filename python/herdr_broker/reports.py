"""Worker wire contracts and deterministic, source-exact public reports."""
from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .herdr import BrokerError
from .observations import Screen, Span, merge
from .snapshot import clean

Line = Annotated[int, Field(strict=True, ge=1, le=1000)]
Refs = Annotated[list[Annotated[int, Field(strict=True, ge=1, le=6)]], Field(max_length=6)]


class Contract(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Candidate(Contract):
    start_line: Line
    end_line: Line
    focus_line: Line
    anchor: str = Field(max_length=80)


class Answer(Contract):
    item: Annotated[int, Field(strict=True, ge=1, le=6)]
    value: str = Field(min_length=1, max_length=60)
    basis: Literal['observed', 'inferred', 'unknown']
    refs: Refs


class Finding(Contract):
    claim: str = Field(max_length=70)
    confidence: Literal['observed', 'likely', 'uncertain']
    refs: Refs


class AnalysisReport(Contract):
    observation_id: str
    summary: str = Field(max_length=160)
    items: list[Answer] = Field(max_length=6)
    findings: list[Finding] = Field(max_length=2)
    uncertainties: list[Annotated[str, Field(max_length=50)]] = Field(max_length=2)
    evidence: list[Candidate] = Field(max_length=6)


class StatusReport(Contract):
    observation_id: str
    summary: str = Field(max_length=60)
    lines: list[Line] = Field(max_length=2)
    uncertainty: str = Field(max_length=60)


def validate_items(items: list[str] | None, purpose: str, raw: bool = False) -> list[str]:
    if items is None:
        return []
    if purpose != 'analysis' or raw or not 1 <= len(items) <= 6 or len(set(items)) != len(items):
        raise BrokerError('invalid_requested_items')
    if any(not x.strip() or len(x) > 40 for x in items):
        raise BrokerError('invalid_requested_items')
    return items


def candidate_spans(screen: Screen, candidates: list[Candidate]) -> list[Span]:
    spans = []
    for c in candidates:
        if not c.start_line <= c.focus_line <= c.end_line:
            raise BrokerError('worker_invalid_evidence')
        try:
            span = screen.span(c.start_line, c.end_line)
        except BrokerError:
            raise BrokerError('worker_invalid_evidence') from None
        line = screen.lines[c.focus_line - 1]
        if (c.anchor and c.anchor not in line) or (len(line) > 3000 and not c.anchor):
            raise BrokerError('worker_invalid_evidence')
        spans.append(span)
    return spans


def extract(screen: Screen, candidates: list[Candidate], observation: str) -> tuple[list[dict[str, Any]],
                                                                                   list[dict[str, Any]],
                                                                                   list[dict[str, Any]]]:
    original = candidate_spans(screen, candidates)
    selected = list(original)
    while len(selected) > 1 and sum(b - a for a, b in merge(selected)) > 3000:
        selected.pop()
    if selected and selected[0][1] - selected[0][0] > 3000:
        c = candidates[0]
        a, b = screen.span(c.focus_line, c.focus_line)
        if b - a > 3000:
            hit = a + screen.lines[c.focus_line - 1].index(c.anchor)
            start = min(max(a, hit - (3000 - len(c.anchor)) // 2), b - 3000)
            selected[0] = (start, start + 3000)
        else:
            left = right = c.focus_line
            while left > c.start_line or right < c.end_line:
                if left > c.start_line:
                    trial = screen.span(left - 1, right)
                    if trial[1] - trial[0] > 3000:
                        break
                    left -= 1
                if right < c.end_line:
                    trial = screen.span(left, right + 1)
                    if trial[1] - trial[0] > 3000:
                        break
                    right += 1
            selected[0] = screen.span(left, right)
    segments = merge(selected)
    excerpts: list[dict[str, Any]] = []
    for a, b in segments:
        contributors = [i for i, (x, y) in enumerate(original) if x < b and a < y]
        location = screen.location((a, b))
        excerpts.append({
            'id': f"{observation}:L{location['start']['line']:04}",
            'text': screen.text[a:b], 'range': location,
            'original_ranges': [screen.location(original[i]) for i in contributors],
            'priority': min(contributors) + 1,
            'partial': any(original[i][0] < a or original[i][1] > b for i in contributors),
        })
    delivery = []
    for a, b in original:
        indices = [i for i, (x, y) in enumerate(segments) if x < b and a < y]
        covered = sum(max(0, min(b, segments[i][1]) - max(a, segments[i][0])) for i in indices)
        state = 'full' if covered == b - a and covered else 'partial' if covered else 'omitted'
        delivery.append({'evidence_ids': [excerpts[i]['id'] for i in indices], 'evidence_delivery': state})
    omitted = [{'candidate': i + 1, 'range': screen.location(span), 'reason': 'budget'}
               for i, span in enumerate(original) if i >= len(selected) and delivery[i]['evidence_delivery'] != 'full']
    if screen.text.strip() and not any(x['text'].strip() for x in excerpts):
        raise BrokerError('worker_invalid_evidence')
    return excerpts, omitted, delivery


def references(refs: list[int], delivery: list[dict[str, Any]], required: bool) -> dict[str, Any]:
    if (required and not refs) or len(refs) != len(set(refs)) or any(r > len(delivery) for r in refs):
        raise BrokerError('worker_invalid_evidence')
    parts = [delivery[r - 1] for r in refs]
    states = {p['evidence_delivery'] for p in parts}
    state = ('none' if not parts else 'full' if states == {'full'} else
             'omitted' if states == {'omitted'} else 'partial')
    return {'evidence_ids': list(dict.fromkeys(e for p in parts for e in p['evidence_ids'])),
            'evidence_delivery': state}


def build_report(final: str, text: str, observation: str, purpose: str,
                 items: list[str], patterns: list[str]) -> dict[str, Any]:
    screen = Screen(text)
    try:
        if purpose == 'status':
            status = StatusReport.model_validate_json(final)
            if len(status.lines) != len(set(status.lines)):
                raise BrokerError('worker_invalid_evidence')
            status = StatusReport.model_validate(dict(status.model_dump(),
                summary=clean(status.summary, patterns), uncertainty=clean(status.uncertainty, patterns)))
            response_id = status.observation_id
            if any(n > len(screen.lines) for n in status.lines):
                raise BrokerError('worker_invalid_evidence')
            candidates = [Candidate(start_line=n, end_line=n, focus_line=n,
                anchor=screen.lines[n - 1][:80] if len(screen.lines[n - 1]) > 3000 else '') for n in status.lines]
            if len(status.model_dump_json().encode()) > 1024:
                raise BrokerError('worker_report_too_large')
            report: dict[str, Any] = dict(summary=clean(status.summary, patterns), items=[], findings=[],
                next_checks=[], uncertainties=[clean(status.uncertainty, patterns)] if status.uncertainty else [])
            analysis = None
        else:
            analysis = AnalysisReport.model_validate_json(final)
            if any(not a.value.strip() for a in analysis.items):
                raise BrokerError('worker_invalid_report')
            response_id, candidates = analysis.observation_id, analysis.evidence
            if [answer.item for answer in analysis.items] != list(range(1, len(items) + 1)):
                raise BrokerError('worker_invalid_items')
            # Revalidate after masking: escaping or redaction may expand the response.
            data = analysis.model_dump()
            data['summary'] = clean(data['summary'], patterns)
            data['uncertainties'] = [clean(s, patterns) for s in data['uncertainties']]
            for answer in data['items']:
                answer['value'] = clean(answer['value'], patterns)
            for finding in data['findings']:
                finding['claim'] = clean(finding['claim'], patterns)
            analysis = AnalysisReport.model_validate(data)
            report = dict(summary=analysis.summary, items=[], findings=[], next_checks=[],
                          uncertainties=analysis.uncertainties)
    except ValidationError:
        raise BrokerError('worker_invalid_report') from None
    if response_id != observation:
        raise BrokerError('worker_invalid_evidence')
    excerpts, omitted, delivery = extract(screen, candidates, observation)
    if purpose == 'status':
        if candidates:
            report['findings'] = [dict(claim=report['summary'],
                confidence='uncertain' if report['uncertainties'] else 'likely',
                **references(list(range(1, len(candidates) + 1)), delivery, True))]
        if len(json.dumps(report, ensure_ascii=False, separators=(',', ':')).encode()) > 1024:
            raise BrokerError('worker_report_too_large')
    else:
        assert analysis is not None
        report['items'] = [dict(item=items[a.item - 1], value=a.value, basis=a.basis,
                               **references(a.refs, delivery, a.basis != 'unknown')) for a in analysis.items]
        report['findings'] = [dict(claim=f.claim, confidence=f.confidence,
                                  **references(f.refs, delivery, True)) for f in analysis.findings]
        chars = (len(report['summary']) + sum(len(a['item']) + len(a['value']) for a in report['items'])
                 + sum(len(f['claim']) for f in report['findings']) + sum(map(len, report['uncertainties'])))
        if chars > 1000:
            raise BrokerError('worker_report_too_large')
    return {'report': report, 'evidence': excerpts, 'omitted_evidence': omitted, 'empty': not text.strip(),
            'report_bytes': len(json.dumps(report, ensure_ascii=False, separators=(',', ':')).encode())}
