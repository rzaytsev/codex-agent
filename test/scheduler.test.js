import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service,nextCron} from '../src/service.js';
import {validateAction} from '../src/action-registry.js';
import {occurrencePlan} from '../src/scheduler.js';

async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'schedule-policy-')),file=path.join(dir,'db');
 const cfg=config({WORKSPACE_DIR:dir,CODEX_HOME:path.join(dir,'codex'),TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false'});
 const stores=[],open=()=>{const store=new Store(file),service=new Service(cfg,store,{}, {run:async()=>({text:'Synthetic result; goal complete',files:[],done:true})});stores.push(store);return {store,service};};
 t.after(async()=>{for(const store of stores)try{store.db.close();}catch{}await fs.rm(dir,{recursive:true,force:true});});
 const f=open();await f.service.init();return {...f,cfg,file,dir,open};
}
const request=(extra={})=>({kind:'task',prompt:'Synthetic scheduled check',cron:'* * * * *',timezone:'UTC',key:'synthetic',...extra});
const active=store=>store.db.prepare("SELECT * FROM jobs WHERE state IN ('queued','running','cancel_requested') ORDER BY created,rowid").all();
const occurrences=store=>store.db.prepare('SELECT * FROM schedule_occurrences ORDER BY scheduled_for').all();

test('legacy and explicit queue retain one overdue then advance and durable occurrence identity',async t=>{
 for(const policy of [{},{overlap:'queue'}]) {
  const {store,service}=await fixture(t),s=await service.tool({user:'123'},'schedule',request(policy));
  service.schedules(s.due+10*60000);service.schedules(s.due+11*60000);
  const jobs=active(store);assert.equal(jobs.length,2);assert.equal(jobs[0].schedule_id,s.id);assert.equal(jobs[0].scheduled_for,s.due);
  assert.equal(occurrences(store).length,2);
  assert.throws(()=>store.db.prepare('INSERT INTO jobs(id,schedule_id,scheduled_for) VALUES (?,?,?)').run('duplicate',s.id,s.due),/UNIQUE/);
 }
});

test('skip avoids backlog across slow and cancel-requested workers; coalesce retains latest pending and immutable running payload',async t=>{
 for(const overlap of ['skip','coalesce']) {
  const {store,service}=await fixture(t),s=await service.tool({user:'123'},'schedule',request({overlap}));
  service.schedules(s.due);const running=active(store)[0];store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(running.id);
  for(let n=1;n<=20;n++)service.schedules(s.due+n*60000);
  assert.equal(active(store).length,overlap==='skip'?1:2);
  assert.deepEqual({...store.db.prepare('SELECT prompt,scheduled_for FROM jobs WHERE id=?').get(running.id)},{prompt:running.prompt,scheduled_for:s.due});
  if(overlap==='coalesce')assert.equal(active(store).find(j=>j.state==='queued').scheduled_for,s.due+20*60000);
  store.db.prepare("UPDATE jobs SET state='cancel_requested' WHERE id=?").run(running.id);service.schedules(s.due+21*60000);
  assert.equal(active(store).length,overlap==='skip'?1:2);
 }
});

test('explicit misfires skip, coalesce latest or bounded catch up and advance beyond downtime',async t=>{
 for(const misfire of ['skip','coalesce','catch_up']) {
  const {store,service}=await fixture(t),s=await service.tool({user:'123'},'schedule',request({misfire,misfire_grace_seconds:0,...(misfire==='catch_up'?{catch_up_limit:3}:{})}));
  const now=s.due+1000000*60000+1234;service.schedules(now);service.schedules(now);
  assert.equal(active(store).length,misfire==='skip'?0:misfire==='coalesce'?1:3);
  if(misfire==='coalesce')assert.equal(active(store)[0].scheduled_for,now-1234);
  const skipped=occurrences(store).find(r=>r.disposition==='skipped_misfire');assert.ok(skipped.skipped_before>skipped.scheduled_for);
  assert.ok(store.db.prepare('SELECT due FROM schedules').get().due>now);
  assert.ok(occurrences(store).length<=4);
 }
});

test('fault between occurrence admission and advancement rolls back, reopen never duplicates',async t=>{
 const {store,service,open}=await fixture(t),s=await service.tool({user:'123'},'schedule',request());
 store.db.exec("CREATE TEMP TRIGGER synthetic_advance_failure BEFORE UPDATE OF due ON schedules BEGIN SELECT RAISE(ABORT,'Synthetic advance failure'); END");
 assert.throws(()=>service.schedules(s.due),/Synthetic advance/);assert.equal(active(store).length,0);assert.equal(occurrences(store).length,0);
 store.db.exec('DROP TRIGGER synthetic_advance_failure');service.schedules(s.due);
 store.db.close();const reopened=open();reopened.service.schedules(s.due);assert.equal(active(reopened.store).length,1);assert.equal(occurrences(reopened.store).length,1);
});

test('max runs, deadline and endless reminders have distinct truthful states',async t=>{
 const {store,service}=await fixture(t),s=await service.tool({user:'123'},'schedule',request({max_runs:2}));
 service.schedules(s.due);service.schedules(s.due+60000);service.schedules(s.due+120000);
 assert.equal(active(store).length,2);assert.equal(store.db.prepare('SELECT goal_state,enabled FROM schedules WHERE id=?').get(s.id).goal_state,'max_runs_reached');
 const deadline=new Date(Date.now()+120000).toISOString(),d=await service.tool({user:'123'},'schedule',request({key:'deadline',deadline}));
 service.schedules(Date.parse(deadline));assert.equal(store.db.prepare('SELECT goal_state FROM schedules WHERE id=?').get(d.id).goal_state,'deadline_reached');
 const r=await service.tool({user:'123'},'schedule',request({key:'forever',kind:'reminder'}));for(let n=0;n<120;n++)service.schedules(r.due+n*60000);
 const row=store.db.prepare('SELECT enabled,max_runs,runs FROM schedules WHERE id=?').get(r.id);assert.equal(row.enabled,1);assert.equal(row.max_runs,null);assert.equal(row.runs,120);
});

test('goal only completes after settled occurrence and authenticated exact owner command; model claims are insufficient',async t=>{
 const {store,service}=await fixture(t),s=await service.tool({user:'123'},'schedule',request({objective:'Wait for synthetic evidence',done_condition:'Owner confirms synthetic evidence',overlap:'coalesce'}));
 service.schedules(s.due);let job=active(store)[0];
 const row=(await service.tool({user:'123'},'list_schedules',{})).find(r=>r.id===s.id);assert.equal(row.overlap,'coalesce');assert.equal(row.goal_state,'active');assert.match(row.goal_hash,/^[a-f0-9]{64}$/);
 const command=`/schedule_done ${s.id} ${job.id} ${row.goal_hash}`,update=(n,extra={})=>({update_id:n,message:{from:{id:123},chat:{id:123,type:'private'},text:command,...extra}});
 service.ingest(update(1));assert.equal(store.db.prepare('SELECT enabled FROM schedules').get().enabled,1);
 service.workers();await Promise.allSettled(service.workerRuns.values());assert.equal(store.db.prepare('SELECT enabled FROM schedules').get().enabled,1);
 service.schedules(s.due+60000);assert.equal(active(store).length,1);
 service.ingest(update(2,{forward_origin:{type:'hidden_user'}}));service.ingest(update(3,{via_bot:{id:999}}));service.ingest(update(4,{text:command.replace(row.goal_hash,'0'.repeat(64))}));
 assert.equal(store.db.prepare('SELECT enabled FROM schedules').get().enabled,1);
 service.ingest(update(5));service.schedules(s.due+120000);
 assert.equal(store.db.prepare('SELECT goal_state,enabled FROM schedules').get().goal_state,'completed');assert.equal(active(store).length,0);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM schedule_goal_receipts').get().n,1);
});

test('prior Task1 version1 receipt survives upgrade after cancellation and due advancement without mutation',async t=>{
 const {store,service,open}=await fixture(t),args=request(),due=nextCron(args.cron,'UTC'),id='prior-shape';
 store.schedule(id,'123','task',args.prompt,args.cron,'UTC',due,`${store.conversationId}:123:${args.key}`);
 const response={id,due,timezone:'UTC',enabled:1},intent={version:1,owner:'123',conversation:store.conversationId,intent:'schedule',user:'123',actor:'123',parentScope:'conversation',kind:'task',prompt:args.prompt,cron:args.cron,timezone:'UTC',due:null};
 const fingerprint=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(intent).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
 store.db.prepare('INSERT INTO admissions VALUES (?,?,?,?,?,?,?,?)').run('123',store.conversationId,'schedule',args.key,fingerprint,id,JSON.stringify(response),1);
 store.db.prepare('UPDATE schedules SET due=?,enabled=0 WHERE id=?').run(due+60000,id);store.db.close();const reopened=open();const before=reopened.store.db.prepare('SELECT * FROM schedules').get();
 assert.deepEqual(await reopened.service.tool({user:'123'},'schedule',args),response);assert.deepEqual(reopened.store.db.prepare('SELECT * FROM schedules').get(),before);
 for(const change of [{overlap:'skip'},{misfire:'skip'},{objective:'New goal'},{max_runs:2}])await assert.rejects(reopened.service.tool({user:'123'},'schedule',{...args,...change}),/Admission conflict/);
});

test('legacy adoption rejects changed policies or goal; registry denies invalid combinations with no writes',async t=>{
 const {store,service}=await fixture(t),args=request(),due=nextCron(args.cron,'UTC');store.schedule('legacy','123','task',args.prompt,args.cron,'UTC',due,`${store.conversationId}:123:${args.key}`);
 for(const extra of [{overlap:'skip'},{misfire:'skip'},{objective:'New goal'},{max_runs:2}])await assert.rejects(service.tool({user:'123'},'schedule',{...args,...extra}),/Admission conflict/);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM admissions').get().n,0);
 for(const extra of [{overlap:'invalid'},{misfire:'catch_up'},{catch_up_limit:3},{misfire:'skip',catch_up_limit:3},{misfire:'catch_up',catch_up_limit:101},{misfire_grace_seconds:2},{max_runs:0},{kind:'reminder',objective:'No model goal'},{done_condition:'Missing objective'},{deadline:'2030-01-01T00:00:00'}])assert.throws(()=>validateAction({user:'123'},'schedule',request(extra)),/Invalid schedule/);
});

test('cron occurrences follow timezone DST gaps and repeated hours without duplicate UTC identity',async t=>{
 const {store,service}=await fixture(t),s=await service.tool({user:'123'},'schedule',request({cron:'30 2 * * *',timezone:'America/New_York'}));
 const spring=nextCron('30 2 * * *','America/New_York',Date.parse('2026-03-07T08:00:00Z'));assert.equal(new Date(spring).toISOString(),'2026-03-08T07:30:00.000Z');
 store.db.prepare('UPDATE schedules SET due=? WHERE id=?').run(spring,s.id);service.schedules(spring);assert.equal(new Date(store.db.prepare('SELECT due FROM schedules').get().due).toISOString(),'2026-03-09T06:30:00.000Z');
 const fall=nextCron('30 1 * * *','America/New_York',Date.parse('2026-10-31T07:00:00Z'));assert.equal(new Date(fall).toISOString(),'2026-11-01T05:30:00.000Z');assert.equal(new Date(nextCron('30 1 * * *','America/New_York',fall)).toISOString(),'2026-11-02T06:30:00.000Z');
});

test('owner completion rejects scope/actor/session/occurrence drift, survives /new and records one receipt atomically',async t=>{
 const {store,service}=await fixture(t),s=await service.tool({user:'123'},'schedule',request({objective:'Synthetic objective',done_condition:'Synthetic condition'}));
 service.schedules(s.due);const job=active(store)[0];store.db.prepare("UPDATE jobs SET state='completed' WHERE id=?").run(job.id);
 const hash=(await service.tool({user:'123'},'list_schedules',{}))[0].goal_hash;
 const update=(n)=>({update_id:n,message:{from:{id:123},chat:{id:123,type:'private'},text:`/schedule_done ${s.id} ${job.id} ${hash}`}});
 for(const [n,column,value] of [[10,'actor_id','456'],[11,'conversation_id','foreign'],[12,'session_id','foreign'],[13,'scheduled_for',job.scheduled_for+1]]) {
  store.db.prepare(`UPDATE jobs SET ${column}=? WHERE id=?`).run(value,job.id);service.ingest(update(n));
  assert.equal(store.db.prepare('SELECT enabled FROM schedules').get().enabled,1);store.db.prepare(`UPDATE jobs SET ${column}=? WHERE id=?`).run(job[column],job.id);
 }
 store.rotateSession('123');
 store.db.exec("CREATE TEMP TRIGGER synthetic_goal_failure BEFORE UPDATE OF goal_state ON schedules BEGIN SELECT RAISE(ABORT,'Synthetic goal failure'); END");
 service.ingest(update(14));assert.equal(store.db.prepare('SELECT count(*) AS n FROM schedule_goal_receipts').get().n,0);
 store.db.exec('DROP TRIGGER synthetic_goal_failure');service.ingest(update(15));service.ingest(update(16));
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM schedule_goal_receipts').get().n,1);assert.equal(store.db.prepare('SELECT enabled FROM schedules').get().enabled,0);
 assert.equal(store.db.prepare('SELECT authority FROM schedule_goal_receipts').get().authority,'explicit_owner');
});

test('scheduled group worker preserves actor/source/current session and owner DM can confirm after settlement',async t=>{
 const {store,service,cfg,file}=await fixture(t),group=store.bindConversation('123',{id:'synthetic-group',chatId:'-100',kind:'group'});
 cfg.group={...group,state:'active'};
 const s=await service.tool({user:'123',actorId:'123',conversationId:group.id},'schedule',request({objective:'Group objective',done_condition:'Owner condition'}));
 service.schedules(s.due);const job=active(store)[0];assert.equal(job.conversation_id,group.id);assert.equal(job.actor_id,'123');assert.equal(job.session_id,group.session_id);
 store.db.prepare("UPDATE jobs SET state='completed' WHERE id=?").run(job.id);const row=(await service.tool({user:'123',actorId:'123',conversationId:group.id},'list_schedules',{}))[0];
 const message={from:{id:123},chat:{id:-100,type:'group'},text:`/schedule_done ${s.id} ${job.id} ${row.goal_hash}`};service.ingest({update_id:20,message});assert.equal(store.db.prepare('SELECT enabled FROM schedules WHERE id=?').get(s.id).enabled,1);
 delete cfg.group;const dmStore=new Store(file);t.after(()=>dmStore.db.close());const dm=new Service(cfg,dmStore,{},{});
 dm.ingest({update_id:21,message:{...message,chat:{id:123,type:'private'}}});assert.equal(dmStore.db.prepare('SELECT goal_state FROM schedules WHERE id=?').get(s.id).goal_state,'completed');
 assert.equal(dmStore.db.prepare('SELECT conversation_id FROM jobs WHERE id=?').get(job.id).conversation_id,group.id);
});

test('abrupt process exit inside occurrence admission rolls back and snapshot retains occurrence/policy/goal audit',async t=>{
 const {store,service,open,dir,file}=await fixture(t),s=await service.tool({user:'123'},'schedule',request({overlap:'coalesce',objective:'Synthetic objective',done_condition:'Owner confirms'}));
 store.db.close();
 const script=`import {Store} from './src/store.js';import {Service} from './src/service.js';import {config} from './src/config.js';const store=new Store(${JSON.stringify(file)}),cfg=config({WORKSPACE_DIR:${JSON.stringify(dir)},CODEX_HOME:${JSON.stringify(path.join(dir,'codex'))},TELEGRAM_ALLOWED_USER_IDS:'123'}),service=new Service(cfg,store,{},{});const set=store.set.bind(store);store.set=(key,value)=>{set(key,value);if(key.startsWith('task-settings:'))process.exit(75);};service.schedules(${s.due});`;
 await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',script]),e=>e.code===75);
 const f=open();assert.equal(active(f.store).length,0);assert.equal(occurrences(f.store).length,0);assert.equal(f.store.db.prepare('SELECT due FROM schedules').get().due,s.due);
 f.service.schedules(s.due);const job=active(f.store)[0];f.store.db.prepare("UPDATE jobs SET state='completed' WHERE id=?").run(job.id);const row=(await f.service.tool({user:'123'},'list_schedules',{}))[0];
 f.service.ingest({update_id:30,message:{from:{id:123},chat:{id:123,type:'private'},text:`/schedule_done ${s.id} ${job.id} ${row.goal_hash}`}});
 const target=path.join(dir,'snapshot');await promisify(execFile)(process.execPath,['scripts/backup.js',file,target]);const restored=new Store(target);t.after(()=>restored.db.close());
 assert.deepEqual(restored.db.prepare('SELECT * FROM schedule_occurrences').all(),f.store.db.prepare('SELECT * FROM schedule_occurrences').all());assert.deepEqual(restored.db.prepare('SELECT * FROM schedule_goal_receipts').all(),f.store.db.prepare('SELECT * FROM schedule_goal_receipts').all());
 assert.deepEqual(restored.db.prepare('SELECT * FROM schedules').all(),f.store.db.prepare('SELECT * FROM schedules').all());
});

test('deadline before next due settles expired state and suppresses queued continuation',async t=>{
 const {store,service}=await fixture(t),deadline=Date.now()+5000,s=await service.tool({user:'123'},'schedule',request({deadline:new Date(deadline).toISOString()}));
 // An admitted job may already be waiting when its requested deadline passes.
 store.db.prepare('UPDATE schedules SET due=? WHERE id=?').run(deadline-1000,s.id);service.schedules(deadline-1000);assert.equal(active(store).length,1);
 service.schedules(deadline);assert.equal(active(store).length,0);assert.equal(store.db.prepare('SELECT goal_state FROM schedules').get().goal_state,'deadline_reached');
});

test('worker admission rechecks requested deadline even before the next scheduler tick',async t=>{
 const {store,service}=await fixture(t),deadline=Date.now()+5000,s=await service.tool({user:'123'},'schedule',request({deadline:new Date(deadline).toISOString()}));
 store.db.prepare('UPDATE schedules SET due=? WHERE id=?').run(deadline-1000,s.id);service.schedules(deadline-1000);
 const clock=Date.now;Date.now=()=>deadline;
 try {service.workers();await Promise.allSettled(service.workerRuns?.values()||[]);}finally{Date.now=clock;}
 assert.equal(store.db.prepare('SELECT state FROM jobs').get().state,'cancelled');assert.equal(store.db.prepare('SELECT goal_state FROM schedules').get().goal_state,'deadline_reached');
});

test('coalesce promotes only the latest pending occurrence after a slow worker settles',async t=>{
 const {store,service}=await fixture(t),seen=[];let release,started;
 const ready=new Promise(resolve=>{started=resolve;});service.agent.run=async(_user,prompt)=>{seen.push(prompt);if(seen.length===1){started();await new Promise(resolve=>{release=resolve;});}return {text:'Synthetic settled result',files:[]};};
 const s=await service.tool({user:'123'},'schedule',request({overlap:'coalesce'}));service.schedules(s.due);service.workers(1);await ready;
 try {for(let n=1;n<=10;n++)service.schedules(s.due+n*60000);assert.equal(active(store).length,2);}finally{release();}
 await Promise.allSettled(service.workerRuns.values());const latest=active(store)[0];assert.equal(latest.scheduled_for,s.due+10*60000);
 service.workers(1);await Promise.allSettled(service.workerRuns.values());assert.equal(seen.length,2);assert.match(seen[1],new RegExp(latest.id));assert.equal(active(store).length,0);
});

test('misfire coalesce selects the latest forward-valid DST occurrence across both transitions',async t=>{
 for(const [cron,from,now,expected] of [
  ['30 1 * * *','2026-10-30T08:00:00Z','2026-11-01T06:45:00Z','2026-11-01T05:30:00.000Z'],
  ['0,30 1 * * *','2026-10-30T08:00:00Z','2026-11-01T06:45:00Z','2026-11-01T05:30:00.000Z'],
  ['30 2 * * *','2026-03-05T08:00:00Z','2026-03-08T07:45:00Z','2026-03-08T07:30:00.000Z'],
  ['* * * * *','2026-10-20T08:00:00Z','2026-11-01T06:45:00Z','2026-11-01T06:45:00.000Z']
 ]) {
  const {store,service}=await fixture(t),s=await service.tool({user:'123'},'schedule',request({cron,timezone:'America/New_York',misfire:'coalesce',misfire_grace_seconds:0}));
  store.db.prepare('UPDATE schedules SET due=? WHERE id=?').run(nextCron(cron,'America/New_York',Date.parse(from)),s.id);service.schedules(Date.parse(now));
  assert.equal(new Date(active(store)[0].scheduled_for).toISOString(),expected);assert.equal(active(store).length,1);
 }
});

test('configured maintenance reenable preserves its behavior and exposes an active state',async t=>{
 const {store,service,cfg}=await fixture(t);store.set('known:123','1');cfg.cleanupEnabled=true;cfg.proactive=true;cfg.memoryEnabled=true;cfg.learningEnabled=true;await service.init();
 const selected=store.db.prepare("SELECT * FROM schedules WHERE kind IN ('cleanup','learning') OR kind IN ('memory','review') AND prompt='daily'").all();assert.equal(selected.length,4);
 for(const s of selected)await service.tool({user:'123'},'cancel_schedule',{id:s.id});
 cfg.cleanupCron='0 4 * * *';cfg.reviews.daily='0 20 * * *';cfg.memoryCrons.daily='0 5 * * *';cfg.learningCron='0 6 * * *';await service.init();
 for(const s of selected){const current=store.db.prepare('SELECT * FROM schedules WHERE id=?').get(s.id);assert.equal(current.enabled,1);assert.equal(current.goal_state,'active');}
});

for(const [label,cron,from,tick,expected] of [
 ['weekly fall','30 1 * * 0','2026-10-25T08:00:00Z','2026-11-04T12:00:00Z','2026-11-01T05:30:00.000Z'],
 ['monthly fall','30 1 1 * *','2026-10-01T08:00:00Z','2026-11-10T12:00:00Z','2026-11-01T05:30:00.000Z'],
 ['weekly spring','30 2 * * 0','2026-02-22T08:00:00Z','2026-03-11T12:00:00Z','2026-03-08T07:30:00.000Z'],
 ['monthly spring','30 2 8 * *','2026-02-01T08:00:00Z','2026-03-12T12:00:00Z','2026-03-08T07:30:00.000Z']
])test(`sparse ${label} coalesces the latest forward occurrence outside the tick window`,async t=>{
 const {store,service}=await fixture(t),timezone='America/New_York',now=Date.parse(tick),due=nextCron(cron,timezone,Date.parse(from));
 const s=await service.tool({user:'123'},'schedule',request({cron,timezone,misfire:'coalesce',misfire_grace_seconds:0}));store.db.prepare('UPDATE schedules SET due=? WHERE id=?').run(due,s.id);
 service.schedules(now);assert.equal(new Date(active(store)[0].scheduled_for).toISOString(),expected);
 assert.equal(store.db.prepare('SELECT due FROM schedules').get().due,nextCron(cron,timezone,Date.parse(expected)));
 const missed=occurrences(store).find(r=>r.disposition==='skipped_misfire');if(due<Date.parse(expected))assert.equal(missed.skipped_before,Date.parse(expected));
});

for(const misfire of ['coalesce','skip','catch_up'])for(const grace of [0,86400])test(`explicit ${misfire} grace ${grace} advances past the repeated hour across two service ticks`,async t=>{
 const {store,service}=await fixture(t),due=Date.parse('2026-11-01T05:30:00Z'),next=Date.parse('2026-11-02T06:30:00Z');
 const s=await service.tool({user:'123'},'schedule',request({cron:'30 1 * * *',timezone:'America/New_York',misfire,misfire_grace_seconds:grace,...(misfire==='catch_up'?{catch_up_limit:1}:{})}));
 store.db.prepare('UPDATE schedules SET due=? WHERE id=?').run(due,s.id);
 for(const tick of ['2026-11-01T06:15:00Z','2026-11-01T06:30:00Z']) {
  service.schedules(Date.parse(tick));assert.equal(store.db.prepare('SELECT due FROM schedules').get().due,next);
  const jobs=active(store);assert.equal(jobs.length,misfire==='skip'&&grace===0?0:1);if(jobs.length)assert.equal(jobs[0].scheduled_for,due);
 }
 const missed=occurrences(store).find(r=>r.disposition==='skipped_misfire');if(misfire==='skip'&&grace===0)assert.equal(missed.skipped_before,next);
});

test('omitted misfire retains legacy next-from-now repeated-hour behavior',async t=>{
 const {store,service}=await fixture(t),s=await service.tool({user:'123'},'schedule',request({cron:'30 1 * * *',timezone:'America/New_York'}));
 store.db.prepare('UPDATE schedules SET due=? WHERE id=?').run(Date.parse('2026-11-01T05:30:00Z'),s.id);
 service.schedules(Date.parse('2026-11-01T06:15:00Z'));assert.equal(store.db.prepare('SELECT due FROM schedules').get().due,Date.parse('2026-11-01T06:30:00Z'));
 service.schedules(Date.parse('2026-11-01T06:30:00Z'));assert.equal(active(store).length,2);
});

test('explicit DST boundary work stays bounded across years of dense and sparse downtime',()=>{
 const now=Date.parse('2026-11-01T06:45:00Z'),timezone='America/New_York';
 for(const cron of ['* * * * *','30 1 * * 0','30 1 1 * *'])for(const misfire_policy of ['skip','coalesce','catch_up']) {
  const due=nextCron(cron,timezone,Date.parse('2000-01-01T00:00:00Z'));let calls=0;
  const bounded=(...args)=>{assert.ok(++calls<=2983,'forward cron work must not traverse the outage');return nextCron(...args);};
  const plan=occurrencePlan({cron,timezone,due,misfire_policy,misfire_grace_seconds:0,catch_up_limit:100},now,bounded);
  assert.ok(plan.next>now);assert.ok(plan.times.length<=100);
 }
});

for(const misfire of ['coalesce','skip','catch_up'])test(`explicit ${misfire} preserves the upcoming shifted spring occurrence across two service ticks`,async t=>{
 const {store,service}=await fixture(t),due=Date.parse('2026-03-07T07:30:00Z'),shifted=Date.parse('2026-03-08T07:30:00Z'),next=Date.parse('2026-03-09T06:30:00Z');
 const s=await service.tool({user:'123'},'schedule',request({cron:'30 2 * * *',timezone:'America/New_York',misfire,misfire_grace_seconds:0,...(misfire==='catch_up'?{catch_up_limit:1}:{})}));store.db.prepare('UPDATE schedules SET due=? WHERE id=?').run(due,s.id);
 service.schedules(Date.parse('2026-03-08T07:15:00Z'));assert.equal(store.db.prepare('SELECT due FROM schedules').get().due,shifted);assert.equal(active(store).length,misfire==='skip'?0:1);
 service.schedules(shifted);assert.equal(store.db.prepare('SELECT due FROM schedules').get().due,next);assert.equal(active(store).length,misfire==='skip'?1:2);assert.equal(active(store).at(-1).scheduled_for,shifted);
});
