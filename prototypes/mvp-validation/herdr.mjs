import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { run, scratch, save } from './probe.mjs';

const binary = '/Users/dwchoo/.local/bin/herdr';
const observations = [];
let workspace, pane;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
async function cli(args) {
  const raw = await run(binary, args, { deadline: 10000 });
  let data; try { data = JSON.parse(raw.stdout); } catch { data = null; }
  return { code: raw.code, ms: raw.elapsedMs, data, text: raw.stdout, stderr: raw.stderr };
}
function value(response) { return response.data?.result ?? response.data; }
async function snapshot() {
  const response = await cli(['pane', 'read', pane, '--source', 'recent', '--lines', '1000', '--format', 'ansi']);
  const body = value(response);
  const raw = typeof body === 'string' ? body : body?.text ?? body?.content ?? body?.output ?? response.text;
  return { text: stripVTControlCharacters(raw).replaceAll('\r', ''), revision: body?.revision ?? null, fields: body && typeof body === 'object' ? Object.keys(body) : [] };
}
function envelope(payload, nonce) {
  const body = `printf '\\n__HERDR_%s_%s__\\n' BEGIN ${quote(nonce)}; ( ${payload}\n); herdr_probe_status=$?; printf '\\n__HERDR_%s_%s__:%s\\n' END ${quote(nonce)} "$herdr_probe_status"; exit "$herdr_probe_status"`;
  return `/bin/sh -c ${quote(body)}`;
}
function parse(text, nonce) {
  const begin = `__HERDR_BEGIN_${nonce}__`, end = `__HERDR_END_${nonce}__:`;
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.trimEnd() === begin);
  const ending = lines.map((line, index) => ({ line: line.trimEnd(), index })).filter(x => x.line.startsWith(end) && /^\d{1,3}$/.test(x.line.slice(end.length)) && +x.line.slice(end.length) <= 255);
  if (ending.length !== 1) return { state: 'outcome_unknown', exitCode: null, markerCount: ending.length };
  const finish = ending[0];
  return { state: 'completion_observed', exitCode: +finish.line.slice(end.length), markerCount: 1,
    outputComplete: start >= 0 && start < finish.index,
    output: start >= 0 ? lines.slice(start + 1, finish.index).join('\n') : null };
}
async function action(name, payload, { waitMs = 10000, nonce = randomBytes(8).toString('hex') } = {}) {
  const input = envelope(payload, nonce);
  const before = await snapshot();
  if (before.text.includes(`__HERDR_END_${nonce}__:`)) throw new Error('nonce already present');
  const ack = await cli(['pane', 'run', pane, input]);
  const immediate = parse((await snapshot()).text, nonce);
  const began = Date.now(); let read, parsed;
  do { read = await snapshot(); parsed = parse(read.text, nonce); if (parsed.state === 'completion_observed') break; await pause(100); } while (Date.now() - began < waitMs);
  observations.push({ name, input, nonce, ack: { code: ack.code, ms: ack.ms, data: ack.data }, immediate, final: parsed,
    readRevision: read.revision, returnedLines: read.text.split('\n').length, waitedMs: Date.now() - began });
  return parsed;
}
function identity(response) {
  const body = value(response); const p = body?.pane ?? body;
  return Object.fromEntries(['pane_id', 'terminal_id', 'workspace_id', 'tab_id', 'revision', 'cwd', 'foreground_cwd'].map(k => [k, p?.[k] ?? null]));
}

try {
  const server = await cli(['status', 'server', '--json']);
  if (!server.data?.running) throw new Error('Herdr server is not running');
  observations.push({ name: 'runtime', version: server.data.version, protocol: server.data.protocol });
  await mkdir(join(scratch, 'cwd-fixture'));
  const created = await cli(['workspace', 'create', '--cwd', scratch, '--label', 'herdr-broker-probe', '--no-focus']);
  const body = value(created); workspace = body?.workspace?.workspace_id; pane = body?.root_pane?.pane_id;
  if (!workspace || !pane) throw new Error(`Unexpected create result: ${JSON.stringify(created.data)}`);
  await writeFile(join(scratch, 'owned-target.json'), JSON.stringify({ workspace, pane }));
  await pause(800);
  observations.push({ name: 'initial-identity', identity: identity(await cli(['pane', 'get', pane])) });
  const processInfo = value(await cli(['pane', 'process-info', '--pane', pane]));
  observations.push({ name: 'process-schema', fields: Object.keys(processInfo ?? {}), shellPid: processInfo?.shell_pid ?? null });
  await cli(['pane', 'run', pane, `export HERDR_PROBE_VALUE=fixture_env; cd ${quote(join(scratch, 'cwd-fixture'))}`]);
  await pause(300);
  await action('cwd-environment-exit-zero', 'pwd; printf "env=%s\\n" "$HERDR_PROBE_VALUE"; exit 0');
  await action('nonzero-and-quoting', `printf '%s\\n' ${quote('single quote: \' and literal $HOME ; $(not-a-command)')}; exit 7`);
  await action('ack-before-completion', 'sleep 1; printf "delayed output\\n"; exit 0');
  await action('nonpersistent-cwd', 'cd /; pwd; exit 0');
  await action('inherited-cwd-after-subshell', 'pwd; exit 0');
  await action('large-output-tail', `awk 'BEGIN { for (i=1; i<=1300; i++) printf "fixture output %04d\\n", i }'; exit 0`);
  const spoofNonce = randomBytes(8).toString('hex');
  await action('spoofed-early-marker', `printf '\\n__HERDR_END_${spoofNonce}__:0\\n'; sleep 1; exit 9`, { nonce: spoofNonce });
  await pause(1100);
  observations.push({ name: 'spoof-after-real-exit', parsed: parse((await snapshot()).text, spoofNonce) });
  const invalid = await cli(['pane', 'send-keys', pane, 'HERDR_INVALID_KEY']);
  observations.push({ name: 'invalid-key', code: invalid.code, response: invalid.data, stderr: invalid.stderr });
  const interruptNonce = randomBytes(8).toString('hex');
  await cli(['pane', 'run', pane, envelope('sleep 20; exit 0', interruptNonce)]);
  await pause(300);
  const interrupted = await cli(['pane', 'send-keys', pane, 'Ctrl+c']);
  await pause(500);
  observations.push({ name: 'interrupt', response: interrupted.data, parsed: parse((await snapshot()).text, interruptNonce), note: 'Key ACK alone does not prove process exit.' });
  const beforeMove = identity(await cli(['pane', 'get', pane]));
  const moved = await cli(['pane', 'move', pane, '--new-tab', '--workspace', workspace, '--label', 'probe-moved', '--no-focus']);
  observations.push({ name: 'move', responseCode: moved.code, before: beforeMove, after: identity(await cli(['pane', 'get', pane])) });
  const split = value(await cli(['pane', 'split', pane, '--direction', 'right', '--no-focus']));
  observations.push({ name: 'split-schema', fields: Object.keys(split ?? {}) });
  const closedPane = pane;
  await cli(['pane', 'close', pane]);
  const rejected = await cli(['pane', 'run', closedPane, 'printf "synthetic closed-pane input\\n"']);
  observations.push({ name: 'closed-pane-rejection', code: rejected.code, response: rejected.data, stderr: rejected.stderr });
} catch (error) {
  observations.push({ name: 'probe-error', error: error.message });
  process.exitCode = 1;
} finally {
  if (workspace) {
    const closed = await cli(['workspace', 'close', workspace]);
    observations.push({ name: 'cleanup-owned-workspace', code: closed.code, response: closed.data });
  }
  await save('herdr-live', { at: new Date().toISOString(), observations });
  console.log(JSON.stringify(observations));
}
