import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Agent } from '../src/agent.js';

async function fixture(t) {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-latency-'));
  const cfg=config({WORKSPACE_DIR:workspace,TELEGRAM_ALLOWED_USER_IDS:'123',BROWSER_ENABLED:'false',CLEANUP_ENABLED:'false',PROACTIVE_ENABLED:'false',LEARNING_ENABLED:'false'});
  const store=new Store(path.join(workspace,'state.sqlite')),sent=[];
  const service=new Service(cfg,store,{sendPart:async(user,payload)=>sent.push({user,payload})},null);await service.init();
  t.after(async()=>{store.db.close();await fs.rm(workspace,{recursive:true,force:true});});
  return {cfg,store,service,sent};
}

test('finished worker text is delivered once while main is busy, with no extra model turn',async t=>{
  const {store,service,sent}=await fixture(t);let calls=0;
  service.agent={run:async()=>{calls++;return {text:'Synthetic result: 323.',files:[],voice:false};}};
  const id=store.job('123','Compute the synthetic result');service.mainBusy=true;
  store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
  await service.runJob(store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id),new AbortController());
  assert.equal(store.jobs('123')[0].state,'completed');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM inputs').get().n,0);
  await service.deliver();await service.deliver();
  assert.deepEqual(sent,[{user:'123',payload:{text:'Synthetic result: 323.'}}]);
  service.mainBusy=false;await service.conversation();assert.equal(calls,1);
  assert.equal(store.search('123').at(-1).text,'Synthetic result: 323.');
  await service.init();await service.deliver();assert.equal(sent.length,1);
});

test('resumed turns receive only unseen history; concurrent worker results and new threads retain context',async t=>{
  const {cfg,store,service}=await fixture(t);const inputs=[];let failure=false,duringTurn=false,sequence=0;
  const makeThread=id=>({runStreamed:async input=>{
    inputs.push(input[0].text);
    return {events:async function*(){
      yield {type:'thread.started',thread_id:id};
      if(duringTurn){store.history('123','assistant','Concurrent worker result');duringTurn=false;}
      if(failure){yield {type:'turn.failed',error:{message:'Synthetic failure'}};return;}
      yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'Synthetic reply',voice:false,files:[]})}};
      yield {type:'turn.completed'};
    }()};
  }});
  const cap=(...args)=>service.capability(...args);cap.release=token=>service.releaseCapability(token);
  const agent=new Agent(cfg,store,cap,()=>({startThread:()=>makeThread(`synthetic-${++sequence}`),resumeThread:id=>makeThread(id)}),{context:()=>[]});
  store.history('123','user','Initial synthetic context');
  await agent.run('123','First request');assert.match(inputs.at(-1),/Initial synthetic context/);
  store.history('123','assistant','Completed worker result');duringTurn=true;
  await agent.run('123','Next request');assert.doesNotMatch(inputs.at(-1),/Initial synthetic context/);assert.match(inputs.at(-1),/Completed worker result/);
  await agent.run('123','Another request');assert.doesNotMatch(inputs.at(-1),/Completed worker result/);assert.match(inputs.at(-1),/Concurrent worker result/);
  store.history('123','user','Context before failure');failure=true;
  await assert.rejects(agent.run('123','Will fail'),/Codex turn failed/);failure=false;
  await agent.run('123','Retry explicitly requested');assert.match(inputs.at(-1),/Context before failure/);
  store.rotateSession('123');await agent.run('123','New thread');assert.match(inputs.at(-1),/Initial synthetic context/);assert.match(inputs.at(-1),/Completed worker result/);
});

test('cancelled worker does not publish a direct answer',async t=>{
  const {store,service}=await fixture(t),controller=new AbortController();
  service.agent={run:async()=>{controller.abort();return {text:'Must not send',files:[],voice:false};}};
  const id=store.job('123','Cancelled task');store.db.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(id);
  await service.runJob(store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id),controller);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  assert.equal(store.search('123').length,0);
});

test('direct worker voice honors success, text fallback, and cancellation during speech generation',async t=>{
  const {cfg,store,service}=await fixture(t),originalPath=process.env.PATH;
  t.after(()=>{process.env.PATH=originalPath;});
  const bin=path.join(cfg.workspace,'bin'),marker=path.join(cfg.workspace,'speech-started');await fs.mkdir(bin);
  const speech=path.join(bin,'espeak-ng');
  await fs.writeFile(speech,`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv;fs.writeFileSync(a[a.indexOf('-w')+1],'WAV');`,{mode:0o700});
  await fs.writeFile(path.join(bin,'ffmpeg'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv.at(-1),'OggS synthetic');`,{mode:0o700});
  process.env.PATH=bin+path.delimiter+originalPath;
  service.agent={run:async()=>({text:'Synthetic speech',files:[],voice:true})};
  const run=controller=>{
    const id=store.job('123','Read the result aloud');store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
    return {id,pending:service.runJob(store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id),controller)};
  };
  await run(new AbortController()).pending;
  let rows=store.db.prepare('SELECT * FROM outbox ORDER BY id').all();assert.equal(rows.length,2);
  const payload=JSON.parse(rows[0].payload);assert.equal(payload.type,'voice');assert.equal(await fs.readFile(payload.path,'utf8'),'OggS synthetic');
  assert.equal(JSON.parse(rows[1].payload).text,'Synthetic speech');
  await fs.writeFile(speech,`#!${process.execPath}\nprocess.exit(1);`,{mode:0o700});
  await run(new AbortController()).pending;
  rows=store.db.prepare('SELECT * FROM outbox ORDER BY id').all();assert.equal(rows.length,3);assert.match(JSON.parse(rows[2].payload).text,/Voice generation failed; sending text instead/);
  await fs.writeFile(speech,`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);`,{mode:0o700});
  const controller=new AbortController(),cancelled=run(controller);
  const deadline=Date.now()+5000;while(!await fs.access(marker).then(()=>true,()=>false)){assert(Date.now()<deadline,'Speech did not start');await new Promise(r=>setTimeout(r,10));}
  store.db.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").run(cancelled.id);controller.abort();await cancelled.pending;
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,3);
  assert.equal(store.search('123').filter(row=>row.role==='assistant').length,2);
});

test('delivery wakes after commit, ignores rollback, and drains arrivals during an active send',async t=>{
  const {store,service,sent}=await fixture(t);let release;
  service.telegram.sendPart=async(user,payload)=>{sent.push({user,payload});if(payload.text==='First')await new Promise(r=>{release=r;});};
  service.startDelivery();
  assert.throws(()=>store.transaction(()=>{store.enqueue('123',{text:'Rolled back'});throw new Error('Rollback');}),/Rollback/);
  await new Promise(r=>setImmediate(r));assert.equal(sent.length,0);
  store.transaction(()=>{store.enqueue('123',{text:'First'});assert.equal(sent.length,0);});
  await new Promise(r=>setImmediate(r));assert.equal(sent.length,1);
  store.enqueue('123',{text:'Second'});await new Promise(r=>setImmediate(r));assert.equal(sent.length,1);
  release();await new Promise(r=>setImmediate(r));
  assert.deepEqual(sent.map(x=>x.payload.text),['First','Second']);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM outbox WHERE state='sent'").get().n,2);
  service.stopping=true;store.enqueue('123',{text:'Retained for restart'});await new Promise(r=>setImmediate(r));assert.equal(sent.length,2);
});

test('text delivery skips typing and media delivery does not wait for a stalled indicator',async t=>{
  const {store,service,sent}=await fixture(t);let actions=0,finish;
  service.telegram.action=()=>{actions++;return new Promise(r=>{finish=r;});};
  store.enqueue('123',{text:'Immediate text'});await service.deliver();assert.equal(actions,0);
  store.enqueue('123',{type:'file',path:'/synthetic/document.pdf'});
  await service.deliver();assert.equal(actions,1);assert.equal(sent.length,2);finish();
});

test('delivery wake retains disconnected group output until the route is reconnected',async t=>{
  const {cfg,store,service,sent}=await fixture(t);cfg.group={state:'disconnected'};
  service.startDelivery();store.enqueue('123',{text:'Retained group result'});
  await new Promise(r=>setImmediate(r));assert.equal(sent.length,0);
  assert.equal(store.db.prepare('SELECT state FROM outbox').get().state,'pending');
  cfg.group.state='active';await service.deliver();assert.equal(sent.length,1);
});

test('automatic delivery preserves quiet hours, rate-limit backoff, and uncertain outcomes',async t=>{
  const {cfg,store,service,sent}=await fixture(t);cfg.quietStart=0;cfg.quietEnd=23;
  // Select a timezone whose current hour is inside the configured quiet window.
  cfg.timezone=new Date().getUTCHours()===23?'Etc/GMT+1':'UTC';
  service.startDelivery();store.enqueue('123',{text:'Quiet reflection'},true);
  await new Promise(r=>setImmediate(r));assert.equal(sent.length,0);
  service.telegram.sendPart=async()=>{throw Object.assign(new Error('Synthetic rate limit'),{code:429,retryAfter:30});};
  store.enqueue('123',{text:'Rate limited'});await new Promise(r=>setImmediate(r));
  let row=store.db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 1').get();assert.equal(row.state,'pending');assert.equal(row.attempts,1);assert(row.due>Date.now()+25000);
  service.telegram.sendPart=async()=>{throw Object.assign(new Error('Synthetic unknown delivery'),{code:'network'});};
  store.enqueue('123',{text:'Uncertain'});await new Promise(r=>setImmediate(r));
  row=store.db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 1').get();assert.equal(row.state,'uncertain');
  await service.deliver();assert.equal(store.db.prepare('SELECT attempts FROM outbox WHERE id=?').get(row.id).attempts,1);
});
