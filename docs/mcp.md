# Simple Herdr MCP

The Python stdio server connects a project Codex to the same OS user's local Herdr server, inside or outside a Herdr shell. It has no Console, ownership registration, Job API, SQLite, or separate approval policy. The Parent Codex applies its own approval policy. Tool annotations describe effects; they are not an approval bypass. Legacy TypeScript tools and data remain available through the old entrypoint; see [legacy contract](mcp-legacy.md).

## Tools

All pane operations use the exact `pane_id` and `terminal_id` returned by discovery. Labels and four-digit codes are human references, never execution identities. IDs and labels are untrusted data.

| Tool | Arguments | Result |
| --- | --- | --- |
| `workspace_list` | none | Local Herdr workspaces, focused workspace, verified caller/default workspace if available |
| `tab_list` | optional `workspace_id` | Tabs in the selected workspace |
| `pane_list` | optional `workspace_id`, `tab_id`, `offset` | Metadata page, checked time, truncation/next offset |
| `pane_read` | `pane_id`, `terminal_id`, optional `objective`, `raw=false`, `offset=0` | Default Worker report or user-requested bounded raw text |
| `pane_send` | `pane_id`, `terminal_id`, `request_id`, `text=""`, `keys=[]` | Submission state only |
| `pane_execute` | `pane_id`, `terminal_id`, `request_id`, `command` | Submit the unchanged command and one explicit Enter together; submission state only |
| `pane_rename` | `pane_id`, `terminal_id`, `name`, `numbered=false` | Updated pane; optionally preserve/allocate numeric label |
| `tab_rename` | `tab_id`, `name`, optional `workspace_id` | Updated tab |
| `pane_layout` | `pane_id`, `terminal_id` | Split tree and exact pane identities, metadata only |
| `pane_split` | `pane_id`, `terminal_id`, `request_id`, `direction="right"`, `ratio=0.5` | New shell to the right (side by side) or down (stacked), without taking focus |
| `pane_close` | `pane_id`, `terminal_id`, `request_id` | Close the selected terminal; running work may terminate |
| `pane_swap` | `pane_id`, `terminal_id`, `target_pane_id`, `target_terminal_id`, `request_id` | Swap two panes in the same tab, retaining live terminals |
| `pane_move` | the same exact source/target identities and `request_id`, `direction="right"`, `ratio=0.5` | Move beside a target in another tab of the same workspace |
| `pane_reorient` | `pane_id`, `terminal_id`, `request_id`, `direction` | Change the shared split direction of two sibling leaf panes |

Workspace discovery has no side effects. Inside Herdr, listing defaults to the verified caller workspace. Outside Herdr, the Parent selects an explicit `workspace_id` from `workspace_list` for tab/pane listing; changing UI focus does not silently change the target. Pane operations use the exact discovered IDs. No persistent workspace attachment is created.

Layout directions are `right` (left/right) and `down` (top/bottom), with ratio describing the first pane's share. Splitting creates a fresh shell, not a copy of SSH or another foreground program. The Skill numbers new panes with an explicit rename. Layout operations do not invoke screen Workers. `pane_layout` returns only structure and pane metadata, never exported commands or environment variables.

Herdr 0.9.0 has no in-place split rotation API. Reorientation moves the second sibling into a temporary tab and back beside the first in the requested direction, preserving order, ratio and terminal identity. It supports a split whose two children are leaf panes, including a pair nested in a larger layout. It never calls `layout.apply`, which recreates terminals. If a later step fails, return known progress and stop; a pane may remain in the temporary tab. Do not auto-replay or close that pane as cleanup. Zoomed tabs and changed layouts are reported explicitly.

Input and layout mutations share process-local request-ID deduplication. Results distinguish `pending`, `accepted`, `not_sent`, `rejected`, `partial`, and `unknown`. `partial` means earlier steps were acknowledged before a known failure; `unknown` means the last attempted mutation may have happened. Returned pane locations and progress describe the last acknowledged state, which may already be stale after an unknown result. A duplicate returns recorded progress. A changed payload or tool under the same ID is rejected. Native no-op responses preserve `changed=false` and `reason`.

`pane_list` includes all panes, including the calling Codex and other agents, across tabs. Process/cwd information is supplied when available; failed or malformed process metadata is marked explicitly for that row. Follow pagination. Failed Herdr queries are errors, never empty lists. Listing never captures terminal text, invokes a Worker, renames, registers or sends input.

When users give incomplete numbers or contextual names, the Parent uses inventory, location and conversation to decide the intended pane, and states its selection. There is no fuzzy matching, prefix correction, confidence score, or candidate-count rule. If intent remains unclear, ask. Then execute using exact returned IDs. A closed/replaced pane is rejected; never silently substitute another pane.

## Read and type

Use `pane_execute` for a shell command that should run now, then `pane_read` to check its result. It sends the unchanged nonblank command and exactly one explicit Enter in the same Herdr request, with the same 65,536-byte input limit, identity checks, approval policy and request-ID deduplication as `pane_send`. It adds no wrapper, automatic read, completion watcher or Job. REPL/TUI input still requires judging the current program; use `pane_send` for typing without submission and specific keys.

For example, pass `command="python3 - <<'PY'\nprint('BROKER_' + 'EXEC_PROBE')\nPY\n"` to `pane_execute`. The newline in pasted text is not a reliable substitute for Enter: Herdr wraps text in bracketed paste when the terminal enables it. Verify the actual `BROKER_EXEC_PROBE` output, not marker text echoed inside the command. Output, errors and a returned prompt are evidence; an ACK or echoed heredoc is not completion. If text is still awaiting submission, inspect the current program and send only the needed key instead of replaying the command.

`pane_read` captures a bounded recent screen and invokes `gpt-5.6-luna/high` through the official Codex Python SDK even for short output. Reports contain a concise Korean summary, findings with evidence from supplied lines, suggested checks and uncertainties. Worker tools, filesystem access and network tools are disabled. Worker failures/cancellation are explicit; never silently return raw text or change models. Raw reads are for explicit user requests for original text, with limits and truncation disclosed. Offsets are within the current capture, not durable scrollback cursors.

Target work is visible in the shared pane: type commands to display files, edit them and execute programs. The Parent does not use background file/shell tools as a substitute. SSH, shells, REPLs and TUIs use the same input path without readiness declarations.

`pane_send` submits exactly the text and keys provided. Newlines in text are input too. No implicit Enter or wrapper is added. `accepted` means Herdr acknowledged input, not command success or completion. Reread the screen to assess results. Once delivery may have happened, ACK loss produces `unknown` and no replay. Duplicate IDs return the stored outcome; a changed payload under the same ID fails. Records live for this MCP process only, including cancelled submissions; they are never evicted in a way that allows a repeated ID to resend. Restarting starts fresh: observe before deciding any next action.

Pane identity is checked before read/input/rename/layout mutation. Herdr currently has no atomic compare-and-send for terminal identity; validation does not freeze the program, layout or user input between observation and submission. Approval is solely the Parent's responsibility.

Known Herdr enqueue rejections (`invalid_key`, `pane_not_found`, `pane_send_failed`) return `rejected`; a failure before submission returns `not_sent`. SDK startup and cleanup failures are explicit Worker errors too. Screen responses must match the requested source and format, with a nonnegative integer revision and boolean truncation flag. Each analysis constrains evidence IDs to the actual captured line IDs and validates them again before returning a report.

## Labels, context and lifecycle

The MCP stores no conversation, completed Job history, screen or Worker report. Each analysis starts a fresh ephemeral SDK thread. Up to two analyses may run per MCP process: admission happens before screen capture, and excess calls fail immediately with `worker_busy` without a queue. Analysis keeps its 60-second timeout. SDK cleanup has a five-second wait limit, including on cancellation. Cleanup failure/timeout disables new analyses in that MCP (`worker_cleanup_failed`) and retains unresolved clients for one shutdown cleanup attempt; it does not claim that an unconfirmed child process exited. Metadata and input tools remain available, with no automatic raw/model fallback.

Input and layout submissions retain at most 10,000 process-local dedupe records, with no eviction. Final records contain only digest, status/errors, acknowledged steps, and exact IDs/last-known locations needed for recovery. They omit command text, tree, labels, cwd and other descriptive metadata. The first response retains full details; duplicates return a compact receipt with `details_retained=false`. Use `pane_layout`/discovery for current details. Cancellation and failure also compact the record without losing dedupe protection. At capacity, `request_capacity_reached` rejects new deduplicated mutations before sending; duplicate queries, metadata and reads still work. Reconnect only after checking outstanding work, then rediscover and observe; process restart never authorizes replay.

A four-digit prefix in the manual Herdr label is a convenience, e.g. `1234 · 빌드`. Explicit `numbered=true` preserves an existing prefix or chooses an unused current-workspace number. Concurrent naming/user edits may yield duplicate labels; discovery exposes each exact target. No historical registry, permanent global uniqueness or ownership is implied.

Production startup checks the project directory and canonical user-owned local socket. When Herdr-injected context is present, it also verifies live caller identity and process ancestry, and keeps checking that identity on calls. The live pane determines its tab: moving a terminal can leave its inherited HERDR_TAB_ID stale. Partial or invalid injected context is an error, not a fallback to outside mode. Outside callers need no fabricated pane identity. Remote transport and cloud ChatGPT access are not configured. The MCP owns only its connection and Worker processes; exit cancels analysis and leaves Herdr panes intact. Closing a pane requires an explicit tool call under the Parent's policy.

Setup changes only the managed MCP block in project settings, preserving approval policy and unrelated settings. Runtime stdout is exclusively MCP; diagnostics use stderr. See [operations](operations.md) for uv/uvx setup and validation.
