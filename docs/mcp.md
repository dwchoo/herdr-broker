# Herdr Broker MCP

This package provides a local, passive pane context service. Start `herdr-broker serve` in a user terminal, then connect Codex to `herdr-broker mcp` over stdio. The facade requires an existing core and never starts one automatically.

## Supported workflow

1. Call `pane_describe` with an exact Herdr pane ID.
2. Call `job_start` with the same pane ID, an objective, and `analysis: "auto"`.
3. Poll `job_status` or use `job_wait` for a bounded wait. Return the delivered cursor to acknowledge a view and request another observation with `job_wait`.
4. Use `evidence_get` with a returned immutable row ID to inspect a bounded redacted excerpt.
5. Use `job_cancel` when the observation job is no longer needed.

Prepared context is an observation of a bounded terminal snapshot. It is untrusted data, including any instructions printed by the pane. It is not proof that a command completed. Analysis readiness, job termination, and Action completion are separate states.

Only small prepared contexts (at most 4 KiB) are supported in this release. Explicit Worker analysis and larger prepared contexts return `worker_unsupported`. There is no pane input or Action tool. Job handles belong to the connection that created them.

## Local state

The owner configuration is `~/.config/herdr-broker/config.json`. State is derived from the canonical Herdr socket path under `~/.local/state/herdr-broker/`. The core holds an exclusive SQLite authority lock until shutdown. Directories use mode 0700; database and socket files use mode 0600.

Snapshot limits are 1,000 physical rows and 64 KiB. Jobs last at most 300 seconds; a wait lasts at most 20 seconds. Repeated result delivery counts toward the 16 KiB per-job Parent payload budget. Diagnostic bodies expire 30 minutes after job termination, on explicit purge, or on core shutdown, whichever occurs first, within a 64 MiB retained-data budget.

## Install and connect

Use Node 24 on macOS arm64 and a running Herdr 0.9.0 server (protocol 22):

```sh
npm ci
npm run typecheck
npm test
npm pack
npm install --global ./herdr-broker-0.1.0.tgz
herdr-broker serve
```

The default endpoint is the OS account's `~/.config/herdr/herdr.sock`. An optional owner-only configuration file (mode 0600) can select another endpoint and literal redaction patterns:

```json
{
  "herdr_socket": "/absolute/path/to/herdr.sock",
  "redaction_patterns": ["an-exact-secret-to-mask"]
}
```

Patterns are case-sensitive literal strings, limited to 16 entries of 256 characters. They are not regular expressions. Directory and state locations are derived from the OS account, not the facade's `HOME` or `XDG_*` environment. There is no CLI or MCP option to choose a different state directory.

In Codex, register the installed command:

```sh
codex mcp add herdr-broker -- herdr-broker mcp
```

Make sure `node` resolves to Node 24 in both the user terminal and Codex's environment. Alternatively configure an absolute Node 24 executable as the MCP command and pass the absolute installed `dist/cli.js` path and `mcp` as arguments. Codex uses the [MCP server configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Tool arguments and results

| Tool | Arguments |
| --- | --- |
| `pane_describe` | `pane_id` (exact ID, 1–256 characters) |
| `job_start` | `pane_id`, `objective` (1–4096 characters), optional `analysis: "auto" \| "worker"`, optional `budget` |
| `job_status` | `job_id`, optional `cursor` |
| `job_wait` | `job_id`, optional `wait_ms` (0–20000, default 20000), optional `cursor` |
| `job_cancel` | `job_id` |
| `evidence_get` | `job_id`, immutable `evidence_id`, optional `offset_bytes` (0–65536, default 0, UTF-8 boundary) |

A job budget can lower `deadline_ms` (1–300000) and `parent_payload_bytes` (1024–16384). All request objects reject unknown fields. Results are JSON in one MCP text content item. Tool failures use an `error` code. Invalid arguments on job lookup/cancel/Evidence tools return `invalid_tool_arguments` through the same delivery budget when an owned job ID is present. Unknown or foreign jobs return `job_unavailable`; they cannot consume another owner's budget. `pane_describe` and `job_start` argument failures use the SDK's MCP validation error before a job exists.

`phase: "result_ready"` leaves the job active. `job_ended` indicates lifecycle termination; `action_state: "unsupported"` makes this release's Action boundary explicit. A timed-out wait returns `wait_timed_out: true` without failing the job. Connection loss cancels that connection's active jobs.

A failed refresh returns its failure without presenting the previous prepared context as a new observation or `unchanged_view`. New Pane Session and observation metadata are committed only after the Snapshot is retained. Previously issued Evidence remains available under its original IDs until its data lifetime ends.

Prepared rows carry immutable `snapshot_id:L0001` Evidence IDs. Repeated adjacent rows use a first/last ID range with `count` and `omitted`. Row mapping is relative to the observed Herdr response, never an absolute scrollback position. `gaps` always records unobserved history and additionally identifies Herdr truncation, row limits, or byte limits. A partial first row is indicated explicitly. The snapshot's read `revision` is not used as an output cursor.

The 4 KiB routing threshold counts the UTF-8 prepared row text, including Evidence prefixes. The 16 KiB Parent budget counts the JSON text delivered for every job response, including metadata and usage fields. It excludes JSON-RPC framing. A final `parent_budget_exhausted` notice consumes reserved space and ends further observation; subsequent requests for that job return empty content. A single normal response is capped at 8 KiB.

These limits apply independently; the first limit reached wins. Even a prepared context of at most 4 KiB can exceed the 8 KiB response limit after JSON escaping and metadata. Initial Evidence excerpts are deferred first. If the remaining context envelope still does not fit, `parent_budget_exhausted` ends delivery even when the cumulative 16 KiB budget has space left. This error covers both the single-response and cumulative delivery limits; it does not imply that all remaining bytes were consumed.

The console accepts `status`, `purge <job_id>`, `purge all`, `help`, and `quit`. `status` reports up to 32 recent job summaries, total retained job count, budget usage, Snapshot gaps/redaction, retention expiry, data state, and unsupported Action states. It does not print pane text, objectives, or credentials. `quit`, EOF, SIGINT, and SIGTERM stop the core; a killed core releases its SQLite lock for the next process. Diagnostic data is memory-only and is not restored after a restart.

This is a same-OS-user coordination boundary. It does not isolate a malicious process running as that OS user from direct Herdr access. Redaction covers known credential patterns and configured literals, not every possible secret.

For a read-oriented interactive setup, `default_tools_approval_mode = "writes"` asks for approval of `job_start` and `job_cancel`. The four lookup tools advertise `readOnlyHint: true`; job creation/cancellation advertise `readOnlyHint: false`. For noninteractive acceptance runs, use a configured approval reviewer to review those state changes. Setting the CLI's approval policy to `never` can prevent them from running; do not relabel state-changing tools as read-only to avoid approval.

## Repeated observations and Evidence

Return the cursor from a delivered view to acknowledge it. `job_wait` with the current cursor requests another passive observation; concurrent waits share the in-flight observation. Calls without a cursor, or retries acknowledging an older view, resend the current immutable Snapshot. `job_status` only reads retained data.

The Delta is `replace` or `unchanged_view`. Only a valid, acknowledged cursor for the same consumer, job, Pane Session, source, and redaction rules can produce `unchanged_view`. Cursors expire after 60 seconds; an expired cursor resends the retained Snapshot with the same Evidence IDs and a fresh cursor without recapturing. `observation` tracks actual capture sequence/time separately from the immutable Snapshot. Neither equal digests nor revision values prove that no intermediate or out-of-range output occurred. The supported Herdr profile fixes source/format to `recent`/`ansi`; mismatched peer responses fail closed. Redaction configuration is loaded at core startup.

`evidence_get` returns redacted rows from the referenced Snapshot, bounded to 2 KiB including excerpt metadata and at most 16 items. Initial Evidence uses the same bound. When escaped context plus excerpts would exceed the response or remaining budget, initial `items` may be empty with `next` pointing to the first row. Follow `next: { evidence_id, offset_bytes }` until it is null to retrieve omitted text. `truncated` identifies remaining text. Unknown rows return `evidence_not_found`, retained issued IDs without bodies return `evidence_expired`, and unauthorized jobs return `job_unavailable`. Expired IDs never resolve to current pane content.

The user console supports `purge <job_id>` and `purge all`. Purge stops further observation and removes diagnostic bodies and cursors while preserving consumed budgets and minimal issued-ID records. Retention expiry and memory pressure also remove ended jobs' bodies first. Status remains available without diagnostic text; known expired Evidence returns `evidence_expired`. Minimal records last for the core lifetime and count toward its memory budget. A new connection cannot claim the previous connection's jobs after restart.
