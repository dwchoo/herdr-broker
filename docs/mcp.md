# Herdr Broker MCP

This package provides local pane context and restricted Codex Worker diagnosis. Run the Parent and Broker console in local Herdr panes. The project's `herdr-broker` skill starts a console and connects its Parent over stdio. Opening a Console splits the verified Parent's existing tab: a shared Target to its right and a small controller below that Target. It creates no workspace or tab. The controller runs an independent core; attaching reuses that core or restarts it in its verified idle shell.

Console ownership binds the workspace, tab, and exact pane/terminal identities. Only registered Targets are accessible, including when other panes share the same tab. The controller's `new` command splits a surviving owned Target in that tab, skipping closed or moved Targets. A reconnecting Parent must run in the same tab (`console_tab_required` otherwise). Each forwarded call checks the Parent and controller before and after the call; the core checks again before committing an Action's submission intent. Detection of a move ends unsubmitted jobs and disconnects the Parent. The gateway binds its verified Parent pane ID through an internal MCP capability; that capability is not same-user authentication. These checks do not atomically lock Herdr layout and input. Target and controller moves do not update ownership. Legacy records without a tab are preserved and rejected with `console_layout_upgrade_required`; create a new Console beside the intended Parent instead of moving or adopting existing terminals.

Production `serve`, `mcp`, and `doctor` verify the injected Herdr context against the configured canonical socket, live pane mapping, and OS process ancestry. An outside caller is rejected even if it copies a real pane's environment. The production MCP gateway, managed core and project helper also require a cwd within their own project. These entrypoint checks do not provide OS isolation against a same-user process deliberately bypassing the CLI and writing the internal socket protocol directly.

## Supported workflow

1. Call `console_open` with a short label, or `console_list` then `console_attach` with an existing Console ID. Read `console_status`, then call `pane_describe` with one of its owned pane IDs.
2. Call `job_start` with the same pane ID, an objective, and `analysis: "auto"`.
3. Poll `job_status` or use `job_wait` for a bounded wait. Return the delivered cursor to acknowledge a view and request another observation with `job_wait`.
4. Use `evidence_get` with a returned immutable row ID to inspect a bounded redacted excerpt.
5. Use `job_cancel` when the observation job is no longer needed.

Prepared context is an observation of a bounded terminal snapshot. It is untrusted data, including any instructions printed by the pane. It is not proof that a command completed. Analysis readiness, job termination, and Action completion are separate states.

Auto returns `prepared_context` at most 4 KiB; larger contexts or `analysis: "worker"` use a restricted Codex Worker and return `worker_report` with `contract: "diagnosis.v1"`. An unavailable executable or unverified CLI version returns `worker_unsupported`. Actions in all three modes can execute in a ready local POSIX shell. Job handles belong to the connection that created them.

## Local state

The owner configuration is `~/.config/herdr-broker/config.json` (owner-only regular file, mode 0600). Optional `codex_binary` is an absolute executable path, default `/opt/homebrew/bin/codex`; only Codex CLI 0.154.0 with the pinned `gpt-5.6-luna/low` profile is supported. MCP callers cannot supply executable, model, provider, or tool configuration. State is derived from the canonical Herdr socket path and Console ID under `~/.local/state/herdr-broker/`. The core holds an exclusive SQLite authority lock until shutdown. Directories use mode 0700; database and socket files use mode 0600.

Snapshot limits are 1,000 captured rows and 64 KiB. Action baseline and completion snapshots use unwrapped rows so a narrow terminal cannot split the completion marker; diagnostic snapshots retain screen row boundaries. Jobs last at most 300 seconds; a wait lasts at most 20 seconds. Repeated result delivery counts toward the 16 KiB per-job Parent payload budget. Diagnostic bodies expire 30 minutes after job termination, on explicit purge, or on core shutdown, whichever occurs first, within a 64 MiB retained-data budget.

## Install and connect

Use Node 24 on macOS arm64 and a running Herdr 0.9.0 server (protocol 22). From this repository checkout, in a local Herdr console pane:

```sh
npm ci
npm run build
node .agents/skills/herdr-broker/scripts/run.mjs setup
```

The default endpoint is the OS account's `~/.config/herdr/herdr.sock`. An optional owner-only configuration file (mode 0600) can select another endpoint and literal redaction patterns:

```json
{
  "herdr_socket": "/absolute/path/to/herdr.sock",
  "redaction_patterns": ["an-exact-secret-to-mask"]
}
```

Patterns are case-sensitive literal strings, limited to 16 entries of 256 characters. They are not regular expressions. Directory and state locations are derived from the OS account, not the facade's `HOME` or `XDG_*` environment. There is no CLI or MCP option to choose a different state directory.

In the Parent shell pane, start Codex with this project's MCP connection:

```sh
node .agents/skills/herdr-broker/scripts/run.mjs parent
```

Setup writes only this checkout's MCP configuration; a new Codex launched in this project inherits it. The Parent helper provides the same settings for one invocation and uses `on-request` approval policy with the existing reviewer. Codex tool approval and Broker Action Mode both apply. Both paths forward Herdr-injected context for process ancestry validation. See [operations](operations.md) for persistence and restart behavior.

## Tool arguments and results

| Tool | Arguments |
| --- | --- |
| `console_open` | `label` (1–80 characters); create and attach a new Console |
| `console_list` | optional returned `cursor`; list this project’s Console IDs and workspace/tab IDs in pages of at most 20 records / 8 KiB |
| `console_attach` | `console_id` (UUID); attach one existing Console |
| `console_status` | no arguments; owned panes, up to 8 recent durable receipts, and holds |
| `pane_describe` | `pane_id` (exact ID, 1–256 characters) |
| `job_start` | `pane_id`, `objective` (1–4096 characters), optional `analysis: "auto" \| "worker"`, optional `budget` |
| `job_status` | `job_id`, optional `cursor` |
| `job_wait` | `job_id`, optional `wait_ms` (0–20000, default 20000), optional `cursor` |
| `job_cancel` | `job_id` |
| `evidence_get` | `job_id`, immutable `evidence_id`, optional `offset_bytes` (0–65536, default 0, UTF-8 boundary) |
| `action_propose` | `job_id`, exact `target`, `objective`, `operation`, `command`, `cwd`, `env`, `affected_paths`, optional `risk` |
| `action_submit` | immutable `proposal_id` only |
| `action_status` | `job_id`, `proposal_id` |
| `session_lower_mode` | `job_id`, `mode` (0–3, reduction only) |

A job budget can lower `deadline_ms` (1–300000) and `parent_payload_bytes` (1024–16384). All request objects reject unknown fields. Results are JSON in one MCP text content item. Tool failures use an `error` code. Invalid arguments on job lookup/cancel/Evidence tools return `invalid_tool_arguments` through the same delivery budget when an owned job ID is present. Unknown or foreign jobs return `job_unavailable`; they cannot consume another owner's budget. `pane_describe` and `job_start` argument failures use the SDK's MCP validation error before a job exists.

Console lists return `next` and `truncated`. Pass a non-null `next` as `cursor` to retrieve the following page. Lists describe saved registrations; attaching always checks the current native workspace. Use `herdr-broker doctor <console_id>` to check that Console's actual state directory.

`phase: "result_ready"` leaves the job active. `job_ended` indicates lifecycle termination; `action_state` reports `available`, `scope_required`, or a stopped budget condition. Action outcomes use a separate receipt. A timed-out wait returns `wait_timed_out: true` without failing the job. Connection loss cancels that connection's active jobs, while submitted actions retain their independent bounded observation window.

A failed refresh returns its failure without presenting the previous prepared context as a new observation or `unchanged_view`. New Pane Session and observation metadata are committed only after the Snapshot is retained. Previously issued Evidence remains available under its original IDs until its data lifetime ends.

Prepared rows carry immutable `snapshot_id:L0001` Evidence IDs. Repeated adjacent rows use a first/last ID range with `count` and `omitted`. Row mapping is relative to the observed Herdr response, never an absolute scrollback position. `gaps` always records unobserved history and additionally identifies Herdr truncation, row limits, or byte limits. A partial first row is indicated explicitly. The snapshot's read `revision` is not used as an output cursor.

The 4 KiB routing threshold counts the UTF-8 prepared row text, including Evidence prefixes. The 16 KiB Parent budget counts the JSON text delivered for every job response, including metadata and usage fields, plus the JSON bytes of each actual Action payload. It excludes JSON-RPC framing. A final `parent_budget_exhausted` notice consumes reserved space and ends further observation; subsequent requests for that job return empty content. A single normal response is capped at 8 KiB.

These limits apply independently; the first limit reached wins. Even a prepared context of at most 4 KiB can exceed the 8 KiB response limit after JSON escaping and metadata. Initial Evidence excerpts are deferred first. If the remaining context envelope still does not fit, `parent_budget_exhausted` ends delivery even when the cumulative 16 KiB budget has space left. This error covers both the single-response and cumulative delivery limits; it does not imply that all remaining bytes were consumed.

The console accepts `panes`, `new` (interactive creation of an owned terminal), `status`, `purge <job_id>`, `purge all`, `help`, and `quit`, plus the interactive review commands below. `status` reports up to 32 recent job summaries, total retained job count, budget usage, Snapshot gaps/redaction, retention expiry, data state, Action receipts and unresolved terminal holds. It does not print pane text, objectives, or credentials. `quit`, EOF, SIGINT, and SIGTERM stop the core; a killed core releases its SQLite lock for the next process. Diagnostic data is memory-only and is not restored after a restart. Parent exit leaves the core and native terminals running. New Parent connections start fresh jobs and inspect durable receipts with `console_status`. A connection stays bound to its first Console; concurrent attachment is refused. Registered pane and terminal IDs must still belong to the recorded workspace and tab. Replaced or moved targets and all outside panes are rejected. Only newly created terminals can be registered.

This is a same-OS-user coordination boundary. It does not isolate a malicious process running as that OS user from direct Herdr access. Redaction covers known credential patterns and configured literals, not every possible secret.

For a read-oriented interactive setup, `default_tools_approval_mode = "writes"` asks for approval of `job_start` and `job_cancel`. The five lookup tools advertise `readOnlyHint: true`; job creation/cancellation, proposals and mode changes advertise `readOnlyHint: false`. For noninteractive acceptance runs, use a configured approval reviewer to review those state changes. Setting the CLI's approval policy to `never` can prevent them from running; do not relabel state-changing tools as read-only to avoid approval.

## Repeated observations and Evidence

Return the cursor from a delivered view to acknowledge it. `job_wait` with the current cursor requests another passive observation; concurrent waits share the in-flight observation. Calls without a cursor, or retries acknowledging an older view, resend the current immutable Snapshot. `job_status` only reads retained data.

The Delta is `replace` or `unchanged_view`. Only a valid, acknowledged cursor for the same consumer, job, Pane Session, source, and redaction rules can produce `unchanged_view`. Cursors expire after 60 seconds; an expired cursor resends the retained Snapshot with the same Evidence IDs and a fresh cursor without recapturing. `observation` tracks actual capture sequence/time separately from the immutable Snapshot. Neither equal digests nor revision values prove that no intermediate or out-of-range output occurred. The supported Herdr profile fixes diagnostic source/format to `recent`/`ansi`. Action baseline and completion observation use `recent_unwrapped`/`ansi`, preserving complete nonce/exit rows in narrow split panes. Mismatched peer responses fail closed. Redaction configuration is loaded at core startup.

`evidence_get` returns redacted rows from the referenced Snapshot, bounded to 2 KiB including excerpt metadata and at most 16 items. Initial Evidence uses the same bound. When escaped context plus excerpts would exceed the response or remaining budget, initial `items` may be empty with `next` pointing to the first row. Follow `next: { evidence_id, offset_bytes }` until it is null to retrieve omitted text. `truncated` identifies remaining text. Unknown rows return `evidence_not_found`, retained issued IDs without bodies return `evidence_expired`, and unauthorized jobs return `job_unavailable`. Expired IDs never resolve to current pane content.

The user console supports `purge <job_id>` and `purge all`. Purge stops further observation and removes diagnostic bodies and cursors while preserving consumed budgets and minimal issued-ID records. Retention expiry and memory pressure also remove ended jobs' bodies first. Status remains available without diagnostic text; known expired Evidence returns `evidence_expired`. Minimal records last for the core lifetime and count toward its memory budget. A new connection cannot claim the previous connection's jobs after restart.

## Restricted Worker

The Worker receives the entire bounded redacted Snapshot, objective, and immutable row IDs via stdin. Its final report has exactly `summary`, `findings`, `next_checks`, and `uncertainties`. Broker validates schema, 4096 UTF-8 bytes, and each cited row's Snapshot membership, then resolves Evidence from retained rows. Initial Evidence selects the cited rows; `evidence_get` can retrieve their full text. Citations validate the source connection, not diagnosis accuracy.

One structurally invalid result can be repaired once on the same Snapshot. Both attempts count toward four calls per job; output overflow, timeout, cancellation, and profile violations do not trigger repair. One Worker runs at a time, for at most 60 seconds, bounded to 256 KiB stdout and 64 KiB per JSONL event. Observed input plus output usage reaching 100,000 tokens blocks the next call; cached input is not added twice. This is an observed-use limit, not an exact billing cap. Missing usage and unobserved model identity remain `null`.

The fixed profile disables shell, MCP, plugins, apps, host skills, and further agents, uses read-only sandbox and approval never, and ignores user configuration. CLI authentication uses the existing OS account without reading or copying credentials. Only an allowlisted environment reaches the process. Job termination kills the owned process group; this does not prove provider computation or storage has stopped. Broker reports follow the existing memory lifetime. Codex ephemeral database/WAL behavior does not establish complete no-store behavior.

## Action proposals and console review

An optional `action_scope` on `job_start` enables proposal preparation: `{ "profile": "local_posix", "cwd": "/absolute/project", "paths": ["/absolute/project"], "trusted": true }`. It declares the cooperative shell, working directory, affected path boundaries, and whether its output is trusted for later automatic chaining. Every observed Pane Session starts in mode 2; subsequent jobs in that session share its mode while retaining separate objectives and budgets.

`action_propose` requires `job_id`, exact `target` (pane/terminal/workspace/tab IDs), the same `objective`, `operation: "execute"`, `command`, explicit `cwd` and `env`, `affected_paths`, and optional `risk`. Broker fixes the whole shell wrapper, nonce and Enter and returns a digest. `action_status` accepts only job/proposal IDs. There is no payload editing or caller-supplied approval authority.

A risk review contains `classification` (`read`, `bounded_change`, `high`, `unknown`), `inspected` boolean, nonempty `impact` and `recovery`, `uncertainties` strings, and high-risk `categories` (destructive, privilege, system_package, driver, kernel, disk, network, account, permissions, reboot, shutdown). In mode 2, only inspected read/bounded changes without uncertainty or high-risk categories qualify for automatic permission. Missing or invalid review needs approval. This structure validates the Parent's declared assessment, not arbitrary shell-script semantics.

`session_lower_mode` accepts a job ID and mode 0/1/2/3, and permits only reductions; 0 stops input eligibility. The interactive console alone can select a higher mode. Changing mode increments its revision and invalidates existing proposals/approvals, so the Parent must create a fresh proposal.

In the terminal that runs `serve`, use `review <proposal_id>` to see exact target, objective, escaped full payload, risk and revision, then `approve <proposal_id>` or `reject <proposal_id>`. `revoke <proposal_id>` withdraws permission. `mode <session_id> <1|2|3>` selects the session policy. Approval lasts at most five minutes, bounded earlier by the job deadline, cancellation, purge, session/mode changes or revocation. Pipe input, `--yes`, RPC assertions and approval tokens cannot grant this authority. Control and direction-changing characters are escaped in console output.

Mode 1 submission requires a current exact approval. Mode 2 automatically submits inspected read/bounded changes with a valid Parent risk review; high, unknown, uninspected or malformed assessments require user approval. Mode 3 permits scoped high or unknown risk without individual approval. Receipts distinguish `user_approval`, `parent_risk_review`, and `autonomous`; only user approval is consumed as an Approval. All modes use the same immutable durable submission path and retain target, scope, revision, cancellation, deadline, budget and hold checks. Scope declarations and process metadata do not authenticate a remote host or isolate another process running as the same OS user. SSH execution remains unsupported.

A completion marker from an untrusted scope leaves an `untrusted_completion` terminal hold. Changing mode, starting another job or declaring the next scope trusted does not clear it. Explicit console recovery must confirm the current shell and establish a new objective before further input; automatic chaining based on untrusted markers is unsupported. Diagnosis reports and confidence never substitute for Action authorization. Reobservation and further analysis after execution remain in the original job's cumulative budget.

## Submission and independent observation

`action_submit` uses the stored wrapper and Enter exactly once. It rechecks the job, approval, session, mode revision and ready shell, then commits intent, approval consumption and a terminal hold in a SQLite WAL/FULL transaction before sending. A failed transaction sends no input. Three ordinary attempts are allowed per job, including verified pre-enqueue rejection. Repeating the same proposal returns its receipt without another attempt; response bytes still consume the Parent budget. A held terminal rejects a new ordinary proposal even from another job or connection.

The wrapper runs an explicit cwd and clean environment inside `/bin/sh -c`; cwd and environment changes do not persist in the interactive parent shell. Values use literal POSIX quoting. Direct terminal control bytes in command/cwd/env are rejected; LF is preserved inside quoting. This declaration boundary does not verify arbitrary script semantics or lock out external Herdr clients.

`submission_state` is `accepted` only after a matching Herdr queue ACK, `rejected` for the pinned version's verified pre-enqueue errors, and `unknown` for lost or ambiguous replies. This state says nothing about execution success. `observation_state` starts as `observing`; one complete current nonce/exit row after the passive baseline permits `completion_observed`. Otherwise it becomes `outcome_unknown` after observation failure or the separate 60-second deadline. Exit is null until observed. Echo, stale markers, duplicate markers and ordinary prompts are insufficient. Markers are untrusted output, not unforgeable execution proof.

Receipts support both `accepted` with an unknown outcome and `unknown` with observed completion. They carry the authorization basis, binding, timestamps, observation method, truncation and bounded Evidence when retained. Job cancellation never sends Ctrl-C and does not erase the submitted action's facts. Unknown outcomes preserve the terminal hold. Restart recovers unfinished intents as unknown/held and never replays payloads. Diagnostic purge removes bodies and evidence but preserves consumed IDs and control state. Ledger loss, identity mismatch, corruption or lost authority fails closed.

After the initial ACK timeout, a matching positive ACK received within the separate observation window can change submission from `unknown` to `accepted`. It does not supply an exit code or release an unresolved hold. Unverified late errors remain unknown. The socket is closed on core shutdown or the observation deadline; no payload suffix or Enter is resent. Cancelling or disconnecting the job owner does not cancel this already-submitted Action's bounded ACK/observation handling.

The ledger verifies its database header, identity, owner-only permissions, and database/WAL/SHM file identity before input. A fresh ledger is allowed only with a freshly initialized authority. A fsynced dirty/clean marker distinguishes a normal closed database from a crashed process whose WAL must still exist. Missing or damaged state, including an older identity format that cannot establish this continuity, is preserved and rejected; it is not automatically migrated to an empty ledger. This detects the documented fault cases, not every filesystem or power-failure mode.

Console status lists at most 32 receipts and 32 held terminals, with `control_record_count`, `consumed_proposal_count`, `held_terminal_count` and `held_terminals_truncated`. Resolved records can compact after seven days; consumed proposal IDs and unresolved holds do not expire. Console recovery must address the current held target explicitly. Restore trusted state only with the core stopped; arbitrary deletion, PID-only takeover or mode changes are not recovery mechanisms.

## Stop, interrupt and user recovery

`job_cancel` stops further work and unsubmitted input. Submitted Actions retain their receipts and bounded passive observation; cancellation sends no control keys. `job_wait` timing out returns current state and does not stop a process.

An `interrupt` proposal supplies `original_proposal_id` and the current target, objective, cwd, affected paths and risk, omits `command`, and uses an empty `env`. The stored payload is exactly `{ "text": "", "keys": ["Ctrl+c"] }`. The original must be a held ordinary Action in the same observed Pane Session. All three modes apply. Each job gets one interrupt attempt separately from three ordinary attempts. Ended jobs cannot submit; a new active job must explicitly bind the original Action. Unknown continuity after restart prevents an assumed interrupt of the previous process.

Authorized submissions are serialized per terminal; approval waiting does not occupy the queue. An interrupt can pass the original Action's hold after its wire submission settles. Its receipt has `original_proposal_id`, `observation_state: "not_applicable"` and null exit. Its ACK alone does not release the original hold or prove termination.

An original completion marker cannot release a hold while a linked interrupt is `dispatching` or `unknown`. The hold becomes `interrupt_unconfirmed`, and linked interrupt records remain alongside the held original across compaction and restart. A later ACK only supplements submission facts; explicit fresh-shell user recovery resolves this retained uncertainty.

In the interactive console, `inspect <pane_id>` passively shows the exact target, current session, shell readiness and held proposal ID. After checking the actual shell, use `recover <original_proposal_id> <new objective>`. Broker checks the inspected mapping/session/revision and fresh ready shell again, records `user_verified_ready_shell`, and preserves the original submission/outcome and null exit. Recovery cancels old jobs and invalidates old proposals. Start a new job with that objective; it uses fresh proposals, the current mode and its own budget. Recovery never resends the original command. Mode changes or pipe/RPC approval claims do not perform recovery.

## Pane Session continuity

`pane_describe` and console `inspect` return `pane_session_id`, current mode/revision, and `observed_connection`: local/SSH kind, locally observed SSH process IDs, and `remote_identity_authenticated: false`. Process arguments contribute only to the internal binding digest, not these descriptions.

The session binds exact mapping, shell PID, observed SSH process/group/argument context and Herdr continuity. Ordinary local foreground commands preserve the session. SSH entry/exit or changed connection context, pane move/recreation, endpoint inode replacement and passive connection loss invalidate prior proposals and approvals. Normal per-request socket closure is not a new session; a missing Action ACK alone does not invalidate otherwise observable continuity. Undetected PID reuse, remote identity changes, check/send races and external Herdr input remain outside the guarantee.

If a refresh observes a different session, the old job ends with `session_changed`; start a new job, whose initial Delta is `replace` and default mode is 2. The old job cannot silently adopt the new target, scope or mode. Old Evidence remains bound to its immutable old Snapshot until normal retention/purge. New modes/jobs do not release a durable terminal hold. SSH starts passive; the accepted ssh_posix profile requires explicit user preparation below.

## Diagnostic interpretation

Evidence `truncated` describes excerpt pagination (`truncation_scope: "excerpt"`); it never cancels Snapshot history gaps or proves complete terminal history. A module resolution error does not by itself prove a missing file. Cache-hit messages are not contradictory evidence unless their scope actually conflicts with the failure. Keep these as hypotheses when the needed facts are absent.

## SSH POSIX preparation

The ssh_posix profile passed controlled localhost SSH acceptance on Herdr 0.9.0/protocol22. Locally observed SSH processes do not prove a ready remote shell. A user must inspect the current target in the interactive console and issue `ssh-ready <pane_session_id> <absolute cwd>` after checking the actual idle cooperative POSIX shell. This records a user declaration, not authenticated remote identity. Only `ssh_posix` scope with that exact cwd may execute there. Input consumes readiness; trusted completion or a known pre-enqueue rejection restores it. Unknown outcomes require fresh user preparation and the existing held-proposal recovery procedure. A new session discards this declaration and starts in mode 2. Parent RPC arguments cannot confirm readiness.

`risk.uncertainties` lists unresolved Action safety, affected-scope or recovery risks. Diagnostic uncertainty and an outcome not yet observed remain in the diagnosis/receipt; uncertain command success alone is not a safety classification. Never omit actual safety uncertainty to obtain automatic execution. Any supplied risk uncertainty still requires approval in mode 2.
