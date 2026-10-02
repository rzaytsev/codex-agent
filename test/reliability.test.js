import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { TelegramError } from '../src/telegram.js';

const update=(id,text)=>({update_id:id,message:{message_id:id,from:{id:123},chat:{id:123,type:'private'},text}});
async function fixture(t,env={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-reliability-'));
  const cfg=config({WORKSPACE_DIR:dir,CODEX_HOME:path.join(dir,'codex'),TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',BROWSER_ENABLED:'false',...env});
  const store=new Store(path.join(dir,'db')),sent=[];
  const service=new Service(cfg,store,{sendPart:async(user,payload)=>sent.push({user,payload})},{run:async()=>({text:'Completed reply',voice:false,files:[]})});
  await service.init();
  t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,cfg,store,service,sent};
}
async function until(predicate) {
  for(let i=0;i<500;i++) {if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail('Fixture did not reach the expected state');
}

test('a full quiet-hours backlog does not block direct replies',async t=>{
  const {cfg,store,service,sent}=await fixture(t);
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:cfg.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));
  cfg.quietStart=hour;cfg.quietEnd=(hour+1)%24;
  for(let i=0;i<20;i++)store.enqueue('123',{text:'proactive '+i},true);
  store.enqueue('123',{text:'requested reply'});
  await service.deliver();
  assert.deepEqual(sent.map(row=>row.payload.text),['requested reply']);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE proactive=1 AND state='pending'").get().n,20);
});

test('long immediate status responses preserve all task IDs in bounded chunks',async t=>{
  const {store,service}=await fixture(t);const ids=[];
  for(let i=0;i<30;i++) {
    const {id}=await service.tool({user:'123'},'create_task',{prompt:'Synthetic work',title:'😀'.repeat(70)});ids.push(id);
  }
  service.ingest(update(1,'/status'));
  const text=store.db.prepare('SELECT payload FROM outbox ORDER BY id').all().map(row=>JSON.parse(row.payload).text);
  assert(text.length>1);assert(text.every(part=>Array.from(part).length<=1500));
  for(const id of ids)assert(text.join('').includes(id));
  assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=1').get().state,'done');
});

test('reflection configuration reconciles on restart and preserves explicit cancellation when unchanged',async t=>{
  const {cfg,store,service}=await fixture(t,{PROACTIVE_ENABLED:'true'});
  service.ingest(update(1,'hello'));
  const rows=()=>store.db.prepare("SELECT * FROM schedules WHERE kind='review' ORDER BY prompt").all();
  const initial=rows();assert.equal(initial.length,3);
  await service.tool({user:'123'},'cancel_schedule',{id:initial[0].id});
  await service.init();assert.equal(rows()[0].enabled,0);
  cfg.reviews.daily='15 16 * * *';cfg.timezone='Europe/Paris';
  await service.init();
  assert.deepEqual(rows().map(row=>row.id),initial.map(row=>row.id));
  assert(rows().every(row=>row.timezone==='Europe/Paris'&&row.due>Date.now()));
  assert.equal(rows().find(row=>row.prompt==='daily').cron,'15 16 * * *');
  cfg.proactive=false;await service.init();assert(rows().every(row=>row.enabled===0));
  service.schedules(Date.now()+365*86400000);assert.equal(store.jobs('123').length,0);
  cfg.proactive=true;await service.init();assert(rows().every(row=>row.enabled===1&&row.due>Date.now()));
  await service.init();assert.equal(rows().length,3);
});

test('all configured crons fail at startup instead of poisoning intake',()=>{
  for(const key of ['DAILY_REVIEW_CRON','WEEKLY_REVIEW_CRON','MONTHLY_REVIEW_CRON','CLEANUP_CRON','MEMORY_DAILY_CRON','MEMORY_WEEKLY_CRON'])
    for(const value of ['not a cron','0 0 0 * * *','99 0 * * *'])assert.throws(()=>config({[key]:value}),new RegExp('Invalid '+key));
});

test('disabling proactivity prevents previously queued reflection jobs from starting',async t=>{
  const {cfg,store,service}=await fixture(t,{PROACTIVE_ENABLED:'true'});service.ingest(update(1,'hello'));
  store.db.prepare("UPDATE schedules SET due=0 WHERE kind='review'").run();service.schedules();
  assert.equal(store.jobs('123').length,3);
  cfg.proactive=false;await service.init();let calls=0;service.agent.run=async()=>{calls++;throw new Error('Should not start');};
  service.workers();assert.equal(calls,0);assert(store.jobs('123').every(job=>job.state==='cancelled'));
});

test('ineligible maintenance does not consume ordinary worker capacity',async t=>{
  const {store,service}=await fixture(t,{MAX_WORKERS:'1'});
  const maintenance=store.job('123',service.cleanupPrompt);
  const ordinary=store.job('123','Requested work');service.mainBusy=true;
  service.workers();
  assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(maintenance).state,'queued');
  assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(ordinary).state,'running');
  await until(()=>!service.controllers.has(ordinary));
  assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(ordinary).state,'completed');
});

test('/stop during output preparation commits no late response and frees the next turn',async t=>{
  const {store,service}=await fixture(t);
  let release;const original=service.filePayloads.bind(service);
  service.filePayloads=()=>new Promise(resolve=>{release=()=>resolve([]);});
  service.ingest(update(1,'request'));const running=service.conversation();
  await until(()=>release);service.ingest(update(2,'/stop'));release();await running;
  assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=1').get().state,'cancelled');
  assert.equal(store.search('123').filter(row=>row.role==='assistant').length,0);
  assert(!store.db.prepare('SELECT payload FROM outbox').all().some(row=>JSON.parse(row.payload).text==='Completed reply'));
  service.filePayloads=original;service.ingest(update(3,'next'));await service.conversation();
  assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=3').get().state,'done');
});

test('prepared response and history commit together on queue failure',async t=>{
  const {store,service}=await fixture(t);const enqueue=store.enqueue.bind(store);let count=0;
  store.enqueue=(...args)=>{if(++count===2)throw new Error('Synthetic storage failure');return enqueue(...args);};
  await assert.rejects(service.output('123',{text:'x'.repeat(2000),files:[]}),/Synthetic storage failure/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  assert.equal(store.search('123').length,0);
});

test('capability release and owner cancellation revoke pending service authority',async t=>{
  const {service}=await fixture(t);const controller=new AbortController();
  const token=service.capability('123',false,false,controller.signal),cap=service.capabilities.get(token);
  await service.tool(cap,'task_status');controller.abort();
  await assert.rejects(service.tool(cap,'task_status'),{name:'AbortError'});
  const second=service.capability('123',false),pending=service.capabilities.get(second);
  service.releaseCapability(second);assert.equal(service.capabilities.has(second),false);
  await assert.rejects(service.tool(pending,'task_status'),{name:'AbortError'});
  service.releaseCapability(token);
});

test('an unreadable delivery response remains uncertain and is not retried',async t=>{
  const {store,service}=await fixture(t);let calls=0;
  service.telegram.sendPart=async()=>{calls++;throw new TelegramError('invalid-response');};
  store.enqueue('123',{text:'possibly delivered'});await service.deliver();await service.deliver();
  assert.equal(store.db.prepare('SELECT state FROM outbox').get().state,'uncertain');assert.equal(calls,1);
});

test('/stop aborts final voice generation and revoked capabilities cannot queue late voice tools',async t=>{
  const {dir,store,service}=await fixture(t);const originalPath=process.env.PATH;
  t.after(()=>{process.env.PATH=originalPath;});
  const bin=path.join(dir,'bin'),marker=path.join(dir,'speech-started');await fs.mkdir(bin);
  await fs.writeFile(path.join(bin,'espeak-ng'),`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.writeFileSync(a[a.indexOf('-w')+1],'partial wave');fs.writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);`,{mode:0o700});
  process.env.PATH=bin+path.delimiter+originalPath;
  service.agent.run=async()=>({text:'Cancelled speech',voice:true,files:[]});
  service.ingest(update(1,'speak'));const turn=service.conversation();
  await until(()=>fs.access(marker).then(()=>true,()=>false));service.ingest(update(2,'/stop'));await turn;
  assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=1').get().state,'cancelled');
  assert(!store.db.prepare('SELECT payload FROM outbox').all().some(row=>JSON.parse(row.payload).type==='voice'));
  assert.equal(store.search('123').filter(row=>row.role==='assistant').length,0);
  await fs.unlink(marker);
  const token=service.capability('123',false),cap=service.capabilities.get(token);
  const pending=assert.rejects(service.tool(cap,'send_voice',{text:'late speech'}),{name:'AbortError'});
  await until(()=>fs.access(marker).then(()=>true,()=>false));service.releaseCapability(token);await pending;
  assert.deepEqual(await fs.readdir(path.join(dir,'outputs')),[]);
  assert(!store.db.prepare('SELECT payload FROM outbox').all().some(row=>JSON.parse(row.payload).type==='voice'));
});
