# Herdr Broker MCP

This package provides a local, passive pane context service. Start `herdr-broker serve` in a user terminal, then connect Codex to `herdr-broker mcp` over stdio. The facade requires an existing core and never starts one automatically.

## Supported workflow

1. Call `pane_describe` with an exact Herdr pane ID.
2. Call `job_start` with the same pane ID, an objective, and `analysis: "auto"`.
3. Poll `job_status` or use `job_wait` for a bounded wait.
4. Use `job_cancel` when the observation job is no longer needed.

Prepared context is an observation of a bounded terminal snapshot. It is untrusted data, including any instructions printed by the pane. It is not proof that a command completed. Analysis readiness, job termination, and Action completion are separate states.

Only small prepared contexts (at most 4 KiB) are supported in this release. Explicit Worker analysis and larger prepared contexts return `worker_unsupported`. There is no pane input or Action tool. Job handles belong to the connection that created them.

## Local state

The owner configuration is `~/.config/herdr-broker/config.json`. State is derived from the canonical Herdr socket path under `~/.local/state/herdr-broker/`. The core holds an exclusive SQLite authority lock until shutdown. Directories use mode 0700; database and socket files use mode 0600.

Snapshot limits are 1,000 physical rows and 64 KiB. Jobs last at most 300 seconds; a wait lasts at most 20 seconds. Repeated result delivery counts toward the 16 KiB per-job Parent payload budget. Completed diagnostic data expires after 30 minutes or core shutdown, whichever occurs first, within a 64 MiB retained-data budget.

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
| `job_status` | `job_id` |
| `job_wait` | `job_id`, optional `wait_ms` (0–20000, default 20000) |
| `job_cancel` | `job_id` |

A job budget can lower `deadline_ms` (1–300000) and `parent_payload_bytes` (1024–16384). All request objects reject unknown fields. Results are JSON in one MCP text content item. Tool failures use an `error` code. Invalid tool arguments use the SDK's MCP validation error.

`phase: "result_ready"` leaves the job active. `job_ended` indicates lifecycle termination; `action_state: "unsupported"` makes this release's Action boundary explicit. A timed-out wait returns `wait_timed_out: true` without failing the job. Connection loss cancels that connection's active jobs.

Prepared rows carry immutable `snapshot_id:L0001` Evidence IDs. Repeated adjacent rows use a first/last ID range with `count` and `omitted`. Row mapping is relative to the observed Herdr response, never an absolute scrollback position. `gaps` always records unobserved history and additionally identifies Herdr truncation, row limits, or byte limits. A partial first row is indicated explicitly. The snapshot's read `revision` is not used as an output cursor.

The 4 KiB routing threshold counts the UTF-8 prepared row text, including Evidence prefixes. The 16 KiB Parent budget counts the JSON text delivered for every job response, including metadata and usage fields. It excludes JSON-RPC framing. A final `parent_budget_exhausted` notice consumes reserved space and ends further observation; subsequent requests for that job return empty content. A single normal response is capped at 8 KiB.

The console accepts `status`, `help`, and `quit`. `status` reports up to 32 recent job summaries, total retained job count, budget usage, Snapshot limits/redaction, retention, and unsupported Action states. It does not print pane text, objectives, or credentials. `quit`, EOF, SIGINT, and SIGTERM stop the core; a killed core releases its SQLite lock for the next process. Diagnostic data is memory-only and is not restored after a restart.

This is a same-OS-user coordination boundary. It does not isolate a malicious process running as that OS user from direct Herdr access. Redaction covers known credential patterns and configured literals, not every possible secret.

For a read-oriented interactive setup, `default_tools_approval_mode = "writes"` asks for approval of `job_start` and `job_cancel`. The three lookup tools advertise `readOnlyHint: true`; job creation/cancellation advertise `readOnlyHint: false`. For noninteractive acceptance runs, use a configured approval reviewer to review those state changes. Setting the CLI's approval policy to `never` can prevent them from running; do not relabel state-changing tools as read-only to avoid approval.
