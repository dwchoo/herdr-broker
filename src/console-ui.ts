import { emitKeypressEvents, type Key } from 'node:readline';
import stringWidth from 'string-width';
import { ConsoleCommands } from './console-commands.js';
import { bindingLabel, connectionLabel, paneActivity, receiptLabel, type ConsoleSnapshot, type ConsoleView } from './console-view.js';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (value: string) => [...segments.segment(value)].map(item => item.segment);
const displayText = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
function wrapCells(value: string, columns: number): string[] {
  const width = Math.max(1, columns), lines = [];
  let line = '', cells = 0;
  for (const part of graphemes(displayText(value))) {
    const size = stringWidth(part);
    if (cells + size > width && line) { lines.push(line); line = ''; cells = 0; }
    line += size > width ? '?' : part; cells += Math.min(size, width);
  }
  lines.push(line);
  return lines;
}
function clip(value: string, width: number) {
  const safe = displayText(value);
  return stringWidth(safe) <= width ? safe : (wrapCells(safe, Math.max(1, width - 1))[0] ?? '') + (width > 1 ? '…' : '');
}
function cell(value: string, width: number) {
  const text = clip(value, width);
  return text + ' '.repeat(Math.max(0, width - stringWidth(text)));
}
const jsonLines = (value: unknown) => (JSON.stringify(value, null, 2) ?? '응답 없음').split('\n');
const time = (at: number) => new Date(at).toTimeString().slice(0, 8);
function responseLines(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return jsonLines(value);
  if ('error' in value) return ['조작을 적용하지 못했습니다.', `사유: ${value.error}`];
  if ('action_mode' in value && 'pane_session_id' in value && !('target' in value)) return [`Mode ${value.action_mode} 적용`, `Pane Session: ${value.pane_session_id}`];
  if ('authorization' in value && !('payload' in value)) {
    if (value.authorization === 'user_approval') return ['승인 완료 · 아직 제출되지 않음', 'Parent가 action_submit으로 제출하면 실행합니다.'];
    if ('reason' in value && value.reason === 'user_rejected') return ['제안을 거절했습니다.'];
  }
  if ('console_id' in value && 'panes' in value && Array.isArray(value.panes)) return [`Console: ${value.console_id}`, `소유 Target ${value.panes.length}개`, ...value.panes.map(pane => typeof pane === 'object' && pane !== null && 'pane_id' in pane ? `  ${pane.pane_id}` : '')];
  return jsonLines(value);
}
const age = (at: number | null) => at === null ? '확인 기록 없음' : `확인 ${Math.max(0, Math.floor((Date.now() - at) / 1000))}초 전`;
const parentLabel = (parent: ConsoleSnapshot['parent']) => {
  if (parent.state !== 'connected') return connectionLabel(parent.state);
  return parent.metadata && parent.metadata.state !== 'ready' ? bindingLabel(parent.metadata.state) : '연결됨';
};
type Page = 'overview' | 'detail' | 'events' | 'help' | 'proposals' | 'review' | 'mode' | 'command' | 'response';
interface UIState {
  page: Page; selected: string | null; scroll: number; command: string; cursor: number;
  body: unknown; proposal: string | null; choices: string[]; choice: number;
  session: string | null; mode: number; notice: string; busy: boolean; reviewSeen: boolean;
}
const initialState = (): UIState => ({ page: 'overview', selected: null, scroll: 0, command: '', cursor: 0, body: null, proposal: null, choices: [], choice: 0, session: null, mode: 2, notice: '', busy: false, reviewSeen: false });

function detailLines(snapshot: ConsoleSnapshot, state: UIState) {
  const pane = snapshot.panes.find(pane => pane.pane_id === state.selected);
  if (state.page === 'help') return [
    '↑↓ Target 선택 / 상세 스크롤', 'Enter 상세 / 선택 확정', 'a 승인 대기 proposal 검토', 'm 현재 세션 확인 후 Mode 변경', 'n 같은 tab에 Target 추가', 'l 최근 이벤트 (최대 50개)', ': 기존 명령 입력', 'Esc 상태판으로 돌아가기',
    'PageUp/PageDown, Home/End 상세 탐색', '검토: 끝까지 확인한 뒤 y 승인 / n 거절', '명령: ←→ 이동, Backspace 삭제, Enter 실행', '붙여넣기는 명령 입력에서만 텍스트로 삽입', 'Ctrl+C 또는 :quit: core 중지', 'Target terminal과 영속 실행 기록은 유지',
  ];
  if (state.page === 'events') return [...snapshot.events].reverse().map(event => `${time(event.at)} ${event.text}`);
  if (state.page === 'review') return jsonLines(state.body);
  if (state.page === 'response') return responseLines(state.body);
  if (state.page === 'mode') return [`Pane Session: ${state.session}`, '1 · User Approval', '2 · Agent Risk Review (새 세션 기본값)', '3 · Autonomous', `선택: ${state.mode} · 1/2/3 선택 후 Enter`, '사용자만 Mode를 상향할 수 있습니다.'];
  if (state.page === 'proposals') return state.choices.map((id, i) => `${i === state.choice ? '>' : ' '} ${id}`);
  if (!pane) return ['Target이 없습니다.'];
  return [
    `Console: ${snapshot.console_id}`, `Tab: ${snapshot.tab_id}`,
    `Parent: ${snapshot.parent.pane_id ?? '—'} · ${parentLabel(snapshot.parent)} · ${age(snapshot.parent.metadata?.checked_at ?? null)}`,
    ...(snapshot.parent.error || snapshot.parent.metadata?.error ? [`Parent 오류: ${snapshot.parent.error ?? snapshot.parent.metadata?.error}`] : []),
    `Controller: ${snapshot.controller.pane_id} · ${bindingLabel(snapshot.controller.metadata.state)} · ${age(snapshot.controller.metadata.checked_at)}`,
    ...(snapshot.controller.metadata.error ? [`Controller 오류: ${snapshot.controller.metadata.error}`] : []),
    `Target: ${pane.pane_id}`, `Terminal: ${pane.terminal_id}`,
    `연결: ${bindingLabel(pane.metadata.state)} · ${age(pane.metadata.checked_at)}`, ...(pane.metadata.error ? [`오류: ${pane.metadata.error}`] : []),
    `환경: ${pane.connection ?? '확인 필요'}`, `Mode: ${pane.session?.action_mode ?? '확인 필요'}`, `Pane Session: ${pane.session?.pane_session_id ?? '확인 필요'}`,
    `현재 작업: ${paneActivity(pane)}`, `보류: ${pane.held ?? '없음'}`, 'Job / Worker', ...jsonLines(pane.jobs), 'Action Proposal', ...jsonLines(pane.proposals), '영속 Action Receipt',
    ...pane.receipts.flatMap(receipt => [receiptLabel(receipt), ...jsonLines(receipt)]),
  ];
}

function frame(snapshot: ConsoleSnapshot, state: UIState, columns: number, rows: number) {
  const width = Math.max(1, columns - 1), height = Math.max(1, rows);
  const selected = snapshot.panes.findIndex(pane => pane.pane_id === state.selected);
  const index = Math.max(0, selected);
  const pane = snapshot.panes[index];
  let lines: string[];
  if (state.page === 'overview') {
    lines = [`BROKER · ${snapshot.label}`, `Codex ${snapshot.parent.pane_id ?? '—'} · ${parentLabel(snapshot.parent)}`, `  → Console ${snapshot.controller.pane_id}${snapshot.controller.metadata.state !== 'ready' ? ` · ${bindingLabel(snapshot.controller.metadata.state)}` : ''}`, `승인 ${snapshot.pending_approvals} · 보류 ${snapshot.held_count} · Target ${snapshot.panes.length ? index + 1 : 0}/${snapshot.panes.length}`];
    if (height < 7) {
      const topology = `${snapshot.parent.pane_id ?? '—'} → ${snapshot.controller.pane_id} · ${parentLabel(snapshot.parent)}`;
      lines = height >= 4 ? [lines[0]!, topology] : [topology];
      if (height >= 5) lines.push(`승인 ${snapshot.pending_approvals} · 보류 ${snapshot.held_count}`);
    }
    const expanded = columns >= 80 && rows >= 18;
    if (expanded) lines.push(`  ${cell('PANE', 20)}  ${cell('환경', 6)}  ${cell('MODE', 10)}  현재 작업`);
    const room = Math.max(1, height - lines.length - (expanded ? 5 : 2));
    const offset = Math.max(0, index - room + 1);
    for (const target of snapshot.panes.slice(offset, offset + room)) {
      const status = target.metadata.state === 'ready' ? paneActivity(target) : `${bindingLabel(target.metadata.state)} · ${age(target.metadata.checked_at)}`;
      const mode = target.session ? `M${target.session.action_mode}` : '확인 필요';
      const row = expanded ? `${cell(target.pane_id, 20)}  ${cell(target.connection ?? '?', 6)}  ${cell(mode, 10)}  ${status}` : `${target.pane_id}  ${target.connection ?? '?'}  ${mode}  ${status}`;
      lines.push(`${target.pane_id === pane?.pane_id ? '>' : ' '} ${row}`);
    }
    if (pane?.receipts[0] && lines.length < height - 1) lines.push(`최근 실행: ${receiptLabel(pane.receipts[0])}`);
    if (expanded) {
      lines.push('최근 이벤트');
      lines.push(...snapshot.events.slice(-Math.max(0, height - lines.length - 1)).map(event => `${time(event.at)} ${event.text}`));
    }
    lines = lines.slice(0, Math.max(0, height - 1));
    lines.push(state.notice || (height < 5 ? `승인 ${snapshot.pending_approvals} · 보류 ${snapshot.held_count} · ? 도움말` : '↑↓ 선택  Enter 상세  ? 도움말'));
  } else if (state.page === 'command') {
    const parts = graphemes(state.command);
    const before = parts.slice(0, state.cursor).join('');
    const after = parts.slice(state.cursor).join('');
    const content = wrapCells(`: ${before}▏${after}`, width), room = Math.max(1, height - 2);
    const cursorRow = wrapCells(`: ${before}▏`, width).length - 1;
    const offset = Math.max(0, cursorRow - room + 1);
    lines = ['명령 입력 · Enter 실행 / Esc 취소', ...content.slice(offset, offset + room), state.notice || '←→ 이동  Enter 실행  Esc 취소'];
  } else {
    const titles: Partial<Record<Page, string>> = { detail: `${pane?.pane_id ?? ''} 상세`, events: '최근 이벤트', help: '도움말', proposals: '승인 대기 선택', review: '정확한 입력 검토', mode: 'Action Mode', response: '명령 결과' };
    const detail = detailLines(snapshot, state);
    const content = detail.flatMap(line => wrapCells(line, width));
    if (state.page === 'proposals') state.scroll = detail.slice(0, state.choice).reduce((rows, line) => rows + wrapCells(line, width).length, 0);
    const room = Math.max(1, height - 2);
    const offset = Math.max(0, Math.min(state.scroll, content.length - room));
    state.scroll = offset;
    if (state.page === 'review' && height >= 3 && offset + room >= content.length) state.reviewSeen = true;
    const footer = state.page === 'review' ? (state.reviewSeen ? 'y 승인  n 거절  Esc 취소' : '↓/End 끝까지 검토  Esc 취소') : '↑↓ 스크롤  Esc 돌아가기';
    lines = [titles[state.page] ?? '', ...content.slice(offset, offset + room), state.notice || footer];
  }
  if (state.busy && height > 1) lines[lines.length - 1] = '처리 중…';
  return lines.slice(0, height).map(line => clip(line, width));
}

export function startDashboard(view: ConsoleView, commands: ConsoleCommands, quit: () => Promise<void>) {
  const input = process.stdin, output = process.stdout;
  const state = initialState();
  let snapshot = view.snapshot(), closed = false, lastFrame = '', pasting = false;
  const wasRaw = input.isRaw;
  state.selected = snapshot.panes[0]?.pane_id ?? null;
  const paint = () => {
    if (closed) return;
    const lines = frame(snapshot, state, output.columns || 80, output.rows || 24);
    const text = lines.map((line, i) => `\x1b[${i + 1};1H\x1b[2K${i === 0 ? '\x1b[1;36m' : ''}${line}\x1b[0m`).join('') + '\x1b[J';
    if (text !== lastFrame) { output.write(text); lastFrame = text; }
  };
  const refresh = () => {
    if (closed) return;
    try { snapshot = view.snapshot(); paint(); }
    catch { state.notice = '상태 확인 실패'; paint(); }
  };
  const metadata = () => { void view.refresh().then(refresh).catch(() => { state.notice = '연결 확인 실패'; paint(); }); };
  const execute = async (command: string) => {
    state.busy = true; state.notice = ''; paint();
    try { return await commands.run(command); }
    finally { state.busy = false; refresh(); }
  };
  const open = (page: Page) => { state.page = page; state.scroll = 0; state.notice = ''; };
  const response = (value: unknown) => { state.body = value; open('response'); };
  const review = async (id: string) => {
    const result = await execute(`review ${id}`);
    if (typeof result !== 'object' || result === null || 'error' in result) { response(result); return; }
    state.proposal = id; state.body = result; state.reviewSeen = false; open('review');
  };
  const edit = (text: string) => {
    const parts = graphemes(state.command), inserted = graphemes(text.replace(/[\r\n\t]/g, ' '));
    const next = [...parts.slice(0, state.cursor), ...inserted, ...parts.slice(state.cursor)].join('');
    if (next.length > 1024) { state.notice = '명령은 1024자까지 입력할 수 있습니다.'; return; }
    state.command = next; state.cursor += inserted.length;
  };
  const handle = async (text: string | undefined, key: Key) => {
    if (closed) return;
    if (key.name === 'paste-start') { pasting = true; return; }
    if (key.name === 'paste-end') { pasting = false; paint(); return; }
    if (pasting) { if (state.page === 'command' && !state.busy && text) edit(text); return; }
    if (key.ctrl && key.name === 'c') { await quit(); return; }
    if (state.busy) return;
    if (key.name === 'escape') { open('overview'); paint(); return; }
    state.notice = '';
    if (state.page === 'command') {
      const parts = graphemes(state.command);
      if (key.name === 'return' || key.name === 'enter') {
        const command = state.command; state.command = ''; state.cursor = 0;
        response(await execute(command));
      } else if (key.name === 'left') state.cursor = Math.max(0, state.cursor - 1);
      else if (key.name === 'right') state.cursor = Math.min(parts.length, state.cursor + 1);
      else if (key.name === 'home') state.cursor = 0;
      else if (key.name === 'end') state.cursor = parts.length;
      else if (key.name === 'backspace' && state.cursor > 0) { parts.splice(--state.cursor, 1); state.command = parts.join(''); }
      else if (key.name === 'delete') { parts.splice(state.cursor, 1); state.command = parts.join(''); }
      else if (text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test(text)) edit(text);
    } else if (state.page === 'mode') {
      if (text && /^[123]$/.test(text)) state.mode = Number(text);
      if ((key.name === 'return' || key.name === 'enter') && state.session) response(await execute(`mode ${state.session} ${state.mode}`));
    } else if (state.page === 'proposals') {
      if (key.name === 'up') state.choice = Math.max(0, state.choice - 1);
      if (key.name === 'down') state.choice = Math.min(state.choices.length - 1, state.choice + 1);
      if ((key.name === 'return' || key.name === 'enter') && state.choices[state.choice]) await review(state.choices[state.choice]!);
    } else if (state.page === 'review' && (text === 'y' || text === 'n')) {
      if (!state.reviewSeen) state.notice = '끝까지 검토한 뒤 승인·거절해 주세요.';
      else if (state.proposal) response(await execute(`${text === 'y' ? 'approve' : 'reject'} ${state.proposal}`));
    } else if (state.page !== 'overview') {
      if (key.name === 'up') state.scroll--;
      if (key.name === 'down') state.scroll++;
      if (key.name === 'pageup') state.scroll -= Math.max(1, output.rows - 2);
      if (key.name === 'pagedown') state.scroll += Math.max(1, output.rows - 2);
      if (key.name === 'home') state.scroll = 0;
      if (key.name === 'end') state.scroll = Number.MAX_SAFE_INTEGER;
    } else {
      const index = Math.max(0, snapshot.panes.findIndex(pane => pane.pane_id === state.selected));
      if (key.name === 'up') state.selected = snapshot.panes[Math.max(0, index - 1)]?.pane_id ?? null;
      if (key.name === 'down') state.selected = snapshot.panes[Math.min(snapshot.panes.length - 1, index + 1)]?.pane_id ?? null;
      if (key.name === 'return' || key.name === 'enter') open('detail');
      if (text === '?') open('help');
      if (text === 'l') open('events');
      if (text === ':') open('command');
      if (text === 'n') { response(await execute('new')); metadata(); }
      if (text === 'a') {
        state.choices = (snapshot.panes.find(pane => pane.pane_id === state.selected)?.proposals ?? []).filter(proposal => proposal.authorization === 'approval_required').map(proposal => proposal.proposal_id);
        state.choice = 0;
        if (state.choices.length === 1) await review(state.choices[0]!);
        else if (state.choices.length > 1) open('proposals');
        else state.notice = '선택한 Target에 승인 대기가 없습니다.';
      }
      if (text === 'm' && state.selected) {
        const inspected = await execute(`inspect ${state.selected}`);
        if (typeof inspected === 'object' && inspected !== null && 'pane_session_id' in inspected && typeof inspected.pane_session_id === 'string' && 'action_mode' in inspected && typeof inspected.action_mode === 'number') {
          state.session = inspected.pane_session_id; state.mode = inspected.action_mode; open('mode');
        } else response(inspected);
      }
    }
    paint();
  };
  const onKey = (text: string | undefined, key: Key) => { void handle(text, key).catch(() => { state.busy = false; state.notice = '조작 실패'; paint(); }); };
  const onResize = () => { lastFrame = ''; paint(); };
  input.setRawMode(true);
  emitKeypressEvents(input);
  input.on('keypress', onKey); output.on('resize', onResize);
  output.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
  paint(); metadata();
  const tick = setInterval(refresh, 1000), poll = setInterval(metadata, 2000);
  return () => {
    if (closed) return;
    closed = true; clearInterval(tick); clearInterval(poll);
    input.off('keypress', onKey); output.off('resize', onResize);
    input.setRawMode(wasRaw ?? false);
    output.write('\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l');
  };
}
