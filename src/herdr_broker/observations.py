"""Bounded sanitized observations and stateless, authenticated excerpt cursors."""
from __future__ import annotations

import asyncio
import base64
import bisect
import hmac
import json
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from time import monotonic
from typing import Any

from .herdr import BrokerError

Span = tuple[int, int]


def merge(spans: list[Span]) -> list[Span]:
    result: list[Span] = []
    for start, end in sorted(spans):
        if start == end:
            continue
        if result and start <= result[-1][1]:
            result[-1] = (result[-1][0], max(end, result[-1][1]))
        else:
            result.append((start, end))
    return result


class Screen:
    def __init__(self, text: str):
        self.text = text
        self.lines = text.split('\n')
        self.starts = [0]
        for line in self.lines[:-1]:
            self.starts.append(self.starts[-1] + len(line) + 1)

    def span(self, start: int, end: int) -> Span:
        if not 1 <= start <= end <= len(self.lines):
            raise BrokerError('invalid_evidence_range')
        return self.starts[start - 1], self.starts[end - 1] + len(self.lines[end - 1])

    def position(self, offset: int) -> dict[str, int]:
        line = bisect.bisect_right(self.starts, offset) - 1
        return {'line': line + 1, 'column': offset - self.starts[line]}

    def location(self, span: Span) -> dict[str, Any]:
        return {'start': self.position(span[0]), 'end': self.position(span[1])}


@dataclass
class Observation:
    text: str
    metadata: dict[str, Any]
    deadline: float
    timer: asyncio.TimerHandle


class Observations:
    def __init__(self, ttl: float = 600, capacity: int = 16, max_bytes: int = 1048576):
        self.ttl, self.capacity, self.max_bytes = ttl, capacity, max_bytes
        self.records: dict[str, Observation] = {}
        self.bytes = 0
        self.key = secrets.token_bytes(32)
        self.closed = False

    def discard(self, observation_id: str) -> None:
        record = self.records.pop(observation_id, None)
        if record:
            record.timer.cancel()
            self.bytes -= len(record.text.encode())

    def close(self) -> None:
        self.closed = True
        for observation_id in list(self.records):
            self.discard(observation_id)

    def put(self, observation_id: str, text: str, metadata: dict[str, Any], captured: float) -> str:
        self.discard(observation_id)
        for key, record in list(self.records.items()):
            if record.deadline <= monotonic():
                self.discard(key)
        size = len(text.encode())
        expiry = (datetime.fromisoformat(metadata['captured_at']) + timedelta(seconds=self.ttl)).isoformat()
        remaining = captured + self.ttl - monotonic()
        if self.closed or size > self.max_bytes or self.capacity < 1 or remaining <= 0:
            return expiry
        timer = asyncio.get_running_loop().call_later(remaining, self.discard, observation_id)
        self.records[observation_id] = Observation(text, dict(metadata, expires_at=expiry), captured + self.ttl, timer)
        self.bytes += size
        while len(self.records) > self.capacity or self.bytes > self.max_bytes:
            oldest = min(self.records, key=lambda key: self.records[key].deadline)
            self.discard(oldest)
        return expiry

    def _encode(self, payload: dict[str, Any]) -> str:
        body = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
        signature = hmac.digest(self.key, body, 'sha256')
        return base64.urlsafe_b64encode(signature + body).decode()

    def _decode(self, token: str, observation_id: str) -> dict[str, Any]:
        try:
            if len(token) > 2048:
                raise ValueError
            data = base64.b64decode(token, altchars=b'-_', validate=True)
            signature, body = data[:32], data[32:]
            if not hmac.compare_digest(signature, hmac.digest(self.key, body, 'sha256')):
                raise ValueError
            value: dict[str, Any] = json.loads(body)
            if value['observation_id'] != observation_id:
                raise ValueError
            return value
        except (ValueError, KeyError, TypeError):
            raise BrokerError('invalid_excerpt_cursor') from None

    def excerpt(self, observation_id: str, start_line: int | None = None, end_line: int | None = None,
                query: str | None = None, cursor: str | None = None) -> dict[str, Any]:
        record = self.records.get(observation_id)
        if record is None or record.deadline <= monotonic():
            self.discard(observation_id)
            raise BrokerError('snapshot_unavailable')
        selectors = int(start_line is not None or end_line is not None) + int(query is not None) + int(cursor is not None)
        if selectors != 1:
            raise BrokerError('invalid_excerpt_selector')
        if cursor is not None:
            condition = self._decode(cursor, observation_id)
            start_line, end_line, query = condition['start_line'], condition['end_line'], condition['query']
            index, offset = condition['index'], condition['offset']
        else:
            index, offset = 0, None
        screen = Screen(record.text)
        spans: list[Span]
        if query is not None:
            if not 1 <= len(query) <= 256:
                raise BrokerError('invalid_excerpt_query')
            spans = []
            position = record.text.find(query)
            while position >= 0:
                first = screen.position(position)['line']
                last = screen.position(position + len(query) - 1)['line']
                spans.append(screen.span(max(1, first - 5), min(len(screen.lines), last + 5)))
                position = record.text.find(query, position + 1)
            spans = merge(spans)
        else:
            if start_line is None or end_line is None:
                raise BrokerError('invalid_excerpt_selector')
            spans = [screen.span(start_line, end_line)]
        # Search pages start around a late match in a long line. The skipped prefix is
        # returned afterwards using the same deterministic order, without server state.
        ordered: list[Span] = []
        for begin, end in spans:
            hit = record.text.find(query, begin, end) if query is not None else -1
            if hit >= 0 and hit - begin + len(query or '') > 4000:
                pivot = max(begin, hit - (4000 - len(query or '')) // 2)
                ordered.extend([(pivot, end), (begin, pivot)])
            else:
                ordered.append((begin, end))
        spans = ordered
        if not 0 <= index <= len(spans):
            raise BrokerError('invalid_excerpt_cursor')
        remaining, chunks = 4000, []
        while index < len(spans) and remaining:
            begin, end = spans[index]
            pos = begin if offset is None else offset
            if not begin <= pos <= end:
                raise BrokerError('invalid_excerpt_cursor')
            stop = min(end, pos + remaining)
            if stop > pos:
                chunks.append({'text': record.text[pos:stop], 'range': screen.location((pos, stop)),
                               'original_range': screen.location((begin, end)), 'partial': pos != begin or stop != end})
            remaining -= stop - pos
            if stop < end:
                offset = stop
                break
            index += 1
            offset = None
        token = None
        if index < len(spans):
            token = self._encode(dict(observation_id=observation_id, start_line=start_line, end_line=end_line,
                                      query=query, index=index, offset=offset))
        # Report unreturned ranges without storing any per-query results.
        unreturned = [screen.location((offset if i == index and offset is not None else a, b))
                      for i, (a, b) in enumerate(spans) if i >= index]
        return {**record.metadata, 'observation_id': observation_id, 'historical': True,
                'checked_at': datetime.now(UTC).isoformat(), 'excerpts': chunks,
                'matched': bool(spans), 'next_cursor': token, 'unreturned_ranges': unreturned}
