import { lstat, readFile, readdir, open, rename, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { privateDirectory, stateDirectory } from './authority.js';
import { BrokerError, Herdr, type Pane } from './herdr.js';
import { localShellReady } from './sessions.js';

const target = z.strictObject({ pane_id: z.string().min(1).max(256), terminal_id: z.string().min(1).max(256) });
const recordSchema = z.strictObject({
  console_id: z.uuid(), label: z.string().min(1).max(80), project: z.string().max(4096), endpoint: z.string().max(4096),
  workspace_id: z.string().min(1).max(256), tab_id: z.string().min(1).max(256), controller: target, panes: z.array(target).min(1).max(8), created_at: z.string().datetime(),
});
export type ConsoleRecord = z.infer<typeof recordSchema>;
export interface ConsoleConfiguration { endpoint: string; stateRoot: string; project: string; herdrContext: { HERDR_PANE_ID: string; HERDR_WORKSPACE_ID: string; HERDR_TAB_ID: string } }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class Consoles {
  private readonly herdr: Herdr;
  private readonly directory: string;
  constructor(private readonly config: ConsoleConfiguration) {
    this.herdr = new Herdr(config.endpoint, () => {});
    this.directory = join(config.stateRoot, 'consoles');
  }
  private path(id: string) {
    if (!z.uuid().safeParse(id).success) throw new BrokerError('console_invalid');
    return join(this.directory, id + '.json');
  }
  async get(id: string): Promise<ConsoleRecord> {
    try {
      const path = this.path(id);
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16384) throw new Error();
      const data: unknown = JSON.parse(await readFile(path, 'utf8'));
      const legacy = recordSchema.omit({ tab_id: true }).safeParse(data);
      if (legacy.success && legacy.data.console_id === id && legacy.data.project === this.config.project && legacy.data.endpoint === this.config.endpoint) throw new BrokerError('console_layout_upgrade_required');
      const record = recordSchema.parse(data);
      if (record.console_id !== id || record.project !== this.config.project || record.endpoint !== this.config.endpoint) throw new Error();
      if (new Set([record.controller.terminal_id, ...record.panes.map(pane => pane.terminal_id)]).size !== record.panes.length + 1 || new Set([record.controller.pane_id, ...record.panes.map(pane => pane.pane_id)]).size !== record.panes.length + 1) throw new Error();
      return record;
    } catch (error) {
      if (error instanceof BrokerError && error.code === 'console_layout_upgrade_required') throw error;
      throw new BrokerError('console_unavailable');
    }
  }
  async list(cursor?: string) {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { consoles: [], next: null, truncated: false }; throw error; }
    const records = [];
    for (const file of files.filter(file => /^[0-9a-f-]{36}\.json$/.test(file))) {
      try {
        const record = await this.get(file.slice(0, -5));
        records.push({ console_id: record.console_id, label: record.label, workspace_id: record.workspace_id, tab_id: record.tab_id, created_at: record.created_at });
      } catch { /* Other projects and incomplete records are not attachable here. */ }
    }
    records.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.console_id.localeCompare(a.console_id));
    const offset = cursor ? records.findIndex(record => record.console_id === cursor) : -1;
    if (cursor && offset < 0) throw new BrokerError('console_cursor_invalid');
    const page: typeof records = [];
    for (const record of records.slice(offset + 1, offset + 21)) {
      if (Buffer.byteLength(JSON.stringify({ consoles: [...page, record], next: record.console_id, truncated: true })) > 8192) break;
      page.push(record);
    }
    const truncated = offset + 1 + page.length < records.length;
    return { consoles: page, next: truncated ? page.at(-1)!.console_id : null, truncated };
  }
  private async save(record: ConsoleRecord, fresh = false) {
    privateDirectory(this.config.stateRoot); privateDirectory(this.directory);
    const path = this.path(record.console_id);
    const staging = fresh ? path : path + '.' + randomUUID();
    const file = await open(staging, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    if (!fresh) await rename(staging, path);
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async verify(record: ConsoleRecord) {
    const controller = await this.herdr.describe(record.controller.pane_id);
    if (controller.workspace_id !== record.workspace_id || controller.tab_id !== record.tab_id || controller.terminal_id !== record.controller.terminal_id) throw new BrokerError('console_workspace_changed');
  }
  private async parent() {
    const context = this.config.herdrContext;
    const pane = await this.herdr.describe(context.HERDR_PANE_ID);
    if (pane.workspace_id !== context.HERDR_WORKSPACE_ID || pane.tab_id !== context.HERDR_TAB_ID) throw new BrokerError('console_tab_required');
    return pane;
  }
  async verifyParent(record: ConsoleRecord, paneId?: string) {
    const parent = paneId === undefined ? await this.parent() : await this.herdr.describe(paneId);
    if (parent.workspace_id !== record.workspace_id || parent.tab_id !== record.tab_id) throw new BrokerError('console_tab_required');
    return parent;
  }
  socket(record: ConsoleRecord) { return join(stateDirectory(this.config.endpoint, this.config.stateRoot, record.console_id), 'core.sock'); }
  async create(label: string) {
    const consoleId = randomUUID();
    const parent = await this.parent();
    const pane = await this.herdr.splitPane(parent, this.config.project, 'right');
    const controller = await this.herdr.splitPane(pane, this.config.project, 'down', 0.75);
    const identity = ({ pane_id, terminal_id }: Pane) => ({ pane_id, terminal_id });
    const record = recordSchema.parse({ console_id: consoleId, label, project: this.config.project, endpoint: this.config.endpoint, workspace_id: parent.workspace_id, tab_id: parent.tab_id, controller: identity(controller), panes: [identity(pane)], created_at: new Date().toISOString() });
    await this.save(record, true);
    return record;
  }
  async launch(record: ConsoleRecord) {
    const deadline = Date.now() + 3000;
    while (true) {
      await this.verifyParent(record);
      await this.verify(record);
      const info = await this.herdr.processInfo(record.controller.pane_id);
      if (localShellReady(info) && info.foreground_processes.every(item => item.pid === info.shell_pid)) break;
      if (Date.now() >= deadline) throw new BrokerError('console_controller_busy');
      await delay(100);
    }
    const cli = await realpath(join(this.config.project, 'dist/cli.js'));
    const command = [process.execPath, cli, 'serve', record.console_id].map(quote).join(' ');
    await this.herdr.send(record.controller.pane_id, { text: command, keys: ['Enter'] }, new AbortController().signal, {});
  }
  async addTerminal(record: ConsoleRecord) {
    await this.verify(record);
    if (record.panes.length >= 8) throw new BrokerError('console_terminal_limit');
    let source: Pane | undefined;
    for (const identity of record.panes) {
      try {
        const candidate = await this.herdr.describe(identity.pane_id);
        if (candidate.workspace_id === record.workspace_id && candidate.tab_id === record.tab_id && candidate.terminal_id === identity.terminal_id) { source = candidate; break; }
      } catch (error) { if (!(error instanceof BrokerError)) throw error; }
    }
    if (!source) throw new BrokerError('console_target_unavailable');
    const pane = await this.herdr.splitPane(source, record.project, 'right');
    const next = { ...record, panes: [...record.panes, { pane_id: pane.pane_id, terminal_id: pane.terminal_id }] };
    await this.save(next);
    return next;
  }
}
