import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Auth } from '../src/auth.js';
import { AccountClient, readAccount } from '../src/codex-account.js';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';

const accountA={email:'alice@example.test',plan:'plus'},accountB={email:'bob@example.test',plan:'pro'};
const challenge={type:'chatgptDeviceCode',loginId:'login-one',verificationUrl:'https://auth.openai.com/codex/device',userCode:'TEST-1234'};
const update=(id,text,extra={})=>({update_id:id,message:{message_id:id,from:{id:123},chat:{id:123,type:'private'},text,...extra}});
async function until(predicate) {for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}assert.fail('Condition did not become true');}
class FakeClient extends EventEmitter {
  constructor(){super();this.requests=[];this.closed=new Promise(resolve=>{this.resolveClose=resolve;});}
  async initialize(){}
  async request(method,params){this.requests.push({method,params});if(method==='account/login/start')return challenge;return {};}
  complete(success=true,id=challenge.loginId){this.emit('notification',{method:'account/login/completed',params:{loginId:id,success,error:success?null:'private-server-error'}});}
  async close(){this.resolveClose();this.didClose=true;}
}
async function fixture(t,options={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auth-test-'));
  const cfg=config({WORKSPACE_DIR:dir,CODEX_HOME:path.join(dir,'codex'),TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',BROWSER_ENABLED:'false'});
  await fs.mkdir(cfg.codexHome);
  const store=new Store(path.join(dir,'db'));const sent=[];let modelCalls=0;
  const service=new Service(cfg,store,{sendPart:async(user,payload)=>sent.push({user,payload})},{run:async()=>{modelCalls++;return {text:'answer',files:[]};}});
  await service.init();
  const state={account:options.account??null};const clients=[];
  const auth=new Auth(cfg,store,{busy:()=>service.mainBusy||service.controllers.size>0,reader:async()=>state.account,clientFactory:()=>{const client=new FakeClient();clients.push(client);return client;},...options});
  service.auth=auth;await auth.init();
  t.after(async()=>{await auth.close();store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,cfg,store,service,auth,state,clients,sent,calls:()=>modelCalls};
}
test('plugin preparation gates model work, runs after login and does not repeat on routine checks',async t=>{
  let calls=0,release;
  const f=await fixture(t,{prepare:()=>{calls++;return new Promise(resolve=>{release=resolve;});}});
  assert.equal(calls,0);
  f.service.ingest(update(1,'hello'));f.state.account=accountA;
  const checking=f.auth.check();await until(()=>Boolean(release));
  assert.equal(f.auth.health,'setup:plugins');assert(!f.auth.ready);
  await f.service.conversation();assert.equal(f.calls(),0);
  release();await checking;assert(f.auth.ready);
  await f.auth.check();assert.equal(calls,1);
  f.auth.command('/auth');f.auth.tick();await until(()=>f.auth.phase==='waiting');
  release=undefined;f.state.account=accountB;f.clients[0].complete();await until(()=>Boolean(release));
  assert(!f.auth.ready);assert.equal(calls,2);
  release();await f.auth.task;assert(f.auth.ready);
});
test('plugin preparation failures do not prevent login readiness and shutdown aborts preparation',async t=>{
  const f=await fixture(t,{account:accountA,prepare:async()=>{throw new Error('private');}});
  assert(f.auth.ready);
  f.auth.prepared=false;let aborted=false,started=false;
  f.auth.prepare=signal=>new Promise(resolve=>{started=true;signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});});
  const checking=f.auth.check();await until(()=>started);
  await f.auth.close();await checking;assert(aborted);assert(!f.auth.ready);
});
test('missing auth prompts once, gates model calls and starts login from /start',async t=>{
  const f=await fixture(t);f.service.ingest(update(1,'hello'));f.service.ingest(update(2,'hello again'));
  await f.auth.check();await f.service.conversation();
  assert.equal(f.calls(),0);assert.equal(f.store.search('123').length,0);
  const rows=f.store.db.prepare('SELECT payload FROM outbox').all();
  assert.equal(rows.filter(r=>JSON.parse(r.payload).text?.startsWith('Please sign in')).length,1);
  f.service.ingest(update(3,'/start'));f.auth.tick();await until(()=>f.auth.phase==='waiting');
  await f.service.deliver();assert(f.sent.some(m=>m.payload.text.includes(challenge.userCode)));
  assert(!JSON.stringify(f.store.db.prepare('SELECT * FROM outbox').all()).includes(challenge.userCode));
  assert(!JSON.stringify(f.store.search('123')).includes(challenge.userCode));
  f.state.account=accountA;f.clients[0].complete();await f.auth.task;
  assert(f.auth.ready);await f.service.conversation();assert.equal(f.calls(),1);
  assert.equal(f.store.db.prepare('SELECT state FROM inputs WHERE id=3').get().state,'done');
});
test('existing login survives startup; successful switch drains all active work and preserves durable data',async t=>{
  const f=await fixture(t,{account:accountA});f.store.set('thread:123','old-thread');f.store.history('123','user','remember this');
  await fs.writeFile(path.join(f.dir,'keep.txt'),'keep');
  const job=f.store.job('123','pending task','worker');
  const main=new AbortController(),worker=new AbortController();f.service.mainBusy=true;f.service.controllers.set('main',main);f.service.controllers.set('worker',worker);
  f.service.ingest(update(1,'/auth'));assert(!f.auth.ready);f.auth.tick();f.service.workers();
  assert.equal(f.clients.length,0);assert.equal(f.store.jobs('123')[0].state,'queued');assert(!main.signal.aborted);assert(!worker.signal.aborted);
  f.service.mainBusy=false;f.service.controllers.delete('main');f.auth.tick();assert.equal(f.clients.length,0);
  f.service.controllers.clear();f.auth.tick();await until(()=>f.auth.phase==='waiting');
  assert.equal(f.store.get('thread:123'),'old-thread');
  f.state.account=accountB;f.clients[0].complete();await f.auth.task;
  assert(f.auth.ready);assert.equal(f.store.get('thread:123'),'');assert.equal(f.store.get('auth:attempt'),'');
  assert.equal(f.store.search('123')[0].text,'remember this');assert.equal(await fs.readFile(path.join(f.dir,'keep.txt'),'utf8'),'keep');assert.equal(f.store.jobs('123')[0].id,job);
  assert.match(f.auth.accountText(),/b\*\*\*@example.test/);assert(!f.clients[0].requests.some(r=>r.method==='account/logout'));
});
test('only owner direct commands authorize login; duplicates and repeated commands share one attempt',async t=>{
  const f=await fixture(t,{account:accountA});
  assert.equal(f.service.ingest(update(1,'/auth',{from:{id:999},chat:{id:999,type:'private'}})),false);
  f.service.ingest(update(2,'/auth',{forward_origin:{type:'user'}}));f.auth.tick();assert.equal(f.clients.length,0);
  f.service.ingest(update(3,'/auth'));assert.equal(f.service.ingest(update(3,'/auth')),false);
  f.auth.tick();await until(()=>f.auth.phase==='waiting');f.service.ingest(update(4,'/auth'));f.auth.tick();
  assert.equal(f.clients.length,1);assert.equal(f.store.db.prepare("SELECT count(*) n FROM outbox WHERE json_extract(payload,'$.type')='auth'").get().n,1);
  f.clients[0].complete(true,'wrong-attempt');await new Promise(r=>setImmediate(r));assert.equal(f.auth.phase,'waiting');
  await f.auth.cancel('cancelled');await f.auth.task;assert(f.auth.ready);assert.equal(f.auth.account.email,accountA.email);
});
test('cancel, expiry and failed login preserve saved auth and invalidate queued codes',async t=>{
  for(const kind of ['cancel','expire','failure']) {
    const f=await fixture(t,{account:accountA,timeoutMs:kind==='expire'?30:60000});
    f.auth.command('/auth');f.auth.tick();await until(()=>f.auth.phase==='waiting');
    const id=f.auth.session.id;
    if(kind==='cancel')await f.auth.cancel('cancelled');
    if(kind==='failure')f.clients[0].complete(false);
    await f.auth.task;assert(f.auth.ready);assert.equal(f.auth.account.email,accountA.email);assert.equal(f.auth.payload(id),null);
    await f.service.deliver();assert(!f.sent.some(m=>m.payload.text.includes(challenge.userCode)));
    assert(!JSON.stringify(f.sent).includes('private-server-error'));assert(f.clients[0].didClose);
  }
});
test('restart reconciles an interrupted login and never replays a device code',async t=>{
  const f=await fixture(t,{account:accountA});f.store.set('thread:123','old');f.auth.command('/auth');f.auth.tick();await until(()=>f.auth.phase==='waiting');
  await f.auth.close();assert(f.store.get('auth:attempt'));
  const auth=new Auth(f.cfg,f.store,{reader:async()=>accountB});f.service.auth=auth;t.after(()=>auth.close());await auth.init();
  assert(auth.ready);assert.equal(f.store.get('thread:123'),'');assert.equal(f.store.get('auth:attempt'),'');
  await f.service.deliver();assert(!f.sent.some(m=>m.payload.text.includes(challenge.userCode)));
});
test('unknown account checks fail closed without declaring logout or starting workers',async t=>{
  let fail=false;const f=await fixture(t,{reader:async()=>{if(fail)throw new Error('secret');return accountA;}});
  fail=true;await f.auth.check();assert.equal(f.auth.status,'unavailable');assert(!f.auth.ready);
  f.store.job('123','queued','worker');f.service.workers();assert.equal(f.store.jobs('123')[0].state,'queued');
  f.service.ingest(update(1,'/start'));f.auth.tick();assert.equal(f.clients.length,0);assert.equal(f.auth.phase,'idle');
  assert(!JSON.stringify(f.store.db.prepare('SELECT payload FROM outbox').all()).includes('secret'));
});
test('early completion is correlated, invalid URLs fail closed, and starting login can be cancelled',async t=>{
  for(const kind of ['early','url','cancel']) {
    const f=await fixture(t,{account:accountA});const client=new FakeClient();f.auth.clientFactory=()=>client;
    if(kind==='early')client.request=async()=>{client.complete();return challenge;};
    if(kind==='url')client.request=async()=>({...challenge,verificationUrl:'https://example.test/phish'});
    if(kind==='cancel')client.request=()=>client.closed.then(()=>{throw new Error('closed');});
    f.auth.command('/auth');f.auth.tick();
    if(kind==='cancel')await f.auth.cancel('cancelled');
    await f.auth.task;assert(f.auth.ready);assert(client.didClose);
    if(kind!=='early')assert(!JSON.stringify(f.store.db.prepare('SELECT payload FROM outbox').all()).includes('phish'));
  }
});
test('reminders and control commands stay available during login, usage does not touch auth',async t=>{
  const f=await fixture(t,{account:accountA});f.service.usageReader=()=>{throw new Error('must not call');};
  f.auth.command('/auth');f.auth.tick();await until(()=>f.auth.phase==='waiting');
  f.service.ingest(update(1,'ordinary work'));f.service.ingest(update(2,'/usage'));f.service.ingest(update(3,'/help'));f.service.ingest(update(4,'/status'));
  f.store.db.prepare('INSERT INTO schedules(id,user,kind,prompt,timezone,due) VALUES (?,?,?,?,?,?)').run('r','123','reminder','remember now','UTC',1);
  f.service.schedules();await f.service.conversation();await f.service.deliver();
  assert.equal(f.calls(),0);assert.equal(f.store.db.prepare('SELECT state FROM inputs WHERE id=1').get().state,'pending');
  assert(f.sent.some(m=>m.payload.text==='remember now'));assert(f.sent.some(m=>m.payload.text.includes('Try /usage after')));
});
test('instances have separate attempts and account state',async t=>{
  const a=await fixture(t,{account:accountA}),b=await fixture(t,{account:accountB});
  a.auth.command('/auth');a.auth.tick();await until(()=>a.auth.phase==='waiting');
  assert.equal(b.auth.phase,'idle');assert(b.auth.ready);assert.equal(b.auth.payload(a.auth.session.id),null);assert.equal(b.store.get('auth:attempt'),undefined);
});
test('cancel racing with a saved replacement reports reread account and never resumes the old thread',async t=>{
  const f=await fixture(t,{account:accountA});f.store.set('thread:123','old');
  f.auth.command('/auth');f.auth.tick();await until(()=>f.auth.phase==='waiting');
  f.state.account=accountB;await f.auth.cancel('cancelled');await f.auth.task;
  assert(f.auth.ready);assert.equal(f.auth.account.email,accountB.email);assert.equal(f.store.get('thread:123'),'');
  assert(f.store.db.prepare('SELECT payload FROM outbox').all().some(row=>JSON.parse(row.payload).text?.includes('b***@example.test')));
});
test('completion keeps model work blocked until saved auth is rechecked',async t=>{
  const f=await fixture(t,{account:accountA});let resolve;
  f.auth.command('/auth');f.auth.tick();await until(()=>f.auth.phase==='waiting');
  f.auth.reader=()=>new Promise(r=>{resolve=r;});f.clients[0].complete();await until(()=>Boolean(resolve));
  assert(!f.auth.ready);f.store.job('123','queued','worker');f.service.workers();assert.equal(f.store.jobs('123')[0].state,'queued');
  resolve(accountB);await f.auth.task;assert(f.auth.ready);
});
test('a synchronous account-reader failure can recover on the next check',async t=>{
  const f=await fixture(t,{account:accountA});f.auth.reader=()=>{throw new Error('private');};await f.auth.check();
  assert.equal(f.auth.status,'unavailable');f.auth.reader=()=>accountA;await f.auth.check();assert(f.auth.ready);
});
test('real subprocess account reader uses structured data, isolated environment and safe errors',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'auth-rpc-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const binary=path.join(dir,'rpc');
  await fs.writeFile(binary,`#!/usr/bin/env node
if(process.env.TELEGRAM_BOT_TOKEN||process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY)process.exit(9);
if(!process.argv.includes('cli_auth_credentials_store="file"'))process.exit(8);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='account/read')console.log(JSON.stringify({id:m.id,result:{account:{type:'chatgpt',email:'synthetic@example.test',planType:'plus',token:'must-not-leak'}}}));
});`,{mode:0o700});
  const result=await readAccount({codexHome:dir},{binary});assert.deepEqual(result,{email:'synthetic@example.test',plan:'plus'});
  await fs.writeFile(binary,`#!/usr/bin/env node\nsetInterval(()=>{},1000);`,{mode:0o700});
  const client=new AccountClient({codexHome:dir},{binary,timeoutMs:25});await assert.rejects(client.initialize(),/timed out/);await client.close();assert(client.ended);
  const missing=new AccountClient({codexHome:dir},{binary:path.join(dir,'absent')});await assert.rejects(missing.initialize(),/closed/);await missing.close();
});
