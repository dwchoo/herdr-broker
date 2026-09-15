import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const base = dirname(fileURLToPath(import.meta.url));
export const results = join(base, 'results');
await mkdir(results, { recursive: true });
export const scratch = await mkdtemp(join(tmpdir(), 'herdr-probe-'));
const disabled = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent',
  'hooks', 'memories', 'shell_snapshot', 'browser_use', 'browser_use_external',
  'computer_use', 'image_generation', 'view_image', 'goals', 'code_mode_host',
  'sleep_tool', 'skill_search', 'workspace_dependencies', 'tool_suggest',
  'auth_elicitation', 'tool_call_mcp_elicitation', 'enable_request_compression'];

export function run(binary, args, { input = '', deadline = 60000, cancelAfter = null, env = {}, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const began = Date.now();
    const child = spawn(binary, args, { cwd: scratch, env: { ...process.env, ...env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, canceled = false, overflow = false, killTimer;
    const terminate = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, deadline);
    const cancelTimer = cancelAfter === null ? null : setTimeout(() => { canceled = true; terminate(); }, cancelAfter);
    child.on('error', reject);
    child.stdout.on('data', b => { stdout += b; if (stdout.length > maxBytes) { overflow = true; terminate(); } });
    child.stderr.on('data', b => { stderr += b; if (stderr.length > maxBytes) { overflow = true; terminate(); } });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(cancelTimer); clearTimeout(killTimer);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      let processGroupPresent = false;
      try { process.kill(-child.pid, 0); processGroupPresent = true; } catch {}
      resolve({ code, signal, timedOut, canceled, overflow, processGroupPresent, elapsedMs: Date.now() - began, stdout, stderr });
    });
  });
}

export const common = () => ['-a', 'never', ...disabled.flatMap(f => ['--disable', f]),
  '--disable', 'code_mode', '--disable', 'code_mode_only', '--enable', 'skip_host_skill_discovery'];
export const config = () => [
  '-c', 'history.persistence="none"', '-c', 'web_search="disabled"',
  '-c', `sqlite_home=${JSON.stringify(join(scratch, 'state'))}`,
  '-c', `log_dir=${JSON.stringify(join(scratch, 'logs'))}`];

export function execArgs({ name, model, effort = 'low', provider = [] }) {
  return [...common(), 'exec', ...config(), ...provider, '--ignore-user-config', '--strict-config',
    '--ephemeral', '--sandbox', 'read-only', '--cd', scratch, '--skip-git-repo-check',
    '--model', model, '-c', `model_reasoning_effort=${JSON.stringify(effort)}`,
    '--json', '--color', 'never', '--output-schema', join(base, 'report.schema.json'),
    '-o', join(scratch, `${name}.json`), '-'];
}

export function events(stdout) {
  return stdout.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return { type: 'unparsed', bytes: Buffer.byteLength(line) }; }
  });
}

export const sha256 = text => createHash('sha256').update(text).digest('hex');
export async function save(name, data) {
  const text = JSON.stringify(data, null, 2).replaceAll(scratch, '<probe-dir>').replaceAll(process.env.HOME, '<user-home>');
  await writeFile(join(results, `${name}.json`), text + '\n');
}

export async function fileMetadata(dir, prefix = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name), relative = join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...await fileMetadata(path, relative));
    else if (entry.isFile()) { const s = await stat(path); out.push({ path: relative, bytes: s.size }); }
  }
  return out;
}

async function catalog() {
  const child = spawn('codex', [...common(), 'app-server', ...config(), '--listen', 'stdio://'], { cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '';
  const reply = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('model/list deadline')); }, 45000);
    child.on('error', reject);
    child.stderr.on('data', b => { stderr += b; });
    child.stdout.on('data', b => {
      buffer += b;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 0) {
          child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
          child.stdin.write(JSON.stringify({ method: 'model/list', id: 1, params: { limit: 30, includeHidden: false } }) + '\n');
        }
        if (msg.id === 1) { clearTimeout(timeout); child.stdin.end(); resolve(msg); }
      }
    });
    child.stdin.write(JSON.stringify({ method: 'initialize', id: 0, params: { clientInfo: { name: 'herdr_probe', title: 'Herdr validation', version: '0.0.0' } } }) + '\n');
  });
  child.kill('SIGTERM');
  await save('model-catalog', { at: new Date().toISOString(), reply, stderr });
  console.log(JSON.stringify(reply));
}

async function inventory(mode = 'inventory') {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    let parsed; try { parsed = JSON.parse(body); } catch { parsed = {}; }
    requests.push({ path: req.url, dummyAuth: req.headers.authorization === 'Bearer synthetic-herdr-probe',
      tools: (parsed.tools ?? []).map(t => ({ type: t.type, name: t.name, tools: t.tools?.map(x => ({ type: x.type, name: x.name })) })),
      model: parsed.model, reasoning: parsed.reasoning, store: parsed.store, stream: parsed.stream,
      textFormat: parsed.text?.format?.type,
      functionResults: (parsed.input ?? []).filter(x => x.type === 'function_call_output').map(x => x.output) });
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [] })); return;
    }
    if (mode === 'hang' || mode === 'cancel') return;
    if (mode === 'forced-tool' || mode === 'malformed') {
      const output = mode === 'forced-tool' && !requests.some(x => x.functionResults?.length)
        ? [{ id: 'fc_probe', type: 'function_call', call_id: 'call_probe', name: 'exec_command', arguments: JSON.stringify({ cmd: `cat ${join(scratch, 'canary.txt')}` }), status: 'completed' }]
        : [{ id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: mode === 'malformed' ? '{"not_a_report":true}' : JSON.stringify({ status: 'inconclusive', summary: 'Synthetic tool dispatch probe', findings: [], next_checks: [], uncertainties: ['No file read tool'] }), annotations: [] }] }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      emit({ type: 'response.created', response: { id: 'resp_probe', object: 'response', status: 'in_progress', output: [] } });
      for (const [index, item] of output.entries()) {
        emit({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress' } });
        if (item.type === 'message') emit({ type: 'response.output_text.delta', item_id: item.id, output_index: index, content_index: 0, delta: item.content[0].text });
        emit({ type: 'response.output_item.done', output_index: index, item });
      }
      emit({ type: 'response.completed', response: { id: 'resp_probe', object: 'response', status: 'completed', output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end(); return;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Synthetic inventory capture complete', type: 'invalid_request_error' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const provider = ['-c', 'model_provider="herdrprobe"', '-c', `model_providers.herdrprobe={name="Herdr synthetic probe",base_url="http://127.0.0.1:${port}/v1",env_key="HERDR_PROBE_KEY",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`];
  await writeFile(join(scratch, 'canary.txt'), 'SYNTHETIC_FILE_CANARY_94A');
  const result = await run('codex', execArgs({ name: mode, model: 'gpt-5.6-luna', provider }), { input: 'Analyze only this synthetic input: build failed because fixture.ts is missing.', env: { HERDR_PROBE_KEY: 'synthetic-herdr-probe' }, deadline: mode === 'hang' ? 8000 : 60000, cancelAfter: mode === 'cancel' ? 8000 : null });
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  const final = await readFile(join(scratch, `${mode}.json`), 'utf8').catch(() => null);
  const output = { at: new Date().toISOString(), disabled, requests, result: { ...result, stdout: events(result.stdout) }, final, generatedFiles: await fileMetadata(scratch) };
  await save(`provider-${mode}`, output); console.log(JSON.stringify(output));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'catalog') await catalog();
  else if (['inventory', 'forced-tool', 'malformed', 'hang', 'cancel'].includes(process.argv[2])) await inventory(process.argv[2]);
  else throw new Error('Choose catalog or inventory');
}
