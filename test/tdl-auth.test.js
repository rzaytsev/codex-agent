import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TdlAuth } from '../src/tdl-auth.js';
import { Service } from '../src/service.js';
import { Store } from '../src/store.js';
import { Telegram } from '../src/telegram.js';
import { config } from '../src/config.js';

class Child extends EventEmitter {
  constructor(){super();this.stdout=new PassThrough();this.stdin=new PassThrough();this.writes=[];this.stdin.on('data',data=>this.writes.push(data.toString()));}
  event(event){this.stdout.write(JSON.stringify(event)+'\n');}
  finish(code=0){this.stdout.end();this.emit('close',code);}
  kill(){queueMicrotask(()=>this.finish(1));}
}
const update=(id,text,extra={})=>({update_id:id,message:{message_id:id,from:{id:123},chat:{id:123,type:'private'},text,...extra}});
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tdl-auth-'));
  const cfg=config({WORKSPACE_DIR:dir,TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',MEMORY_ENABLED:'false',CLEANUP_ENABLED:'false'});
  const store=new Store(path.join(dir,'db')),sent=[],children=[];let calls=0;
  const service=new Service(cfg,store,{sendPart:async(user,payload)=>sent.push({user,payload})},{run:async()=>{calls++;return {text:'answer',files:[]};}});
  await service.init();
  const auth=new TdlAuth(cfg,store,{cleanup:async()=>{},busy:()=>service.mainBusy,start:()=>{const child=new Child();children.push(child);return child;}});
  service.tdlAuth=auth;await auth.init();
  t.after(async()=>{await auth.close();store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,store,service,auth,sent,children,calls:()=>calls};
}
function qr(f,version){return {type:'qr',version,path:path.join(f.auth.home,'qr-login-test',`qr-${version}.png`)};}
test('owner-only direct commands, invalid argument redaction, drain, and model gating',async t=>{
  const f=await fixture(t);
  assert.equal(f.service.ingest({...update(1,'/tdl_auth'),message:{...update(1,'/tdl_auth').message,from:{id:456}}}),false);
  f.service.ingest(update(2,'/tdl_auth',{forward_origin:{type:'user'}}));assert(!f.auth.active);
  f.service.ingest(update(3,'/tdl_auth synthetic-secret'));
  assert(!f.store.db.prepare('SELECT payload FROM inputs').all().some(r=>r.payload.includes('synthetic-secret')));
  f.service.mainBusy=true;f.service.ingest(update(4,'/tdl_auth'));f.auth.tick();assert.equal(f.children.length,0);
  f.service.mainBusy=false;f.service.ingest(update(5,'read chat'));await f.service.conversation();assert.equal(f.calls(),0);
  f.auth.tick();assert.equal(f.children.length,1);
  f.children[0].event({type:'password_required'});f.children[0].finish(1);await f.auth.task;
  assert(!f.auth.active);await f.service.conversation();assert.equal(f.calls(),1);
  assert(f.store.db.prepare('SELECT payload FROM outbox').all().some(r=>r.payload.includes('Docker host')));
});
test('only latest private QR resolves at delivery; stale and cancelled challenges expire',async t=>{
  const f=await fixture(t);f.auth.command('/tdl_auth');f.auth.tick();const child=f.children[0];
  child.event(qr(f,1));child.event(qr(f,2));child.event({type:'qr',path:'/tmp/outside.png',version:3});
  await f.service.deliver();assert.equal(f.sent.filter(r=>r.payload.type==='photo').length,1);
  assert.equal(f.sent.find(r=>r.payload.type==='photo').payload.path,qr(f,2).path);
  assert(!f.store.db.prepare('SELECT payload FROM outbox').all().some(r=>r.payload.includes('qr-login-test')));
  f.auth.session.qr.created=Date.now()-31000;assert.equal(f.auth.payload(f.auth.session.id,2),null);
  f.auth.command('/tdl_auth');await f.auth.cancel();await f.service.deliver();
  assert.equal(f.sent.filter(r=>r.payload.type==='photo').length,1);
  assert(!f.auth.active);
});
test('commit only after helper verification and before cancellation; saved and mismatch outcomes',async t=>{
  const f=await fixture(t);f.auth.command('/tdl_auth');f.auth.tick();let child=f.children[0];
  child.event(qr(f,1));assert.deepEqual(child.writes,[]);
  child.event({type:'verified'});assert.deepEqual(child.writes,['commit\n']);
  child.event({type:'saved'});child.finish();await f.auth.task;assert(!f.auth.active);
  f.auth.command('/tdl_auth');f.auth.tick();child=f.children[1];child.event({type:'owner_mismatch'});child.finish(1);await f.auth.task;
  const messages=f.store.db.prepare('SELECT payload FROM outbox').all().map(r=>r.payload).join('\n');
  assert.match(messages,/saved and verified/);assert.match(messages,/does not match/);
});
test('restart invalidates old attempt references; cancellation while draining needs no subprocess',async t=>{
  const f=await fixture(t);f.store.set('tdl-auth:attempt','old');f.store.enqueue('123',{type:'tdl-auth',attempt:'old',version:1});
  await f.auth.init();assert.equal(f.store.get('tdl-auth:attempt'),'');
  assert.equal(f.store.db.prepare("SELECT state FROM outbox WHERE json_extract(payload,'$.type')='tdl-auth'").get().state,'expired');
  f.auth.command('/tdl_auth');await f.auth.cancel();assert(!f.auth.active);assert.equal(f.children.length,0);
});

test('QR upload retains scan instructions if Telegram falls back to a document',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'qr.png');await fs.writeFile(file,'synthetic image');
  const telegram=new Telegram('unused'),calls=[];
  telegram.call=async(method,data)=>{calls.push({method,data});if(method==='sendPhoto'){const error=new Error('synthetic');error.code=400;throw error;}return true;};
  await telegram.sendPart('123',{type:'photo',path:file,caption:'Scan the latest QR'});
  assert.deepEqual(calls.map(c=>c.method),['sendPhoto','sendDocument']);
  for(const call of calls){assert.equal(call.data.get('chat_id'),'123');assert.equal(call.data.get('caption'),'Scan the latest QR');}
});
