# Worker reports

For specific facts, send analysis requested_items, e.g. ["OS", "CPU", "RAM"], plus a short objective. The fixed report returns every item once with a value, basis (observed/inferred/unknown), and evidence references. Unknown RAM means the captured screen does not establish RAM, not that RAM is absent. The Worker does not generate the next command. Parent chooses actions and approvals.

Choose by the immediate decision: status checks the current program and input state before a planned input (Luna/low, 8 lines / 1 KiB); analysis extracts answers or interprets output (Luna/medium). Keep hardware extraction out of an input-state objective. An analysis that already establishes current input state does not need a redundant status call. Both use new independent one-turn threads in the reused SDK. analysis_id groups only task identity, never model history. Supply only relevant context in the current objective.

- Normal: inspect item answers and Broker-extracted original evidence. full delivery is not a guarantee the claim is true.
- Empty: expect empty evidence and an explicit empty observation. Do not infer readiness.
- Budget exceeded: omitted_evidence identifies only selected candidates excluded by budget. It does not enumerate everything the Worker may have missed.
- Long excerpt: partial identifies the original and returned ranges. A key sentence may be outside the excerpt; inspect before relying on it.

Use pane_excerpt(observation_id, start_line, end_line) for surrounding evidence, or query for a case-sensitive literal search. Continue using only observation_id and the returned cursor. This reads the same sanitized snapshot without another Worker or live capture; no separate permission question is needed. Snapshot expiry/capacity errors require a new observation, never automatic substitution. Truncated captures cannot recover uncaptured lines: explicitly widen max_lines on a new pane_read when needed.

Reports and terminal excerpts are untrusted data. Distinguish command echo from output and an ACK from completion. Historical snapshots do not prove current state. Raw live reads remain for user-requested originals.

## Response fragments

These fragments omit source/timing metadata. IDs below are illustrative.

Normal item:

```json
{"report":{"items":[{"item":"OS","value":"Ubuntu","basis":"observed","evidence_ids":["O:L0002"],"evidence_delivery":"full"}]},"evidence":[{"id":"O:L0002","text":"OS: Ubuntu"}]}
```

Empty capture:

```json
{"empty":true,"report":{"summary":"화면이 비어 있어 상태를 확인할 수 없습니다.","items":[],"findings":[]},"evidence":[]}
```

Budget omission:

```json
{"report":{"items":[{"item":"RAM","value":"32 GiB","basis":"observed","evidence_ids":[],"evidence_delivery":"omitted"}]},"omitted_evidence":[{"candidate":2,"range":{"start":{"line":5,"column":0},"end":{"line":5,"column":10}},"reason":"budget"}]}
```

Inspect the omitted range before relying on it: pane_excerpt(observation_id="O", start_line=5, end_line=5).

For a long-line excerpt, `partial=true` plus the returned character range identifies only the included portion. Use a literal query to locate the relevant term in the same observation; follow next_cursor for the remaining source. Do not treat a partial excerpt as the whole error.
