import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Registry } from '../dist/registry.js';
import { Consoles } from '../dist/consoles.js';
import { connectManagement } from '../dist/management.js';
import { consoleHarness } from './console-project-harness.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Numeric addresses are unique across simultaneous processes, durable and never reused; exhaustion is explicit', async t => {
  const root = await mkdtemp('/private/tmp/hb-registry-'); t.after(() => rm(root, { recursive: true, force: true }));
  const children = Array.from({length: 4}, (_, i) => spawn(process.execPath, ['--input-type=module', '-e', `import {Registry} from './dist/registry.js'; const r=new Registry(process.argv[1]); for(let j=0;j<12;j++) r.identifyBroker(process.argv[2]+'-'+j);`, root, String(i)], { stdio: ['ignore','ignore','pipe'] }));
  for (const child of children) child.stderr.resume();
  assert.deepEqual(await Promise.all(children.map(async child => (await once(child, 'exit'))[0])), [0,0,0,0]);
  const registry = new Registry(root), codes = new Set();
  for (let i=0;i<4;i++) for (let j=0;j<12;j++) codes.add(registry.identifyBroker(`${i}-${j}`).code);
  assert.equal(codes.size, 48); assert.ok([...codes].every(code => /^[1-9][0-9]{3}$/.test(code)));
  assert.equal(new Registry(root).identifyBroker('0-0').code, registry.identifyBroker('0-0').code);
  const db = new Database(join(root, 'registry.sqlite')); db.prepare('INSERT INTO addresses(code,kind,key) VALUES(9999,?,?)').run('broker','last'); db.close();
  assert.throws(() => registry.identifyBroker('exhausted'), { code: 'address_space_exhausted' });
  assert.equal(registry.identifyBroker('last').code, '9999');
});

test('Workspace discovery precedes attachment, includes other tabs and preserves unregistered titles without input or capture', async t => {
  const h = await consoleHarness(t), client = await h.connect();
  const external = h.create('workspace-1','tab-2'); external.label = '기존 이름';
  for (let i=0;i<12;i++) h.create('workspace-1','tab-1');
  const rows = []; let cursor;
  do { const page = await client.call('pane_list', cursor ? {cursor} : {}); assert.equal(page.error,null); rows.push(...page.panes); cursor=page.next; assert.equal(page.truncated,!!cursor); } while(cursor);
  assert.equal(rows.length,14); assert.equal(rows.find(pane => pane.pane_id === 'parent').role,'codex');
  assert.equal(rows.find(pane => pane.pane_id === external.pane_id).tab_id,'tab-2');
  assert.equal(external.label,'기존 이름'); assert.ok(rows.every(pane => !pane.can_operate && pane.console_id === null));
  assert.equal(h.cores.length,0); assert.equal(h.calls.filter(call => ['pane.read','pane.send_input','pane.rename','pane.split'].includes(call.method)).length,0);
  assert.equal((await client.call('pane_list',{scope:'broker'})).error,'console_attach_required');
});

test('Existing shell registration and naming preserve identity; exact addresses cannot bypass ownership or role', async t => {
  const h = await consoleHarness(t), client = await h.connect();
  const owned = await client.call('console_open',{label:'빌드'});
  const shell = h.create('workspace-1','tab-1'); shell.label='테스트';
  const page = await client.call('pane_list',{}), candidate=page.panes.find(pane => pane.pane_id===shell.pane_id);
  assert.equal(candidate.can_register,true);
  const before = h.calls.filter(call => call.method==='pane.send_input').length;
  const registered=await client.call('pane_register',{pane_id:candidate.pane_code,name:'빌드'});
  assert.ok(registered.panes.some(pane=>pane.terminal_id===shell.terminal_id));
  assert.equal(shell.label,`${candidate.pane_code} · 빌드`);
  assert.equal(h.calls.filter(call=>call.method==='pane.send_input').length,before);
  const renamed=await client.call('pane_rename',{pane_id:candidate.pane_code,name:'검증'});
  assert.equal(renamed.pane_code,candidate.pane_code);
  assert.equal((await client.call('pane_register',{pane_id:candidate.pane_code.slice(0,3)})).error,'address_exact_required');
  assert.equal((await client.call('pane_register',{pane_id:'parent'})).error,'agent_pane_forbidden');
  const other=await h.consoles.create('다른 Broker');
  assert.equal((await client.call('pane_register',{pane_id:other.panes[0].pane_id})).error,'pane_already_owned');
  const manager=await client.call('console_manage',{});
  assert.equal((await client.call('pane_register',{pane_id:manager.controller.pane_id})).error,'management_pane_forbidden');
  const updated=await client.call('pane_list',{});
  assert.equal(updated.panes.find(pane=>pane.pane_id===shell.pane_id).can_operate,true);
  assert.equal(updated.panes.find(pane=>pane.pane_id===other.panes[0].pane_id).console_code,h.consoles.code(other));
  assert.equal(updated.panes.find(pane=>pane.pane_id===other.panes[0].pane_id).can_operate,false);
  shell.terminal_id='replacement';
  assert.equal((await client.call('pane_rename',{pane_id:candidate.pane_code,name:'잘못된 대상'})).error,'target_changed');
  assert.equal((await client.call('pane_list',{scope:'broker'})).panes.find(pane=>pane.pane_id===shell.pane_id).state,'replaced');
  assert.equal(new Consoles(h.config).code(await h.consoles.get(owned.console_id)),owned.console_code);
});

test('Discovery failures retain last verification; owned moved and closed panes stay visible', async t => {
  const h=await consoleHarness(t), client=await h.connect();
  const record=await client.call('console_open',{label:'상태'}), target=record.panes[0];
  const first=await client.call('pane_list',{scope:'broker'});
  const original=h.state.respond;
  let failure='pane.list';
  h.state.respond=(socket,request,response)=>request.method===failure ? socket.write(JSON.stringify({id:request.id,error:{code:'offline'}})+'\n') : original(socket,request,response);
  const failed=await client.call('pane_list',{scope:'broker'});
  assert.ok(failed.error); assert.equal(failed.checked_at,first.checked_at);
  failure='pane.process_info';
  const stale=await client.call('pane_list',{scope:'broker'});
  assert.equal(stale.panes[0].state,'unavailable'); assert.equal(stale.panes[0].checked_at,first.panes[0].checked_at);
  failure='none'; h.panes.get(target.pane_id).workspace_id='other-workspace';
  const moved=await client.call('pane_list',{scope:'broker'}); assert.equal(moved.panes[0].state,'moved'); assert.equal(moved.panes[0].can_operate,false);
  h.panes.delete(target.pane_id);
  assert.equal((await client.call('pane_list',{scope:'broker'})).panes[0].state,'missing');
  const added=await client.call('pane_create',{}); assert.equal(added.panes.length,2);
});

test('Explicit detach and numeric switching keep both Brokers alive and permit Parent handoff', async t => {
  const h=await consoleHarness(t), client=await h.connect();
  const first=await client.call('console_open',{label:'첫째'}), second=await h.consoles.create('둘째');
  assert.equal((await client.call('console_attach',{console_id:h.consoles.code(second)})).console_id,second.console_id);
  assert.equal(h.cores.length,2); assert.equal(h.cores[0].parent().state,'disconnected');
  assert.equal((await client.call('console_detach',{})).detached,true);
  assert.equal((await client.call('console_status',{})).attached,false);
  assert.equal((await client.call('pane_list',{})).error,null);
  const next=await h.connect();
  assert.equal((await next.call('console_attach',{console_id:first.console_code})).console_id,first.console_id);
  assert.equal(h.cores.length,2);
});

test('Legacy migration keeps UUID, original terminals and ledger bytes while converting the old controller to a shell', async t => {
  const h=await consoleHarness(t), original=h.create('workspace-1','tab-1');
  const record={console_id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',label:'기존',project:h.config.project,endpoint:h.config.endpoint,workspace_id:'workspace-1',tab_id:'tab-1',controller:{pane_id:original.pane_id,terminal_id:original.terminal_id},panes:[],created_at:new Date().toISOString()};
  const folder=join(h.config.stateRoot,'consoles'); await mkdir(folder,{recursive:true});
  const path=join(folder,record.console_id+'.json'), bytes=JSON.stringify(record); await writeFile(path,bytes,{mode:0o600});
  const legacy=await h.consoles.get(record.console_id), code=h.consoles.code(legacy);
  const migrated=await h.consoles.migrate(legacy);
  assert.equal(migrated.console_id,record.console_id); assert.equal(migrated.controller,null); assert.deepEqual(migrated.panes,[record.controller]);
  assert.equal(h.consoles.code(migrated),code); assert.equal(await readFile(path,'utf8'),bytes);
  assert.equal(h.calls.filter(call=>['pane.split','pane.send_input','pane.close'].includes(call.method)).length,0);
});

test('Remote management rejects forged identity and non-TTY approval; disconnect closes only management', async t => {
  const h=await consoleHarness(t), parent=await h.connect();
  const record=await parent.call('console_open',{label:'권한'}), opened=await parent.call('console_manage',{});
  const auth={...opened.controller,token:h.consoles.registry.managerToken(record.console_id),interactive:false};
  await assert.rejects(connectManagement(h.consoles,opened,{...auth,token:'0'.repeat(64)}),{code:'management_unauthorized'});
  const management=await connectManagement(h.consoles,opened,auth);
  assert.equal((await management.request('command','inspect '+record.panes[0].pane_id)).error,'interactive_console_required');
  await assert.rejects(connectManagement(h.consoles,opened,auth),{code:'management_already_connected'});
  assert.equal((await management.request('snapshot')).console_code,record.console_code);
  management.close(); await pause(80);
  assert.equal((await h.consoles.get(record.console_id)).controller,null);
  assert.equal(h.panes.has(record.panes[0].pane_id),true);
  assert.equal((await parent.call('console_status',{})).parent_connected,true);
  assert.equal(JSON.stringify(record).includes(auth.token),false);
});

test('Concurrent registration has one owner and cannot overwrite another Broker membership', async t => {
  const root=await mkdtemp('/private/tmp/hb-ownership-'); t.after(()=>rm(root,{recursive:true,force:true}));
  const children=Array.from({length:2},(_,i)=>spawn(process.execPath,['--input-type=module','-e',`import {Registry} from './dist/registry.js'; const r=new Registry(process.argv[1]); try {r.save({console_id:process.argv[2],endpoint:'local',panes:[{pane_id:'pane',terminal_id:'terminal'}],controller:null});} catch(e) {if(e.code==='pane_already_owned') process.exitCode=2; else throw e;}`,root,String(i)],{stdio:['ignore','ignore','pipe']}));
  children.forEach(child=>child.stderr.resume());
  const codes=await Promise.all(children.map(async child=>(await once(child,'exit'))[0])); assert.deepEqual(codes.sort(),[0,2]);
  assert.equal(new Registry(root).records().length,1);
});

test('Switch and detach are deferred while an Action is submitting and retain the original Parent', async t => {
  const h=await consoleHarness(t), client=await h.connect();
  const a=await client.call('console_open',{label:'작업 중'}), b=await h.consoles.create('다음');
  const described=await client.call('pane_describe',{pane_id:a.panes[0].pane_id});
  const objective='공유 출력', cwd=h.config.project;
  const job=await client.call('job_start',{ analysis: 'auto',pane_id:a.panes[0].pane_id,objective,action_scope:{profile:'local_posix',cwd,paths:[cwd],trusted:true}});
  await client.call('job_wait',{job_id:job.job_id,wait_ms:1000});
  const proposal=await client.call('action_propose',{job_id:job.job_id,target:described.target,objective,operation:'execute',command:'echo hello',cwd,env:{},affected_paths:[cwd],risk:{classification:'read',inspected:true,impact:'Fixed text output',recovery:'No changes',uncertainties:[],categories:[]}});
  const entered=Promise.withResolvers(), release=Promise.withResolvers();
  h.state.beforeRead=async()=>{entered.resolve();await release.promise;};
  const submission=client.call('action_submit',{proposal_id:proposal.proposal_id});
  await entered.promise;
  assert.equal((await client.call('console_attach',{console_id:h.consoles.code(b)})).error,'action_in_progress');
  assert.equal((await client.call('console_detach',{})).error,'action_in_progress');
  assert.equal((await client.call('console_status',{})).console_id,a.console_id);
  release.resolve(); await submission;
});

test('A separate background core survives actual PTY management exit, Parent disconnect and numeric reconnection', async t => {
  const { consoleProcess }=await import('./console-harness.mjs');
  const h=await consoleHarness(t);
  h.config.launchCore=async record=>{
    const path=join(h.root,'background.json'); await writeFile(path,JSON.stringify({...h.config,consoleId:record.console_id}),{mode:0o600});
    const child=spawn(process.execPath,['test/process-fixture.mjs','core-console',path],{detached:true,stdio:['ignore','pipe','pipe']});
    let output='',errors=''; child.stderr.on('data',chunk=>errors+=chunk);
    await new Promise((resolve,reject)=>{child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('READY'))resolve();});child.once('exit',()=>reject(new Error(errors)));});
    let closed=false; h.cores.push({async close(){if(closed)return;closed=true;const exited=once(child,'exit');child.kill('SIGTERM');await exited;}});
  };
  const parent=await h.connect(), opened=await parent.call('console_open',{label:'함께 작업'});
  const manager=await parent.call('console_manage',{});
  const ui=await consoleProcess(t,h,{consoleConfig:{...h.config,consoleId:opened.console_id,herdrContext:{...h.config.herdrContext,HERDR_PANE_ID:manager.controller.pane_id}},remoteManagement:true,format:'dashboard',columns:56,rows:10});
  await ui.waitFor(text=>text.includes(opened.console_code));
  ui.keys('w'); await ui.waitFor(text=>text.includes('workspace pane'));
  ui.keys('\u001b'); await ui.waitFor(text=>text.startsWith('BROKER'));
  await ui.resize(27,8); await ui.waitFor(text=>text.includes('BROKER'));
  ui.keys(':\u001b[200~status\nnew\u001b[201~'); await ui.waitFor(text=>text.includes('status new'));
  const count=h.panes.size; await pause(1200); assert.equal(h.panes.size,count);
  ui.keys('\u001b'); await ui.waitFor(text=>text.startsWith('BROKER'));
  const ended=once(ui.child,'close'); ui.keys('\u0003'); await ended;
  assert.deepEqual(ui.terminalState(),{canonical:true,echo:true});
  assert.equal((await parent.call('console_status',{})).controller,null);
  assert.equal(h.panes.has(opened.panes[0].pane_id),true);
  parent.close(); await pause(80);
  const next=await h.connect(); assert.equal((await next.call('console_attach',{console_id:opened.console_code})).console_id,opened.console_id);
  assert.equal(h.cores.length,1);
});

test('Rejected switch candidates preserve the active Parent and failed attachments never advertise operability', async t => {
  const h=await consoleHarness(t), first=await h.connect();
  const current=await first.call('console_open',{label:'현재'});
  const foreign=await h.consoles.create('다른 tab');
  h.consoles.registry.save({...foreign,tab_id:'tab-2'},undefined,foreign);
  assert.equal((await first.call('console_attach',{console_id:foreign.console_id})).error,'console_tab_required');
  assert.equal((await first.call('console_status',{})).parent_connected,true);
  const second=await h.connect();
  assert.equal((await second.call('console_attach',{console_id:current.console_id})).error,'console_busy_or_disconnected');
  assert.equal((await second.call('pane_list',{scope:'broker'})).panes[0].can_operate,false);
});

test('Failed management launch relinquishes the failed registration and permits retry', async t => {
  const h=await consoleHarness(t), client=await h.connect();
  const record=await client.call('console_open',{label:'관리 재시도'});
  h.state.controllerProcess='python3';
  assert.equal((await client.call('console_manage',{})).error,'console_controller_busy');
  assert.equal((await h.consoles.get(record.console_id)).controller,null);
  h.state.controllerProcess='sh';
  assert.ok((await client.call('console_manage',{})).controller);
});

test('Large Broker memberships remain discoverable in bounded pages', async t => {
  const h=await consoleHarness(t), client=await h.connect();
  for(let i=0;i<8;i++) {
    const record=await h.consoles.create('큰 목록');
    const panes=Array.from({length:64},(_,j)=>({pane_id:`test-${i}-${j}`,terminal_id:`terminal-test-${i}-${j}`}));
    h.consoles.registry.save({...record,panes},undefined,record);
  }
  let cursor, seen=0;
  do { const page=await client.call('console_list',cursor?{cursor}:{}); assert.ok(Buffer.byteLength(JSON.stringify(page))<=8192); assert.ok(page.consoles.every(item=>item.panes_truncated&&item.pane_count===64)); seen+=page.consoles.length;cursor=page.next; } while(cursor);
  assert.equal(seen,8);
});

test('Closed legacy controllers migrate without recreation and exhausted addresses prevent pane creation', async t => {
  const h=await consoleHarness(t);
  const legacy={console_id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',label:'닫힘',project:h.config.project,endpoint:h.config.endpoint,workspace_id:'workspace-1',tab_id:'tab-1',controller:{pane_id:'closed',terminal_id:'closed-terminal'},panes:[],created_at:new Date().toISOString(),background:false};
  h.consoles.registry.save(legacy);
  const converted=await h.consoles.migrate(await h.consoles.get(legacy.console_id));
  assert.equal(converted.background,true); assert.deepEqual(converted.panes,[legacy.controller]);
  assert.equal((await h.consoles.paneList(converted,'broker')).panes[0].state,'missing');
  const db=new Database(join(h.config.stateRoot,'registry.sqlite')); db.prepare('INSERT INTO addresses(code,kind,key) VALUES(9999,?,?)').run('pane','last-address'); db.close();
  const before=h.calls.filter(call=>call.method==='pane.split').length;
  await assert.rejects(h.consoles.addTerminal(converted),{code:'address_space_exhausted'});
  await assert.rejects(h.consoles.create('번호 없음'),{code:'address_space_exhausted'});
  assert.equal(h.calls.filter(call=>call.method==='pane.split').length,before);
});

test('Discovery racing a split preserves the already published address and never reuses its reservation', async t => {
  const root=await mkdtemp('/private/tmp/hb-address-race-'); t.after(()=>rm(root,{recursive:true,force:true}));
  const creator=new Registry(root), reader=new Registry(root), pane={pane_id:'new-pane',terminal_id:'new-terminal'};
  const reserved=creator.reservePane(), observed=reader.identifyPane('endpoint',pane);
  creator.bindReserved(reserved,'endpoint',pane);
  assert.equal(creator.identifyPane('endpoint',pane).code,observed.code);
  assert.notEqual(creator.reservePane().code,reserved.code);
});

test('A stale management shell is restarted in place after core loss; an authenticated live view is reused', async t => {
  const h=await consoleHarness(t), client=await h.connect();
  const record=await client.call('console_open',{label:'관리 복구'}), first=await client.call('console_manage',{});
  const before=h.calls.filter(call=>call.method==='pane.send_input').length;
  // The old frontend exited when its core disappeared; its native shell remains.
  h.consoles.registry.managerClient(record.console_id,null);
  const resumed=await client.call('console_manage',{});
  assert.deepEqual(resumed.controller,first.controller);
  assert.equal(h.calls.filter(call=>call.method==='pane.send_input').length,before+1);
  const management=await connectManagement(h.consoles,resumed,{...resumed.controller,token:h.consoles.registry.managerToken(record.console_id),interactive:false});
  const reused=await client.call('console_manage',{});
  assert.deepEqual(reused.controller,first.controller);
  assert.equal(h.calls.filter(call=>call.method==='pane.send_input').length,before+1);
  management.close(); await pause(50);
});
