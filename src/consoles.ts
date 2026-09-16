import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { stateDirectory } from './authority.js';
import { BrokerError, Herdr, type Pane } from './herdr.js';
import { localShellReady } from './sessions.js';
import { Registry, paneKey } from './registry.js';

const target = z.strictObject({ pane_id: z.string().min(1).max(256), terminal_id: z.string().min(1).max(256) });
const recordSchema = z.strictObject({
  console_id: z.uuid(), label: z.string().min(1).max(80), project: z.string().max(4096), endpoint: z.string().max(4096),
  workspace_id: z.string().min(1).max(256), tab_id: z.string().min(1).max(256), controller: target.nullable(), panes: z.array(target).max(64), created_at: z.string().datetime(), background: z.boolean().default(false),
});
export type ConsoleRecord = z.infer<typeof recordSchema>;
export interface ConsoleConfiguration { endpoint: string; stateRoot: string; project: string; herdrContext: { HERDR_PANE_ID: string; HERDR_WORKSPACE_ID: string; HERDR_TAB_ID: string }; launchCore?: (record: ConsoleRecord) => Promise<void> }
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const identity = ({ pane_id, terminal_id }: Pane) => ({ pane_id, terminal_id });
export interface ListedPane {
  pane_id: string; terminal_id: string; pane_code: string; name: string; workspace_id: string; tab_id: string;
  state: 'ready' | 'missing' | 'moved' | 'replaced' | 'unavailable'; checked_at: number | null; error: string | null;
  role: 'terminal' | 'codex' | 'management'; cwd: string | null; processes: string[]; console_id: string | null; console_code: string | null;
  can_operate: boolean; can_register: boolean; metadata_truncated: boolean;
}
export interface PanePage { panes: ListedPane[]; next: string | null; truncated: boolean; error: string | null; checked_at: number | null }

export class Consoles {
  private readonly herdr: Herdr;
  readonly registry: Registry;
  private readonly checked = new Map<string, number>();
  constructor(readonly config: ConsoleConfiguration) { this.herdr = new Herdr(config.endpoint, () => {}); this.registry = new Registry(config.stateRoot); }
  private validate(data: unknown) {
    if (typeof data === 'object' && data && !('tab_id' in data)) throw new BrokerError('console_layout_upgrade_required');
    const record = recordSchema.parse(data);
    if (record.project !== this.config.project || record.endpoint !== this.config.endpoint) throw new BrokerError('console_unavailable');
    const all = [...record.panes, ...(record.controller ? [record.controller] : [])];
    if (new Set(all.map(pane => pane.terminal_id)).size !== all.length || new Set(all.map(pane => pane.pane_id)).size !== all.length) throw new BrokerError('console_invalid');
    return record;
  }
  async get(ref: string): Promise<ConsoleRecord> {
    const id = /^[1-9][0-9]{3}$/.test(ref) ? this.registry.resolve(ref, 'broker').key : ref;
    if (!z.uuid().safeParse(id).success) throw new BrokerError('console_exact_address_required');
    const saved = this.registry.read(id);
    if (saved) return this.validate(saved);
    try {
      const path = join(this.config.stateRoot, 'consoles', id + '.json');
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 16384) throw new Error();
      const record = this.validate(JSON.parse(await readFile(path, 'utf8')));
      if (record.console_id !== id) throw new Error();
      this.registry.save(record); return record;
    } catch (error) { if (error instanceof BrokerError) throw error; throw new BrokerError('console_unavailable'); }
  }
  code(record: ConsoleRecord) { return this.registry.identifyBroker(record.console_id).code; }
  describeRecord(record: ConsoleRecord) {
    return { ...record, console_code: this.code(record), panes: record.panes.map(pane => { const address = this.registry.identifyPane(record.endpoint, pane); return { ...pane, pane_code: address.code, name: address.label, workspace_id: record.workspace_id, tab_id: record.tab_id, state: 'status_check_required', can_operate: false }; }), ...this.availability(record) };
  }
  async list(cursor?: string) {
    let files: string[] = [];
    try { files = await readdir(join(this.config.stateRoot, 'consoles')); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    for (const file of files.filter(file => /^[0-9a-f-]{36}\.json$/.test(file))) { try { await this.get(file.slice(0, -5)); } catch { /* Invalid/foreign legacy records remain untouched. */ } }
    const records = this.registry.records().flatMap(data => { try { return [this.validate(data)]; } catch { return []; } }).sort((a, b) => a.console_id.localeCompare(b.console_id));
    const offset = cursor ? records.findIndex(record => record.console_id === cursor) : -1;
    if (cursor && offset < 0) throw new BrokerError('console_cursor_invalid');
    const rows = [];
    for (const record of records.slice(offset + 1, offset + 9)) {
      const described = this.describeRecord(record);
      const row = { ...described, panes: described.panes.slice(0, 8), pane_count: record.panes.length, panes_truncated: record.panes.length > 8, same_tab: record.tab_id === this.config.herdrContext.HERDR_TAB_ID && record.workspace_id === this.config.herdrContext.HERDR_WORKSPACE_ID };
      if (Buffer.byteLength(JSON.stringify([...rows, row])) > 7000) {
        if (!rows.length) throw new BrokerError('console_metadata_too_large');
        break;
      }
      rows.push(row);
    }
    const more = offset + 1 + rows.length < records.length;
    return { consoles: rows, next: more ? rows.at(-1)!.console_id : null, truncated: more };
  }
  private availability(record: ConsoleRecord) {
    const presence = this.registry.presence(record.console_id);
    return { availability: !record.background ? 'migration_required' : !presence ? 'stopped_or_unconfirmed' : presence.parent.state === 'connected' ? 'connected' : 'available', parent: presence?.parent ?? null, checked_at: presence?.checked_at ?? null };
  }
  async running(record: ConsoleRecord) {
    return this.listening(this.controlSocket(record));
  }
  private listening(path: string) {
    return new Promise<boolean>(resolve => {
      const socket = createConnection(path);
      const finish = (running: boolean) => { clearTimeout(timer); socket.destroy(); resolve(running); };
      const timer = setTimeout(() => finish(false), 1000);
      socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    });
  }
  async verify(record: ConsoleRecord) {
    await this.herdr.check();
    if (!record.background && record.controller) {
      let pane;
      try { pane = await this.herdr.describe(record.controller.pane_id); }
      catch (error) { if (error instanceof BrokerError && error.nativeCode === 'pane_not_found') return; throw error; }
      if (pane.workspace_id !== record.workspace_id || pane.tab_id !== record.tab_id || pane.terminal_id !== record.controller.terminal_id) throw new BrokerError('console_workspace_changed');
    }
  }
  async parent() {
    const context = this.config.herdrContext;
    const pane = await this.herdr.describe(context.HERDR_PANE_ID);
    if (pane.workspace_id !== context.HERDR_WORKSPACE_ID || pane.tab_id !== context.HERDR_TAB_ID) throw new BrokerError('console_tab_required');
    return pane;
  }
  async verifyParent(record: ConsoleRecord, paneId?: string) {
    const pane = paneId === undefined ? await this.parent() : await this.herdr.describe(paneId);
    if (pane.workspace_id !== record.workspace_id || pane.tab_id !== record.tab_id) throw new BrokerError('console_tab_required');
    if (record.panes.some(target => target.terminal_id === pane.terminal_id) || record.controller?.terminal_id === pane.terminal_id) throw new BrokerError('console_parent_is_target');
    return pane;
  }
  socket(record: ConsoleRecord) { return join(stateDirectory(this.config.endpoint, this.config.stateRoot, record.console_id), 'core.sock'); }
  controlSocket(record: ConsoleRecord) { return join(stateDirectory(this.config.endpoint, this.config.stateRoot, record.console_id), 'control.sock'); }
  async create(label: string) {
    const parent = await this.parent();
    const id = randomUUID(); this.registry.identifyBroker(id);
    const reserved = this.registry.reservePane();
    const pane = await this.herdr.splitPane(parent, this.config.project, 'right');
    this.registry.bindReserved(reserved, this.config.endpoint, pane);
    const record = recordSchema.parse({ console_id: id, label, project: this.config.project, endpoint: this.config.endpoint, workspace_id: parent.workspace_id, tab_id: parent.tab_id, controller: null, panes: [identity(pane)], created_at: new Date().toISOString(), background: true });
    this.registry.save(record); await this.rename(record, pane.pane_id, '터미널'); return record;
  }
  async migrate(record: ConsoleRecord) {
    if (record.background) return record;
    await this.verify(record);
    if (!record.controller) throw new BrokerError('console_invalid');
    if (await this.listening(this.socket(record))) throw new BrokerError('console_migration_requires_stopped_core');
    let exists = true;
    try { await this.herdr.describe(record.controller.pane_id); }
    catch (error) { if (error instanceof BrokerError && error.nativeCode === 'pane_not_found') exists = false; else throw error; }
    if (exists) {
      const info = await this.herdr.processInfo(record.controller.pane_id);
      if (!localShellReady(info) || info.foreground_processes.some(item => item.pid !== info.shell_pid)) throw new BrokerError('console_migration_requires_idle_controller');
    }
    const next = { ...record, panes: [...record.panes, record.controller], controller: null, background: true };
    this.registry.save(next, undefined, record);
    if (exists) await this.rename(next, record.controller.pane_id, '터미널'); return next;
  }
  async launch(record: ConsoleRecord) {
    const caller = await this.parent();
    if (caller.tab_id !== record.tab_id || caller.workspace_id !== record.workspace_id) throw new BrokerError('console_tab_required');
    await this.verify(record); record = await this.migrate(record);
    if (await this.running(record)) return record;
    if (this.config.launchCore) { await this.config.launchCore(record); return record; }
    const cli = await realpath(join(this.config.project, 'dist/cli.js'));
    const child = spawn(process.execPath, [cli, 'core', record.console_id], { cwd: record.project, detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: process.env });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new BrokerError('core_start_timeout')); }, 10000);
      const done = (error?: Error) => { clearTimeout(timer); child.removeAllListeners(); if (child.connected) child.disconnect(); child.unref(); error ? reject(error) : resolve(); };
      child.once('error', () => done(new BrokerError('core_start_failed')));
      child.once('exit', () => done(new BrokerError('core_start_failed')));
      child.once('message', value => done(typeof value === 'object' && value && 'ready' in value && value.ready === true ? undefined : new BrokerError('core_start_failed')));
    });
    return record;
  }
  async resolvePane(ref: string) {
    if (/^[0-9]+$/.test(ref)) {
      const address = this.registry.resolve(ref, 'pane');
      if (!address.terminal_id || address.key !== paneKey(this.config.endpoint, address.terminal_id) || !address.pane_id) throw new BrokerError('pane_not_found');
      const pane = await this.herdr.describe(address.pane_id);
      if (pane.terminal_id !== address.terminal_id) throw new BrokerError('target_changed');
      return pane;
    }
    return this.herdr.describe(ref);
  }
  async register(record: ConsoleRecord, ref: string, name?: string) {
    const pane = await this.resolvePane(ref);
    if (pane.workspace_id !== record.workspace_id || pane.tab_id !== record.tab_id) throw new BrokerError('console_tab_required');
    const info = await this.herdr.processInfo(pane.pane_id);
    if (pane.pane_id === this.config.herdrContext.HERDR_PANE_ID || info.foreground_processes.some(process => /codex|claude/.test(process.name + ' ' + (process.argv0 ?? '')))) throw new BrokerError('agent_pane_forbidden');
    const address = this.registry.identifyPane(record.endpoint, pane);
    if (address.role === 'manager') throw new BrokerError('management_pane_forbidden');
    if (address.owner && address.owner !== record.console_id) throw new BrokerError('pane_already_owned');
    record = await this.get(record.console_id);
    const next = { ...record, panes: record.panes.some(item => item.terminal_id === pane.terminal_id) ? record.panes : [...record.panes, identity(pane)] };
    if (next.panes.length > 64) throw new BrokerError('console_terminal_limit');
    this.registry.save(next, undefined, record); await this.rename(next, pane.pane_id, name ?? pane.label ?? '터미널'); return next;
  }
  async rename(record: ConsoleRecord, ref: string, name: string) {
    if (!name.trim() || name.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new BrokerError('pane_name_invalid');
    const pane = await this.resolvePane(ref);
    if (!record.panes.some(target => target.pane_id === pane.pane_id && target.terminal_id === pane.terminal_id) || pane.tab_id !== record.tab_id || pane.workspace_id !== record.workspace_id) throw new BrokerError('pane_outside_console');
    const address = this.registry.identifyPane(record.endpoint, pane);
    const label = name.replace(new RegExp(`^${address.code} · `), '');
    await this.herdr.renamePane(pane.pane_id, `${address.code} · ${label}`); this.registry.label(address.code, label);
    return { ...identity(pane), pane_code: address.code, name: label };
  }
  async addTerminal(record: ConsoleRecord, parentId?: string) {
    await this.verify(record);
    let source: Pane | undefined;
    for (const target of record.panes) {
      try { const pane = await this.herdr.describe(target.pane_id); if (pane.tab_id === record.tab_id && pane.workspace_id === record.workspace_id && pane.terminal_id === target.terminal_id) { source = pane; break; } } catch { /* Find the next live identity. */ }
    }
    if (!source && record.controller) {
      try { const pane = await this.herdr.describe(record.controller.pane_id); if (pane.terminal_id === record.controller.terminal_id && pane.workspace_id === record.workspace_id && pane.tab_id === record.tab_id) source = pane; } catch { /* Try the current Parent next. */ }
    }
    source ??= await this.verifyParent(record, parentId);
    const reserved = this.registry.reservePane();
    const pane = await this.herdr.splitPane(source, record.project, 'right');
    this.registry.bindReserved(reserved, record.endpoint, pane);
    return this.register(record, pane.pane_id, '터미널');
  }
  async openManager(record: ConsoleRecord) {
    record = await this.get(record.console_id);
    if (record.controller) {
      let existing: Pane | undefined;
      try { existing = await this.herdr.describe(record.controller.pane_id); } catch { /* A closed view can be reopened. */ }
      if (existing?.terminal_id === record.controller.terminal_id && existing.tab_id === record.tab_id && existing.workspace_id === record.workspace_id) return this.startManager(record);
    }
    const parent = await this.parent();
    if (parent.tab_id !== record.tab_id || parent.workspace_id !== record.workspace_id) throw new BrokerError('console_tab_required');
    const reserved = this.registry.reservePane();
    const pane = await this.herdr.splitPane(parent, record.project, 'down', 0.75);
    this.registry.bindReserved(reserved, record.endpoint, pane);
    const next = { ...record, controller: identity(pane) };
    this.registry.save(next, randomBytes(32).toString('hex'), record);
    try {
    await this.herdr.renamePane(pane.pane_id, `관리 · ${this.code(record)}`);
    return await this.startManager(next);
    } catch (error) {
      // Do not kill a process the user may have started in the new pane.
      const current = await this.get(record.console_id);
      if (current.controller?.terminal_id === pane.terminal_id) this.registry.save({ ...current, controller: null }, undefined, current);
      throw error;
    }
  }
  private async startManager(record: ConsoleRecord) {
    const expected = record.controller!;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (this.registry.managerConnected(record.console_id, expected.terminal_id)) return record;
      const pane = await this.herdr.describe(expected.pane_id);
      if (pane.terminal_id !== expected.terminal_id || pane.workspace_id !== record.workspace_id || pane.tab_id !== record.tab_id) throw new BrokerError('management_identity_changed');
      const info = await this.herdr.processInfo(pane.pane_id);
      if (localShellReady(info) && info.foreground_processes.every(item => item.pid === info.shell_pid)) {
        const command = [process.execPath, join(record.project, 'dist/cli.js'), 'manage', record.console_id].map(quote).join(' ');
        await this.herdr.send(pane.pane_id, { text: command, keys: ['Enter'] }, new AbortController().signal, {}); return record;
      }
      await delay(100);
    }
    throw new BrokerError('console_controller_busy');
  }
  async closeManager(record: ConsoleRecord) {
    const current = await this.get(record.console_id);
    if (!record.controller || current.controller?.terminal_id !== record.controller.terminal_id) return;
    this.registry.save({ ...current, controller: null }, undefined, current);
    try { const pane = await this.herdr.describe(record.controller.pane_id); if (pane.terminal_id === record.controller.terminal_id && pane.tab_id === record.tab_id) await this.herdr.closePane(pane.pane_id); } catch { /* The user may have closed the view. */ }
  }
  async paneList(record?: ConsoleRecord, scope: 'workspace' | 'broker' = 'workspace', cursor?: string, attached = true): Promise<PanePage> {
    if (scope === 'broker' && !record) throw new BrokerError('console_attach_required');
    const key = scope === 'broker' ? record!.console_id : this.config.herdrContext.HERDR_WORKSPACE_ID;
    let current: Pane[];
    try { current = await this.herdr.list(this.config.herdrContext.HERDR_WORKSPACE_ID); this.checked.set(key, Date.now()); }
    catch (error) { return { panes: [], next: null, truncated: false, error: error instanceof BrokerError ? error.code : 'metadata_unavailable', checked_at: this.checked.get(key) ?? null }; }
    const targets = scope === 'broker' ? record!.panes : current;
    const ordered = [...targets].sort((a,b) => a.pane_id.localeCompare(b.pane_id));
    const offset = cursor ? ordered.findIndex(pane => pane.pane_id === cursor) : -1;
    if (cursor && offset < 0) throw new BrokerError('pane_cursor_invalid');
    const rows: ListedPane[] = [];
    for (const target of ordered.slice(offset + 1, offset + 9)) {
      let pane = current.find(pane => pane.pane_id === target.pane_id);
      let lookupError: string | null = null;
      if (!pane && scope === 'broker') {
        try { pane = await this.herdr.describe(target.pane_id); }
        catch (failure) { if (!(failure instanceof BrokerError && failure.nativeCode === 'pane_not_found')) lookupError = failure instanceof BrokerError ? failure.code : 'metadata_unavailable'; }
      }
      const address = this.registry.identifyPane(this.config.endpoint, target);
      let state: ListedPane['state'] = !pane ? lookupError ? 'unavailable' : 'missing' : pane.terminal_id !== target.terminal_id ? 'replaced' : scope === 'broker' && (pane.tab_id !== record!.tab_id || pane.workspace_id !== record!.workspace_id) ? 'moved' : 'ready';
      let processes: string[] = [], error: string | null = lookupError;
      if (pane && state === 'ready') { try { processes = (await this.herdr.processInfo(pane.pane_id)).foreground_processes.map(item => item.name).slice(0, 16); } catch (failure) { error = failure instanceof BrokerError ? failure.code : 'metadata_unavailable'; state = 'unavailable'; } }
      const role = address.role === 'manager' ? 'management' : pane?.pane_id === this.config.herdrContext.HERDR_PANE_ID || processes.some(name => /codex|claude/.test(name)) ? 'codex' : 'terminal';
      const sameTab = pane?.tab_id === this.config.herdrContext.HERDR_TAB_ID && pane.workspace_id === this.config.herdrContext.HERDR_WORKSPACE_ID;
      const checkedKey = key + ':' + target.terminal_id;
      if (state !== 'unavailable') this.checked.set(checkedKey, Date.now());
      const name = pane?.label ?? address.label ?? pane?.terminal_title_stripped ?? pane?.title ?? '';
      const cwd = pane?.foreground_cwd ?? pane?.cwd ?? null;
      rows.push({ ...target, pane_code: address.code, name: name.slice(0, 120), workspace_id: pane?.workspace_id ?? record!.workspace_id, tab_id: pane?.tab_id ?? record!.tab_id,
        state, checked_at: this.checked.get(checkedKey) ?? null, error, role, cwd: cwd?.slice(0, 768) ?? null, processes: processes.slice(0, 6).map(name => name.slice(0, 64)), metadata_truncated: name.length > 120 || (cwd?.length ?? 0) > 768 || processes.length > 6 || processes.some(name => name.length > 64), console_id: address.owner, console_code: address.owner ? this.registry.identifyBroker(address.owner).code : null,
        can_operate: attached && !!record && address.owner === record.console_id && address.role === 'target' && role === 'terminal' && sameTab && state === 'ready', can_register: attached && !!record && !address.owner && role === 'terminal' && sameTab && state === 'ready' });
      if (Buffer.byteLength(JSON.stringify(rows)) > 7000) { rows.pop(); if (!rows.length) throw new BrokerError('pane_metadata_too_large'); break; }
    }
    const more = offset + 1 + rows.length < ordered.length;
    return { panes: rows, next: more ? rows.at(-1)!.pane_id : null, truncated: more, error: null, checked_at: this.checked.get(key)! };
  }
}
