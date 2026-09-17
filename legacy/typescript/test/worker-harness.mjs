import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function workerFixture(t, state = {}) {
  const directory = await mkdtemp('/private/tmp/hb-worker-peer-');
  const executable = join(directory, 'codex-fixture.mjs');
  const statePath = join(directory, 'state.json');
  const callsPath = join(directory, 'calls.jsonl');
  const versionsPath = join(directory, 'versions.jsonl');
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(callsPath, '');
  await writeFile(versionsPath, '');
  await writeFile(executable, `#!${process.execPath}
import { readFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.argv.includes('--version')) {
  const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
  appendFileSync(${JSON.stringify(versionsPath)}, JSON.stringify({ pid: process.pid, envKeys: Object.keys(process.env) }) + '\\n');
  if (state.versionHang) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await new Promise(() => {}); }
  console.log(state.version ?? 'codex-cli 0.154.0'); process.exit(0);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf8'));
const count = readFileSync(${JSON.stringify(callsPath)}, 'utf8').trim().split('\\n').filter(Boolean).length;
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ request, args: process.argv.slice(2), envKeys: Object.keys(process.env), pid: process.pid }) + '\\n');
if (state.mode === 'hang') {
  spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (state.mode === 'event-overflow') { process.stdout.write('x'.repeat(65537)); process.exitCode = 0; }
if (state.mode === 'stream-overflow') for (let i = 0; i < 5; i++) console.log(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'x'.repeat(60000) } }));
let report = { summary: 'Build error observed; root cause remains to be checked.', findings: [{ claim: 'The supplied build error is present.', confidence: 'observed', evidence_ids: [request.snapshot.rows[state.cite ?? 0].evidence_id] }], next_checks: ['Check the indicated source export.'], uncertainties: ['Only the supplied output was observed.'] };
if ((state.mode === 'invalid-once' && count === 0) || state.mode === 'invalid-always') report = { ...report, status: 'diagnosed' };
if (state.mode === 'unknown-id') report.findings[0].evidence_ids = ['00000000-0000-4000-8000-000000000000:L0001'];
if (state.patch) report = { ...report, ...state.patch };
if (state.mode === 'oversized') report.summary = 'x'.repeat(5000);
if (state.mode === 'unexpected-stderr') process.stderr.write('Unexpected profile failure\\n');
if (state.mode === 'tool') console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'forbidden fixture command' } }));
for (const event of [{ type: 'thread.started', thread_id: 'fixture' }, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'agent_message', text: state.mode === 'malformed' ? '{' : JSON.stringify(report) } }, ...(state.mode === 'no-terminal' ? [] : [{ type: 'turn.completed', usage: state.usage === undefined ? { input_tokens: 100, cached_input_tokens: 20, output_tokens: 50 } : state.usage }])]) console.log(JSON.stringify(event));
if (state.mode === 'exit-fail') process.exitCode = 7;
`);
  await chmod(executable, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = async () => (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { executable, directory, versions: async () => (await readFile(versionsPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse), async set(value) { await writeFile(statePath, JSON.stringify(value)); }, calls, async waitForCall() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const recorded = await calls();
      if (recorded.length) return recorded[0];
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('fixture Worker did not start');
  } };
}
