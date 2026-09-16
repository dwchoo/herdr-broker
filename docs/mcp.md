# Simple Herdr MCP

The default Python stdio server exposes six tools for the verified caller's current Herdr workspace. It has no Console, ownership registration, Job API, SQLite, or separate approval policy. The Parent Codex applies its own approval policy. Tool annotations describe effects; they are not an approval bypass. Legacy TypeScript tools and data remain available through the old entrypoint; see [legacy contract](mcp-legacy.md).

## Tools

All pane operations use the exact `pane_id` and `terminal_id` returned by discovery. Labels and four-digit codes are human references, never execution identities. IDs and labels are untrusted data.

| Tool | Arguments | Result |
| --- | --- | --- |
| `tab_list` | none | Current workspace tabs |
| `pane_list` | optional `tab_id`, `offset` | Metadata page, checked time, truncation/next offset |
| `pane_read` | `pane_id`, `terminal_id`, optional `objective`, `raw=false`, `offset=0` | Default Worker report or user-requested bounded raw text |
| `pane_send` | `pane_id`, `terminal_id`, `request_id`, `text=""`, `keys=[]` | Submission state only |
| `pane_rename` | `pane_id`, `terminal_id`, `name`, `numbered=false` | Updated pane; optionally preserve/allocate numeric label |
| `tab_rename` | `tab_id`, `name` | Updated tab |

`pane_list` includes all panes, including the calling Codex and other agents, across tabs. Process/cwd information is supplied when available; failed or malformed process metadata is marked explicitly for that row. Follow pagination. Failed Herdr queries are errors, never empty lists. Listing never captures terminal text, invokes a Worker, renames, registers or sends input.

When users give incomplete numbers or contextual names, the Parent uses inventory, location and conversation to decide the intended pane, and states its selection. There is no fuzzy matching, prefix correction, confidence score, or candidate-count rule. If intent remains unclear, ask. Then execute using exact returned IDs. A closed/replaced pane is rejected; never silently substitute another pane.

## Read and type

`pane_read` captures a bounded recent screen and invokes `gpt-5.6-luna/high` through the official Codex Python SDK even for short output. Reports contain a concise Korean summary, findings with evidence from supplied lines, suggested checks and uncertainties. Worker tools, filesystem access and network tools are disabled. Worker failures/cancellation are explicit; never silently return raw text or change models. Raw reads are for explicit user requests for original text, with limits and truncation disclosed. Offsets are within the current capture, not durable scrollback cursors.

Target work is visible in the shared pane: type commands to display files, edit them and execute programs. The Parent does not use background file/shell tools as a substitute. SSH, shells, REPLs and TUIs use the same input path without readiness declarations.

`pane_send` submits exactly the text and keys provided. Newlines in text are input too. No implicit Enter or wrapper is added. `accepted` means Herdr acknowledged input, not command success or completion. Reread the screen to assess results. Once delivery may have happened, ACK loss produces `unknown` and no replay. Duplicate IDs return the stored outcome; a changed payload under the same ID fails. Records live for this MCP process only, including cancelled submissions; they are never evicted in a way that allows a repeated ID to resend. Restarting starts fresh: observe before deciding any next action.

Pane identity and current workspace membership are checked before read/input/rename. Herdr currently has no atomic compare-and-send for terminal identity; validation does not freeze the program or user input between observation and submission. Approval is solely the Parent's responsibility.

Known Herdr enqueue rejections (`invalid_key`, `pane_not_found`, `pane_send_failed`) return `rejected`; a failure before submission returns `not_sent`. SDK startup and cleanup failures are explicit Worker errors too. Screen responses must match the requested source and format, with a nonnegative integer revision and boolean truncation flag. Each analysis constrains evidence IDs to the actual captured line IDs and validates them again before returning a report.

## Labels, context and lifecycle

A four-digit prefix in the manual Herdr label is a convenience, e.g. `1234 · 빌드`. Explicit `numbered=true` preserves an existing prefix or chooses an unused current-workspace number. Concurrent naming/user edits may yield duplicate labels; discovery exposes each exact target. No historical registry, permanent global uniqueness or ownership is implied.

Production startup checks the project directory, Herdr-injected environment, canonical user-owned socket, live caller identity and actual process ancestry to the pane shell. Every call verifies that the caller's workspace and terminal remain valid. The MCP owns only its connection and Worker processes; exit cancels analysis and leaves Herdr panes intact. No pane creation, splitting, closing or moving tools are exposed.

Setup changes only the managed MCP block in project settings, preserving approval policy and unrelated settings. Runtime stdout is exclusively MCP; diagnostics use stderr. See [operations](operations.md) for uv/uvx setup and validation.
