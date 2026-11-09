import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {responsePayloads} from '../src/presentation.js';
import {Telegram,TelegramError} from '../src/telegram.js';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';
import {Conversations} from '../src/conversations.js';
import {Agent} from '../src/agent.js';

const widget={text:'Tap to explore the explanation.',voice:false,files:[],presentation:{kind:'widget',content:'<p id="value">1</p><button onclick="document.getElementById(\'value\').textContent=2">Next</button>'}};
const rich={text:'One worker handles one job at a time.',voice:false,files:[],presentation:{kind:'rich',content:'# Workers\n\n| Workers | Jobs at once |\n|---|---|\n| 1 | 1 |\n\n$$L=\\lambda W$$\n\n<details><summary>Why?</summary>Each worker runs one job.</details>'}};

test('presentation envelopes contain only service-selected fields and bounded readable fallback',()=>{
  assert.deepEqual(responsePayloads({...widget,presentation:{...widget.presentation,chat_id:'456',allow_queries:true,is_shared:true}}),[{type:'widget',html:widget.presentation.content,text:widget.text}]);
  assert.deepEqual(responsePayloads(rich),[{type:'rich',markdown:rich.presentation.content,text:rich.text}]);
  assert.deepEqual(responsePayloads(widget,{widgets:false}),[{text:widget.text}]);
  assert.deepEqual(responsePayloads(rich,{widgets:false}),responsePayloads(rich));
  assert.deepEqual(responsePayloads({text:'Ordinary',presentation:null}),[{text:'Ordinary'}]);
  for(const presentation of [[],{},false,{kind:'other',content:'hi'},{kind:'widget',content:42},{kind:'widget',content:'\0'}, {kind:'widget',content:' '}])assert.deepEqual(responsePayloads({...widget,presentation}),[{text:widget.text}]);
  assert.deepEqual(responsePayloads({...widget,text:''}),[]);
});

test('widget UTF-8 and zlib limits and fallback caption limits fail safely',()=>{
  for(const content of ['😀'.repeat(9000),randomBytes(5000).toString('base64')])assert.deepEqual(responsePayloads({...widget,presentation:{kind:'widget',content}}),[{text:widget.text}]);
  assert.equal(responsePayloads({...widget,presentation:{kind:'widget',content:'x'.repeat(32768)}})[0].type,'widget');
  assert.equal(responsePayloads({...widget,presentation:{kind:'widget',content:'x'.repeat(32769)}})[0].type,undefined);
  assert.equal(responsePayloads({...widget,text:'😀'.repeat(512)})[0].type,'widget');
  assert.equal(responsePayloads({...widget,text:'😀'.repeat(513)})[0].type,undefined);
  const text='answer '.repeat(1200),payloads=responsePayloads({...rich,text});
  assert.equal(payloads.map(p=>p.text).join(''),text);assert.ok(payloads.every(p=>!p.type));
  assert.equal(responsePayloads({...rich,presentation:{kind:'rich',content:'x'.repeat(32769)}})[0].type,undefined);
});

test('transport uses documented widget/rich APIs, topic route and disabled bot queries',async()=>{
  const telegram=new Telegram('unused'),calls=[];
  telegram.call=async(method,body)=>{calls.push({method,body});return {message_id:7};};
  for(const result of [widget,rich])await telegram.sendPart('123',responsePayloads(result)[0],91);
  assert.deepEqual(calls,[{method:'sendWidget',body:{chat_id:'123',message_thread_id:91,html:widget.presentation.content,caption:widget.text,allow_queries:false,is_shared:false}},{method:'sendRichMessage',body:{chat_id:'123',message_thread_id:91,rich_message:{markdown:rich.presentation.content}}}]);
  await telegram.sendPart('123',{...responsePayloads(widget)[0],plainText:true});
  assert.equal(calls.at(-1).method,'sendMessage');assert.equal(calls.at(-1).body.text,widget.text);
});

for(const result of [widget,rich])test(`${result.presentation.kind} falls back only after definite rejection, preserving literal text and route`,async()=>{
  for(const code of [400,404,403,429,500,'network','invalid-response']) {
    const telegram=new Telegram('unused'),calls=[];
    telegram.call=async(method,body)=>{calls.push({method,body});if(calls.length===1)throw new TelegramError(code);return {};};
    const payload={...responsePayloads(result)[0],text:'**literal** `code` <>& 😀'};
    if([400,404].includes(code)) {
      await telegram.sendPart('123',payload,92);
      assert.deepEqual(calls.at(-1),{method:'sendMessage',body:{chat_id:'123',message_thread_id:92,text:payload.text}});
    } else {await assert.rejects(telegram.sendPart('123',payload,92),e=>e.code===code);assert.equal(calls.length,1);}
  }
});

async function fixture(t) {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-presentation-'));
  const cfg=config({WORKSPACE_DIR:workspace,CODEX_HOME:path.join(workspace,'codex'),TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',BROWSER_ENABLED:'false'});
  const store=new Store(path.join(workspace,'db')),sent=[];
  const telegram=new Telegram('unused');telegram.call=async(method,body)=>{sent.push({method,body});return {message_id:1};};
  const service=new Service(cfg,store,telegram,{run:async()=>rich});await service.init();
  const router=new Conversations(service,{agentFactory:()=>({run:async()=>widget})});service.conversations=router;router.setIdentity({username:'demo_bot',has_topics_enabled:true});
  t.after(async()=>{await router.stop();for(const s of router.all())s.store.db.close();await fs.rm(workspace,{recursive:true,force:true});});
  return {cfg,store,service,router,sent};
}

test('main and worker presentations use durable outbox/history without duplicate text',async t=>{
  const {store,service,sent}=await fixture(t);
  await service.output('123',widget);await service.init();await service.deliver();
  assert.equal(sent.length,1);assert.equal(sent[0].method,'sendWidget');assert.equal(store.search('123').at(-1).text,widget.text);
  const id=store.job('123','Explain worker concurrency','worker');
  const job=store.prepare('SELECT * FROM jobs WHERE $scope AND id=?').get(id);store.prepare("UPDATE jobs SET state='running' WHERE $scope AND id=?").run(id);
  await service.runJob(job,new AbortController());await service.deliver();
  assert.equal(store.jobs('123').find(j=>j.id===id).state,'completed');assert.equal(sent.at(-1).method,'sendRichMessage');assert.equal(sent.length,2);
  assert.equal(store.search('123').at(-1).text,rich.text);
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(service.output('123',widget,false,aborted.signal));assert.equal(store.prepare('SELECT count(*) AS n FROM outbox WHERE $scope').get().n,2);
});

test('presentation guidance reaches main, workers and read-only replies, excluding internal reviews',async t=>{
  const {cfg,store,service}=await fixture(t),calls=[];
  const capability=(...args)=>service.capability(...args);capability.release=token=>service.releaseCapability(token);
  const sdkFactory=options=>({startThread:()=>({runStreamed:async(_input,{outputSchema})=>{
    calls.push({instructions:options.config.developer_instructions,schema:outputSchema});
    return {events:async function*(){yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(outputSchema.properties.presentation?{...rich,presentation:null}:{summary:'',changes:[]})}};yield {type:'turn.completed'};}()};
  }})});
  const agent=new Agent(cfg,store,capability,sdkFactory,service.memory,service.learning);
  for(const [profile,review,scope] of [['main',false],['worker',false],['main',false,{toolScope:'read'}],['research',true]]) {
    await agent.run('123','Synthetic explanation',profile,[],undefined,undefined,undefined,review,scope);
    const call=calls.at(-1);
    if(review){assert.doesNotMatch(call.instructions,/## Telegram presentations v1/);assert.equal(call.schema.properties.presentation,undefined);}
    else {assert.match(call.instructions,/## Telegram presentations v1/);assert.match(call.instructions,/"kind":"widget"/);assert.match(call.instructions,/"kind":"rich"/);assert.ok(call.schema.required.includes('presentation'));}
  }
  assert.equal(service.capabilities.size,0);
});

test('private topics preserve presentation routes and linked groups use readable fallback',async t=>{
  const {store,service,router,sent}=await fixture(t);
  await router.ingest({update_id:1,message:{message_id:1,from:{id:123},chat:{id:123,type:'private'},message_thread_id:93,forum_topic_created:{name:'Synthetic topic'}}});
  const topic=router.all().find(s=>s.cfg.topic);assert.ok(topic);
  await topic.output('123',widget);await topic.deliver();
  assert.equal(sent.at(-1).method,'sendWidget');assert.equal(sent.at(-1).body.message_thread_id,93);
  const text='/link@demo_bot';await router.ingest({update_id:2,message:{message_id:2,from:{id:123},chat:{id:-100,type:'group',title:'Synthetic'},text,entities:[{type:'bot_command',offset:0,length:text.length}]}});
  const group=router.all().find(s=>s.cfg.group);assert.ok(group);await group.deliver();
  await group.output('123',widget);await group.deliver();
  assert.equal(sent.at(-1).method,'sendMessage');assert.equal(sent.at(-1).body.chat_id,'-100');
  assert.ok(!sent.some(s=>s.method==='sendWidget'&&s.body.chat_id==='-100'));
  const count=store.prepare('SELECT count(*) AS n FROM outbox WHERE $scope').get().n;
  await service.output('456',widget);await service.deliver();
  assert.equal(store.prepare("SELECT state FROM outbox WHERE $scope ORDER BY id DESC LIMIT 1").get().state,'rejected');assert.equal(store.prepare('SELECT count(*) AS n FROM outbox WHERE $scope').get().n,count+1);
});

test('unknown enhanced delivery stays uncertain and is not replayed on recovery',async t=>{
  const {store,service}=await fixture(t);let calls=0;
  service.telegram.call=async()=>{calls++;throw new TelegramError('network');};
  await service.output('123',widget);await service.deliver();
  assert.equal(store.prepare('SELECT state FROM outbox WHERE $scope').get().state,'uncertain');
  await service.init();await service.deliver();assert.equal(calls,1);
});
