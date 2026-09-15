import { readFileSync, writeFileSync, appendFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { base, scratch, save, results } from './probe.mjs';
import { initial, transition } from './action-state.mjs';
import { validateReport } from './worker.mjs';

const script = fileURLToPath(import.meta.url);
if (process.argv[2] === 'crash-child') {
  const [mode, directory] = process.argv.slice(3);
  if (mode === 'before-intent') process.exit(72);
  const fd = openSync(join(directory, `${mode}.journal`), 'w');
  writeFileSync(fd, JSON.stringify({ proposal: 'fixed-1', hash: 'fixed-hash', state: 'dispatching' }) + '\n'); fsyncSync(fd); closeSync(fd);
  if (mode === 'after-intent') process.exit(73);
  appendFileSync(join(directory, `${mode}.wire`), 'submitted once\n');
  process.exit(74);
}

const cases = [];
const proposals = new Map(), owners = new Map(); let sends = 0;
function schedule(id, hash, terminal) {
  if (proposals.has(id)) return proposals.get(id).hash === hash ? 'same receipt' : 'payload mismatch';
  if (owners.has(terminal)) return 'queued without sending';
  proposals.set(id, { hash, terminal }); owners.set(terminal, id); sends++; return 'submitted';
}
const first = schedule('job-a-proposal', 'payload-a', 'terminal-fixture');
const duplicate = schedule('job-a-proposal', 'payload-a', 'terminal-fixture');
const changed = schedule('job-a-proposal', 'changed-payload', 'terminal-fixture');
const waiting = schedule('job-b-proposal', 'payload-b', 'terminal-fixture');
owners.delete('terminal-fixture');
const resumed = schedule('job-b-proposal', 'payload-b', 'terminal-fixture');
cases.push({ scenario: 'two jobs; fixed proposal dedup and terminal serialization', evidence: 'in-memory scheduler fixture', first, duplicate, changed, waiting, resumed, sends });
for (const mode of ['before-intent', 'after-intent', 'after-send']) {
  const child = spawnSync(process.execPath, [script, 'crash-child', mode, scratch], { timeout: 10000 });
  const journal = (() => { try { return readFileSync(join(scratch, `${mode}.journal`), 'utf8'); } catch { return ''; } })();
  const wire = (() => { try { return readFileSync(join(scratch, `${mode}.wire`), 'utf8'); } catch { return ''; } })();
  cases.push({ scenario: mode, evidence: 'fault process; fsync journal then injected exit; wire is a local fixture', exit: child.status,
    restored: journal ? 'unknown' : 'not_submitted', externalAttemptsKnownOnlyToHarness: wire ? 1 : 0, replayCount: 0, terminalHeld: Boolean(journal) });
}
for (const [name, sequence] of [
  ['duplicate submit', ['submit', 'submit', 'ack', 'complete', 'submit']],
  ['ACK loss then observed exit', ['submit', 'lost', 'submit', 'complete']],
  ['accepted then partial-write/lost-marker fixture', ['submit', 'ack', 'timeout', 'submit']],
  ['restart with intent', ['submit', 'restart', 'submit']],
  ['session changes before submit', ['session', 'submit']],
  ['job cancellation after acceptance', ['submit', 'ack', 'cancel']]
]) {
  let state = initial(); const steps = [];
  for (const event of sequence) { state = transition(state, event); steps.push({ event, state }); }
  cases.push({ scenario: name, evidence: 'pure state fixture; not a live Herdr fault', steps });
}
const malformed = JSON.parse(readFileSync(join(results, 'provider-malformed.json'), 'utf8'));
cases.push({ scenario: 'CLI success is insufficient', cliCode: malformed.result.code, errors: validateReport(JSON.parse(malformed.final), new Set(['L0001'])) });
cases.push({ scenario: 'unknown evidence rejected', errors: validateReport({ status: 'diagnosed', summary: 'fixture', findings: [{ claim: 'fixture', confidence: 'observed', evidence_ids: ['L9999'] }], next_checks: [], uncertainties: [] }, new Set(['L0001'])) });
await save('faults', { at: new Date().toISOString(), cases });

const actions = { submit: '제출 시도', ack: 'Herdr 입력 수락', lost: '응답 유실', complete: '종료 표식 관찰', timeout: '관찰 기한 경과', cancel: '작업 취소', restart: 'Broker 재시작', session: 'Pane Session 변경' };
const scenarios = [
  { title: '정상 종료', text: '입력 수락과 종료 관찰이 별개의 단계인지 확인하세요.', steps: ['submit', 'ack', 'complete'] },
  { title: '응답 유실', text: '수락 응답이 없어도 종료는 관찰할 수 있습니다. 같은 제안은 다시 전송하지 않습니다.', steps: ['submit', 'lost', 'submit', 'complete'] },
  { title: '재시작', text: '전송 의도만 남은 경우 새 Broker가 입력을 재생하면 중복 실행할 수 있습니다.', steps: ['submit', 'restart', 'submit'] },
  { title: '대상 변경', text: '같은 pane 주소라도 새 실행 문맥에는 기존 제안이 유효하지 않습니다.', steps: ['session', 'submit'] },
  { title: '결과 불명', text: '입력 수락 이후 출력이 끊기면 다음 일반 명령을 보류합니다.', steps: ['submit', 'ack', 'timeout', 'submit'] }
];
const html = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Herdr Action 계약</title><style>body{font:16px/1.7 system-ui;margin:48px auto;max-width:920px;padding:0 24px;color:#18302b;background:#f5f7f4}h1{font-size:32px}section{background:white;border:1px solid #d9e3df;border-radius:12px;padding:24px;margin:24px 0}dl{display:grid;grid-template-columns:170px 1fr}dt{color:#526760}dd{margin:0;font-weight:600}button{font:inherit;padding:9px 14px;margin:4px;border:1px solid #a6bdb4;border-radius:7px;background:white;cursor:pointer}button[aria-selected=true]{background:#166653;color:white}#notice{padding:16px;background:#edf5ef}small{color:#526760}</style><h1>Herdr Action은 어디까지 확인됐을까요?</h1><p>제출·완료 관찰을 분리하면 응답 유실, 중복 호출, 세션 변경을 어떻게 다루는지 눌러보세요. 이 demo는 상태 계약이며 실제 pane을 조작하지 않습니다.</p><section><h2>현재 상태</h2><dl id="state"></dl><p id="notice"></p></section><section><h2>자유롭게 눌러보기</h2><div id="free"></div><button id="reset">처음으로</button></section><section><h2>사례별 따라가기</h2><div id="tabs" role="tablist"></div><p id="description"></p><div id="steps"></div></section><small>종료 표식은 terminal 출력에 대한 관찰입니다. 악의적인 출력은 표식을 위조할 수 있고, 이 상태 모델은 실제 실행의 진위를 증명하지 않습니다.</small><script>${initial.toString()};${transition.toString()};const actions=${JSON.stringify(actions)},scenarios=${JSON.stringify(scenarios)};let state=initial(),active=0,step=0;const labels={not_submitted:'미제출',dispatching:'전송 시도 중',accepted:'입력 수락',unknown:'접수 불명',not_started:'관찰 전',observing:'관찰 중',completion_observed:'종료 표식 관찰',outcome_unknown:'결과 불명'};function render(){document.getElementById('state').innerHTML=[['입력 제출',labels[state.submission]],['결과 관찰',labels[state.observation]],['제출 시도',state.attempts+'회'],['다음 일반 입력',state.held?'보류':'보류 없음'],['현재 세션',state.session],['제안의 세션',state.proposalSession]].map(([k,v])=>'<dt>'+k+'</dt><dd>'+v+'</dd>').join('');document.getElementById('notice').textContent=state.message;}function dispatch(event){state=transition(state,event);render();}for(const [key,title] of Object.entries(actions)){const b=document.createElement('button');b.textContent=title;b.onclick=()=>dispatch(key);document.getElementById('free').append(b);}document.getElementById('reset').onclick=()=>{state=initial();render();};function choose(i){active=i;step=0;state=initial();render();document.getElementById('description').textContent=scenarios[i].text;document.querySelectorAll('[role=tab]').forEach((b,j)=>b.setAttribute('aria-selected',i===j));document.getElementById('steps').replaceChildren();scenarios[i].steps.forEach((event,n)=>{const b=document.createElement('button');b.textContent=(n+1)+'. '+actions[event];b.onclick=()=>{if(n!==step)return;dispatch(event);step++;b.disabled=true;};document.getElementById('steps').append(b);});}scenarios.forEach((s,i)=>{const b=document.createElement('button');b.textContent=s.title;b.setAttribute('role','tab');b.onclick=()=>choose(i);document.getElementById('tabs').append(b);});choose(0);</script></html>`;
writeFileSync(join(base, 'state-demo.html'), html);
console.log(JSON.stringify(cases));
