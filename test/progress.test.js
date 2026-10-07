import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Telegram } from '../src/telegram.js';
const update=(id,text,user=123)=>({update_id:id,message:{message_id:id,date:1,text,from:{id:user},chat:{type:'private',id:user}}});
test('typing heartbeat refreshes, stops, and action failures are best effort',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const telegram=new Telegram('unused');const calls=[];telegram.call=async(method,body,timeout)=>{calls.push({method,body,timeout});};
  const stop=telegram.startTyping('123');await new Promise(r=>setImmediate(r));assert.equal(calls.length,1);
  t.mock.timers.tick(4000);await new Promise(r=>setImmediate(r));assert.equal(calls.length,2);
  stop();t.mock.timers.tick(10000);assert.equal(calls.length,2);assert.equal(calls[0].method,'sendChatAction');assert.equal(calls[0].body.action,'typing');assert.equal(calls[0].timeout,5000);
  telegram.call=async()=>{throw new Error('Private error');};assert.equal(await telegram.action('123'),false);
});
test('slow reply uses typing without an acknowledgment; queued input and control commands work while busy',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-progress-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const cfg=config({WORKSPACE_DIR:dir,TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false'});const store=new Store(path.join(dir,'db'));t.after(()=>store.db.close());
  let finish;let started=0;let stopped=0;const telegram={startTyping:()=>{started++;return ()=>{stopped++;};}};
  const agent={run:async()=>new Promise(resolve=>{finish=resolve;})};const service=new Service(cfg,store,telegram,agent);await service.init();
  t.mock.timers.enable({apis:['setTimeout']});
  service.ingest(update(1,'Long request'));const running=service.conversation();
  for(let i=0;i<500&&!finish;i++)await new Promise(r=>setImmediate(r));assert(finish);
  t.mock.timers.tick(5000);await new Promise(r=>setImmediate(r));
  assert.equal(started,1);assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  service.ingest(update(2,'Correction'));assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=2').get().state,'pending');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  const job=store.job('123','Background work');const controller=new AbortController();service.controllers.set(job,controller);
  service.ingest(update(3,'/cancel '+job,456));assert.equal(controller.signal.aborted,false);
  service.ingest(update(4,'/cancel '+job));assert.equal(controller.signal.aborted,true);assert.equal(store.jobs('123')[0].state,'cancelled');
  service.ingest(update(5,'/status'));assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=5').get().state,'done');
  service.ingest(update(6,'/stop',456));assert.equal(service.controllers.get('main').signal.aborted,false);
  service.ingest(update(7,'/stop'));assert.equal(service.controllers.get('main').signal.aborted,true);
  finish({text:'Must not send cancelled output',voice:false,files:[]});await running;
  assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=1').get().state,'cancelled');assert(stopped>=1);
  assert(!store.db.prepare('SELECT payload FROM outbox').all().some(r=>JSON.parse(r.payload).text.includes('Must not send')));
});
test('repeated intake while busy queues silently and processes each message in order',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-silent-queue-'));
  const cfg=config({WORKSPACE_DIR:dir,TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false'});
  const store=new Store(path.join(dir,'db'));t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  let finish;const prompts=[];
  const agent={run:async(user,text)=>{
    prompts.push(text);
    if(prompts.length===1)return new Promise(resolve=>{finish=resolve;});
    return {text:`Reply ${prompts.length}`,voice:false,files:[]};
  }};
  const service=new Service(cfg,store,{},agent);await service.init();
  service.ingest(update(1,'First request'));const running=service.conversation();
  for(let i=0;i<500&&!finish;i++)await new Promise(r=>setImmediate(r));assert(finish);
  for(const id of [2,3,4])assert.equal(service.ingest(update(id,`Follow-up ${id}`)),true);
  assert.equal(service.ingest(update(3,'Follow-up 3')),false);
  await service.conversation();assert.equal(prompts.length,1);
  assert.deepEqual(store.db.prepare("SELECT id FROM inputs WHERE state='pending' ORDER BY created,id").all().map(r=>r.id),[2,3,4]);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  assert.equal(service.controllers.get('main').signal.aborted,false);
  finish({text:'Reply 1',voice:false,files:[]});await running;
  for(const id of [2,3,4]) {
    await service.conversation();
    assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=?').get(id).state,'done');
  }
  assert.equal(prompts.length,4);
  for(let i=0;i<3;i++)assert.match(prompts[i+1],new RegExp(`Follow-up ${i+2}`));
  assert.deepEqual(store.db.prepare('SELECT payload FROM outbox ORDER BY id').all().map(r=>JSON.parse(r.payload).text),['Reply 1','Reply 2','Reply 3','Reply 4']);
});
for(const acknowledgment of [
  'Хорошо, ищу японские рестораны рядом с сохранённой локацией.',
  'Vale, busco restaurantes japoneses cerca de tu ubicación guardada.',
  'Okay, I’m looking for Japanese restaurants near your saved location.',
])test(`worker sends the supplied natural acknowledgment: ${acknowledgment}`,async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-task-start-'));const cfg=config({WORKSPACE_DIR:dir,TELEGRAM_ALLOWED_USER_IDS:'123',CLEANUP_ENABLED:'false'});const store=new Store(path.join(dir,'db'));
  t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  const agent={run:async()=>({text:'Done',voice:false,files:[]})};
  const service=new Service(cfg,store,{},agent);await service.init();
  const {id}=await service.tool({user:'123'},'create_task',{prompt:'Find nearby Japanese restaurants',title:'Find Japanese restaurants',acknowledgment});
  // A queued job retains its acknowledgment across service recreation.
  const restarted=new Service(cfg,store,{},agent);await restarted.init();restarted.workers();
  assert.equal(JSON.parse(store.db.prepare('SELECT payload FROM outbox').get().payload).text,acknowledgment);
  assert.match(restarted.statusText('123'),new RegExp(id));
  assert.match(restarted.statusText('123'),/Find Japanese restaurants/);
  restarted.workers();assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,1);
  for(let i=0;i<50&&restarted.controllers.has(id);i++)await new Promise(r=>setTimeout(r,10));assert.equal(store.jobs('123')[0].state,'completed');
});
test('legacy tasks start quietly and invalid acknowledgments create no job',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-task-legacy-'));const cfg=config({WORKSPACE_DIR:dir,TELEGRAM_ALLOWED_USER_IDS:'123',CLEANUP_ENABLED:'false'});const store=new Store(path.join(dir,'db'));
  t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  const service=new Service(cfg,store,{}, {run:async()=>({text:'Done',voice:false,files:[]})});await service.init();
  for(const acknowledgment of ['', '   ', 123, 'x'.repeat(241)])await assert.rejects(service.tool({user:'123'},'create_task',{prompt:'Synthetic task',acknowledgment}),/Invalid create_task arguments/);
  assert.equal(store.jobs('123').length,0);
  const {id}=await service.tool({user:'123'},'create_task',{prompt:'Synthetic task',title:'Legacy task'});service.workers();
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  for(let i=0;i<50&&service.controllers.has(id);i++)await new Promise(r=>setTimeout(r,10));assert.equal(store.jobs('123')[0].state,'completed');
});
