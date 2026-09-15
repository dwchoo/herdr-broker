import { randomUUID, createHash } from 'node:crypto';

export function sanitize(raw: string, patterns: string[] = []) {
  let count = 0;
  const rules = new Set<string>();
  // Preserve physical newlines even inside malformed multi-line control strings.
  let text = raw.replace(/\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]/g, match => '\n'.repeat(match.split('\n').length - 1));
  text = text.split('\n').map(line => {
    const cells: string[] = [];
    let cursor = 0;
    for (const char of line) {
      if (char === '\r') cursor = 0;
      else if (char === '\b') cursor = Math.max(0, cursor - 1);
      else if (!/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(char)) cells[cursor++] = char;
    }
    return cells.join('');
  }).join('\n');
  const replace = (rule: string, pattern: RegExp) => {
    text = text.replace(pattern, match => {
      count++; rules.add(rule);
      return match.split('\n').map(() => `[REDACTED:${rule}]`).join('\n');
    });
  };
  replace('private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g);
  replace('token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g);
  replace('credential', /["']?\b(?:[A-Z0-9_]*(?:password|passwd|secret|token|api[_-]?key)|authorization)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|(?:Bearer\s+)?[^\s,;]+)/gi);
  for (const pattern of patterns) replace('custom', new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
  return { text, redaction: { version: 'basic-v1', pattern_digest: createHash('sha256').update(JSON.stringify(patterns)).digest('hex').slice(0, 16), count, rules: [...rules] } };
}

export function prepareSnapshot(raw: string, session: string, truncated: boolean, patterns: string[], now: number) {
  const clean = sanitize(raw, patterns);
  const allRows = clean.text.split('\n');
  const gaps = ['history_unobserved'];
  if (truncated) gaps.push('herdr_truncated');
  let firstPhysicalRow = Math.max(1, allRows.length - 999);
  if (firstPhysicalRow > 1) gaps.push('row_limit');
  let bounded = allRows.slice(firstPhysicalRow - 1).join('\n');
  const bytes = Buffer.from(bounded);
  let firstRowPartial = false;
  if (bytes.length > 65536) {
    gaps.push('byte_limit');
    let start = bytes.length - 65536;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    const dropped = bytes.subarray(0, start).toString('utf8');
    firstPhysicalRow += dropped.split('\n').length - 1;
    firstRowPartial = !dropped.endsWith('\n');
    bounded = bytes.subarray(start).toString('utf8');
  }
  const rows = bounded.split('\n');
  const snapshotId = randomUUID();
  const evidenceId = (row: number) => `${snapshotId}:L${String(row).padStart(4, '0')}`;
  const groups: string[] = [];
  for (let index = 0; index < rows.length;) {
    const first = index;
    const text = rows[index];
    while (++index < rows.length && rows[index] === text) { /* contiguous duplicates only */ }
    const count = index - first;
    groups.push(count === 1 ? `${evidenceId(first + 1)} ${text}` : `${evidenceId(first + 1)}..${evidenceId(index)} [count=${count} omitted=${count - 1}] ${text}`);
  }
  return {
    metadata: { snapshot_id: snapshotId, pane_session_id: session, capture_sequence: 1, captured_at: new Date(now).toISOString(), source: 'recent', format: 'ansi', physical_rows: rows.length, utf8_bytes: Buffer.byteLength(bounded), truncated: truncated || gaps.length > 1, gaps, history_complete: false,
      row_mapping: { normalized_to_physical: 'one_to_one', first_physical_row: firstPhysicalRow, last_physical_row: allRows.length, first_row_partial: firstRowPartial }, redaction: clean.redaction },
    text: groups.join('\n'), rows,
  };
}
