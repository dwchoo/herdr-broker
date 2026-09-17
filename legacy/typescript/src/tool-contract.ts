import { z } from 'zod';
import { proposalSchema } from './actions.js';
import { scopeSchema } from './sessions.js';

const read = { readOnlyHint: true, destructiveHint: false };
const change = { readOnlyHint: false, destructiveHint: false };
export const brokerTools = {
  pane_describe: { annotations: read, description: 'Describe an exact owned Herdr pane without sending input.', inputSchema: z.strictObject({ pane_id: z.string().min(1).max(256) }) },
  job_start: { annotations: change, description: 'Read pane output using a restricted gpt-5.6-luna/high Worker by default, regardless of length. Use direct only when the user requests original text; auto preserves the legacy size-based behavior. For shared typing use action_scope profile terminal.', inputSchema: z.strictObject({ pane_id: z.string().min(1).max(256), objective: z.string().min(1).max(4096), analysis: z.enum(['auto', 'worker', 'direct']).default('worker'), action_scope: scopeSchema.optional(), budget: z.strictObject({ deadline_ms: z.number().int().min(1).max(300000).optional(), parent_payload_bytes: z.number().int().min(1024).max(16384).optional() }).optional() }) },
  job_status: { annotations: read, description: 'Read an observation job owned by this connection.', inputSchema: z.strictObject({ job_id: z.uuid(), cursor: z.uuid().optional() }) },
  job_wait: { annotations: read, description: 'Wait for an observation job owned by this connection.', inputSchema: z.strictObject({ job_id: z.uuid(), cursor: z.uuid().optional(), wait_ms: z.number().int().min(0).max(20000).default(20000) }) },
  job_cancel: { annotations: change, description: 'Cancel an observation job owned by this connection.', inputSchema: z.strictObject({ job_id: z.uuid() }) },
  action_propose: { annotations: change, description: 'Fix an immutable Action. Default terminal profile uses operation input with exact text and keys (no added wrapper or Enter), objective, target and risk. Works in the existing pane program without ssh-ready. Legacy execute/interrupt use POSIX scope. Does not send input.', inputSchema: proposalSchema },
  action_submit: { annotations: { readOnlyHint: false, destructiveHint: true }, description: 'Submit the stored immutable proposal once after current policy, target and durable intent checks.', inputSchema: z.strictObject({ proposal_id: z.uuid() }) },
  action_status: { annotations: read, description: 'Read proposal eligibility and independent submission/observation states.', inputSchema: z.strictObject({ job_id: z.uuid(), proposal_id: z.uuid() }) },
  session_lower_mode: { annotations: change, description: 'Lower or stop an owned job session. Only the interactive user console can increase a mode.', inputSchema: z.strictObject({ job_id: z.uuid(), mode: z.number().int().min(0).max(3) }) },
  evidence_get: { annotations: read, description: 'Read bounded redacted Evidence beginning at one immutable row ID, including up to 16 following rows. Follow next only when truncated; this is excerpt pagination, not Snapshot history completeness.', inputSchema: z.strictObject({ job_id: z.uuid(), evidence_id: z.string().regex(/^[0-9a-f-]{36}:L\d{4}$/), offset_bytes: z.number().int().min(0).max(65536).default(0) }) },
};
