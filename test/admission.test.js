import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';

async function fixture(t,owner='123') {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-admission-')),file=path.join(dir,'db');
  const cfg=config({WORKSPACE_DIR:dir,CODEX_HOME:path.join(dir,'codex'),TELEGRAM_ALLOWED_USER_IDS:owner,PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false'});
  const stores=[],services=[];
  const open=()=>{const store=new Store(file),service=new Service(cfg,store,{}, {run:async()=>({text:'',files:[]})});stores.push(store);services.push(service);return {store,service};};
  const initial=open();await initial.service.init();
  t.after(async()=>{for(const service of services){service.stopping=true;await Promise.allSettled(service.workerRuns?.values()||[]);}for(const store of stores)try{store.db.close();}catch{}await fs.rm(dir,{recursive:true,force:true});});
  return {...initial,cfg,dir,file,open};
}
const task={prompt:'Synthetic objective',profile:'research',title:'Synthetic title',acknowledgment:'Starting the synthetic work.',settings:{toolScope:'read',timeout:30},request_key:'synthetic-request'};
const schedule=()=>({kind:'reminder',prompt:'Synthetic reminder',due:new Date(Date.now()+60000).toISOString(),key:'synthetic-schedule'});
const count=(store,table)=>store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const subprocess=(dir,file,body)=>`import {Store} from './src/store.js';import {Service} from './src/service.js';import {config} from './src/config.js';const store=new Store(${JSON.stringify(file)});const cfg=config({WORKSPACE_DIR:${JSON.stringify(dir)},CODEX_HOME:${JSON.stringify(path.join(dir,'codex'))},TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false'});const service=new Service(cfg,store,{},{});${body}`;

test('task admission rolls back job and metadata after an intermediate statement fails',async t=>{
  const {store,service}=await fixture(t),set=store.set.bind(store);
  store.set=(key,value)=>{set(key,value);if(key.startsWith('task-title:'))throw new Error('Synthetic crash between admission writes');};
  await assert.rejects(service.tool({user:'123'},'create_task',task),/Synthetic crash/);
  assert.equal(count(store,'jobs'),0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'task-%'").get().n,0);
  assert.equal(count(store,'admissions'),0);
});

test('admission ledger failure rolls back every task write and allows a clean retry',async t=>{
  const {store,service}=await fixture(t);
  store.db.exec("CREATE TEMP TRIGGER synthetic_admission_failure AFTER INSERT ON admissions BEGIN SELECT RAISE(ABORT,'Synthetic ledger failure'); END");
  await assert.rejects(service.tool({user:'123'},'create_task',task),/Synthetic ledger failure/);
  assert.equal(count(store,'jobs'),0);assert.equal(count(store,'admissions'),0);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'task-%'").get().n,0);
  store.db.exec('DROP TRIGGER synthetic_admission_failure');
  const result=await service.tool({user:'123'},'create_task',task);assert.equal(store.jobs('123')[0].id,result.id);
});

test('lost task response and normalized retry across reopen return one job and one start acknowledgment',async t=>{
  const {store,service,open}=await fixture(t);
  const original=await service.tool({user:'123'},'create_task',task);
  store.db.close();const reopened=open();await reopened.service.init();
  const retry=await reopened.service.tool({user:'123'},'create_task',{...task,request_key:' '+task.request_key+' ',prompt:'  '+task.prompt+'  ',title:' '+task.title+' ',acknowledgment:' '+task.acknowledgment+' ',settings:{timeout:30,toolScope:'read'}});
  assert.deepEqual(retry,original);assert.equal(count(reopened.store,'jobs'),1);assert.equal(count(reopened.store,'admissions'),1);
  assert.deepEqual(JSON.parse(reopened.store.get(`task-settings:${original.id}`)),{effort:'medium',timeout:30,toolScope:'read'});
  reopened.service.workers();reopened.service.workers();
  await Promise.allSettled(reopened.service.workerRuns.values());
  await reopened.service.tool({user:'123'},'create_task',task);reopened.service.workers();
  assert.equal(reopened.store.db.prepare('SELECT payload FROM outbox').all().filter(row=>JSON.parse(row.payload).text===task.acknowledgment).length,1);
});

test('a separate process retries a committed task after response loss',async t=>{
  const {store,service,dir,file}=await fixture(t),first=await service.tool({user:'123'},'create_task',task);
  const script=subprocess(dir,file,`console.log(JSON.stringify(await service.tool({user:'123'},'create_task',${JSON.stringify(task)})));store.db.close();`);
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script]);
  assert.deepEqual(JSON.parse(stdout),first);assert.equal(count(store,'jobs'),1);
});

test('abrupt process exit between task statements leaves no admitted or runnable partial job',async t=>{
  const {store,dir,file,open}=await fixture(t);store.db.close();
  const script=subprocess(dir,file,`const set=store.set.bind(store);store.set=(key,value)=>{set(key,value);if(key.startsWith('task-title:'))process.exit(75);};await service.tool({user:'123'},'create_task',${JSON.stringify(task)});`);
  await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',script]),error=>error.code===75);
  const reopened=open();assert.equal(count(reopened.store,'jobs'),0);assert.equal(count(reopened.store,'admissions'),0);
  assert.equal(reopened.store.db.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'task-%'").get().n,0);
  const admitted=await reopened.service.tool({user:'123'},'create_task',task);assert.equal(reopened.store.jobs('123')[0].id,admitted.id);
});

test('changed task intent, effective settings, parent scope and actor conflict without mutation',async t=>{
  const {store,service,cfg}=await fixture(t);const original=await service.tool({user:'123'},'create_task',task);
  for(const change of [{prompt:'Changed'}, {profile:'worker'}, {title:'Changed'}, {acknowledgment:'Changed'}, {settings:{timeout:20,toolScope:'read'}}, {settings:{timeout:30,toolScope:'read',model:'synthetic-model'}}, {settings:{timeout:30,toolScope:'read',effort:'high'}}, {settings:{timeout:30,toolScope:'conversation'}}])
    await assert.rejects(service.tool({user:'123'},'create_task',{...task,...change}),/Admission conflict/);
  await assert.rejects(service.tool({user:'123',actorId:'456'},'create_task',task),/Admission conflict/);
  await assert.rejects(service.tool({user:'123',toolScope:'read'},'create_task',task),/Read-only task/);
  // Omitted/default scope is normalized without changing authority.
  assert.deepEqual(await service.tool({user:'123',toolScope:'conversation'},'create_task',task),original);
  cfg.profiles.research.effort='low';await assert.rejects(service.tool({user:'123'},'create_task',task),/Admission conflict/);
  assert.equal(count(store,'jobs'),1);assert.equal(count(store,'admissions'),1);
  assert.equal(store.db.prepare('SELECT id,actor_id FROM jobs').get().id,original.id);assert.equal(store.db.prepare('SELECT actor_id FROM jobs').get().actor_id,'123');
});

test('admission audit remains after resource cleanup and a retry does not create replacement work',async t=>{
  const {store,service}=await fixture(t),first=await service.tool({user:'123'},'create_task',task);
  store.db.prepare('DELETE FROM jobs WHERE id=?').run(first.id);
  assert.equal(count(store,'admissions'),1);assert.deepEqual(await service.tool({user:'123'},'create_task',task),first);assert.equal(count(store,'jobs'),0);
});

test('request keys are independent across conversations, owners and task/schedule intents',async t=>{
  const {store,service}=await fixture(t);const a=await service.tool({user:'123'},'create_task',task);
  const row=store.bindConversation('123',{id:'synthetic-group',kind:'group',chatId:'-100'});
  const b=await service.tool({user:'123'},'create_task',task);assert.notEqual(a.id,b.id);assert.equal(row.id,'synthetic-group');
  const other=await fixture(t,'456'),c=await other.service.tool({user:'456'},'create_task',task);assert.notEqual(c.id,a.id);
  const s=await service.tool({user:'123'},'schedule',{...schedule(),key:task.request_key});assert.notEqual(s.id,b.id);
  assert.equal(count(store,'admissions'),3);assert.equal(count(other.store,'admissions'),1);
});

test('legacy callers retain atomic writes but receive separate jobs without a request key',async t=>{
  const {service,store}=await fixture(t),{request_key,...legacy}=task;
  const a=await service.tool({user:'123'},'create_task',legacy),b=await service.tool({user:'123'},'create_task',legacy);
  assert.notEqual(a.id,b.id);assert.equal(count(store,'admissions'),0);
  for(const request_key of ['', '  ', 123, 'x'.repeat(201)])await assert.rejects(service.tool({user:'123'},'create_task',{...task,request_key}),/Invalid request key/);
  assert.equal(count(store,'jobs'),2);
});

test('schedule retry returns the original result even after firing; changed intent conflicts',async t=>{
  const {service,store,open}=await fixture(t),args=schedule(),first=await service.tool({user:'123'},'schedule',args);
  service.schedules(first.due+1);
  assert.deepEqual(await service.tool({user:'123'},'schedule',{...args,due:new Date(first.due+3600000).toISOString().replace('Z','+01:00')}),first);
  const now=Date.now;Date.now=()=>first.due+1;
  try {assert.deepEqual(await service.tool({user:'123'},'schedule',{...args,prompt:' '+args.prompt+' '}),first);}finally{Date.now=now;}
  for(const change of [{prompt:'Changed'},{kind:'task'},{due:new Date(first.due+60000).toISOString()},{timezone:'Europe/Paris'},{cron:'0 9 * * *',due:undefined}])
    await assert.rejects(service.tool({user:'123'},'schedule',{...args,...change}),/Admission conflict/);
  await assert.rejects(service.tool({user:'123',actorId:'456'},'schedule',args),/Admission conflict/);
  assert.equal(count(store,'schedules'),1);assert.equal(count(store,'admissions'),1);assert.equal(count(store,'outbox'),1);
  store.db.close();const reopened=open();assert.deepEqual(await reopened.service.tool({user:'123'},'schedule',args),first);
  const second=await reopened.service.tool({user:'123'},'schedule',{...args,prompt:'Changed',key:'new-intent'});assert.notEqual(second.id,first.id);
});

test('schedule and admission roll back together on actor write failure',async t=>{
  const {service,store}=await fixture(t),prepare=store.prepare.bind(store);
  store.prepare=sql=>{if(sql.startsWith('UPDATE schedules SET actor_id'))throw new Error('Synthetic actor write failure');return prepare(sql);};
  await assert.rejects(service.tool({user:'123'},'schedule',schedule()),/Synthetic actor/);
  assert.equal(count(store,'schedules'),0);assert.equal(count(store,'admissions'),0);
});

test('cron retries normalize whitespace and do not recompute the initial occurrence or reenable cancellation',async t=>{
  const {service,store}=await fixture(t),args={kind:'task',prompt:'Synthetic recurring task',cron:'0 9 * * *',timezone:'UTC',key:'cron-request'};
  const first=await service.tool({user:'123'},'schedule',args);await service.tool({user:'123'},'cancel_schedule',{id:first.id});
  store.db.prepare('UPDATE schedules SET due=? WHERE id=?').run(first.due+86400000,first.id);
  assert.deepEqual(await service.tool({user:'123'},'schedule',{...args,cron:' 0   9 * * * '}),first);
  assert.equal(store.db.prepare('SELECT enabled FROM schedules WHERE id=?').get(first.id).enabled,0);
  await assert.rejects(service.tool({user:'123'},'schedule',{...args,cron:'0 10 * * *'}),/Admission conflict/);
});

test('legacy schedules adopt only matching requests and startup adds admissions without losing old jobs',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-old-admission-')),file=path.join(dir,'db');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const db=new DatabaseSync(file);db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,user TEXT,prompt TEXT,profile TEXT,state TEXT,result TEXT,created INTEGER,thread TEXT); INSERT INTO jobs VALUES ('old-job','123','Old task','worker','queued',NULL,1,NULL)");db.close();
  const store=new Store(file);t.after(()=>store.db.close());
  const cfg=config({WORKSPACE_DIR:dir,CODEX_HOME:path.join(dir,'codex'),TELEGRAM_ALLOWED_USER_IDS:'123'}),service=new Service(cfg,store,{},{}),args={...schedule(),key:' legacy-key '},key=`${store.get('conversation-id')}:123:${args.key}`;
  store.schedule('old-schedule','123',args.kind,args.prompt,null,cfg.timezone,Date.parse(args.due),key);
  await assert.rejects(service.tool({user:'123'},'schedule',{...args,prompt:'Changed'}),/Admission conflict/);
  const admitted=await service.tool({user:'123'},'schedule',args);assert.equal(admitted.id,'old-schedule');assert.equal(count(store,'admissions'),1);
  assert.equal(store.jobs('123')[0].id,'old-job');assert.equal(count(store,'schedules'),1);
});
