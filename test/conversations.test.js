import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Agent } from '../src/agent.js';
import { Conversations, addressed, normalizeCommand } from '../src/conversations.js';

const dm=(id,text)=>({update_id:id,message:{message_id:id,date:1,from:{id:123},chat:{id:123,type:'private'},text}});
function group(id,actor=123,chat=-100,text='/link@demo_bot') {
  const length=text.split(' ')[0].length;
  return {update_id:id,message:{message_id:id,date:1,from:{id:actor},chat:{id:chat,type:'group',title:'Synthetic group'},text,entities:text.startsWith('/')?[{type:'bot_command',offset:0,length}]:[{type:'mention',offset:text.indexOf('@demo_bot'),length:9}]}};
}
async function fixture(t,env={}) {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-conversations-'));
  const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',WORKSPACE_DIR:workspace,CODEX_HOME:path.join(workspace,'codex'),PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',...env});
  const store=new Store(path.join(workspace,'dm.sqlite')),sent=[],calls=[];
  const telegram={sendPart:async(chat,payload)=>sent.push({chat,payload})};
  const agent={run:async(user,prompt,profile)=>{calls.push({user,prompt,profile});return {text:'Synthetic reply',voice:false,files:[]};}};
  const service=new Service(cfg,store,telegram,agent);await service.init();
  const router=new Conversations(service,{agentFactory:()=>agent});service.conversations=router;router.username='demo_bot';
  t.after(async()=>{await router.stop();for(const s of router.all())s.store.db.close();await fs.rm(workspace,{recursive:true,force:true});});
  const link=async(id=1,chat=-100)=>{await router.ingest(group(id,123,chat));return router.services.get(router.find(chat).id);};
  return {cfg,store,service,router,sent,calls,link,workspace};
}
function capability(service,actor='123',worker=false,scope={}) {
  const token=service.capability(service.cfg.owner,worker,false,undefined,{actorId:actor,...scope});return service.capabilities.get(token);
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('additive migration preserves the DM thread, rows and session through reopen',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-migrate-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'db');let store=new Store(file);
  store.set('thread:123','synthetic-existing-thread');store.ingest(1,'123',{text:'Old input'});store.history('123','user','Private history');const job=store.job('123','Old task');store.enqueue('123',{text:'Old reply'});
  const first=store.bindConversation('123');assert.equal(store.db.prepare('SELECT thread FROM main_sessions').get().thread,'synthetic-existing-thread');
  for(const table of ['inputs','history','jobs','outbox'])assert.equal(store.db.prepare(`SELECT conversation_id FROM ${table}`).get().conversation_id,first.id);
  store.db.close();store=new Store(file);assert.equal(store.bindConversation('123').id,first.id);assert.equal(store.get('thread:123'),'synthetic-existing-thread');assert.equal(store.jobs('123')[0].id,job);assert.throws(()=>store.bindConversation('456'),/owner/);store.db.close();
});

test('mentions use UTF-16 entities, captions and current bot username',()=>{
  const message={from:{id:456},text:'😀 @demo_bot hello',entities:[{type:'mention',offset:3,length:9}]};
  assert.equal(addressed(message,'demo_bot'),true);assert.equal(addressed(message,'renamed_bot'),false);
  assert.equal(addressed({...message,entities:[]},'demo_bot'),false);
  assert.equal(addressed({...message,from:{id:456,is_bot:true}},'demo_bot'),false);
  assert.equal(addressed({from:{id:456},caption:'@demo_bot',caption_entities:[{type:'mention',offset:0,length:9}]},'demo_bot'),true);
  assert.equal(normalizeCommand(group(1,123,-100,'/status@other_bot').message,'demo_bot'),null);
  assert.equal(addressed(group(1,123,-100,'/status@demo_bot').message,'demo_bot'),true);
});

test('only direct owner linking opens a group; unmentioned, unknown, bot and forum inputs remain absent',async t=>{
  const {router,store,link}=await fixture(t);
  assert.equal(await router.ingest(group(1,456)),false);assert.equal(router.services.size,0);
  const forwarded=group(2);forwarded.message.forward_origin={type:'user'};assert.equal(await router.ingest(forwarded),false);
  const a=await link(3);
  assert.equal(await router.ingest(group(30,456,-100,'@demo_bot rejected')),false);
  assert.equal(a.ingest(group(31,456,-100,'@demo_bot rejected')),false);
  assert.equal(await router.ingest(group(4,123,-100,'@demo_bot hello')),true);
  assert.equal(await router.ingest(group(5,123,-100,'@demo_bot hi')),true);
  const unmentioned=group(6,456,-100,'hello');unmentioned.message.entities=[];assert.equal(await router.ingest(unmentioned),false);
  assert.equal(await router.ingest(group(7,456,-200,'@demo_bot hi')),false);
  const bot=group(8,456,-100,'@demo_bot hi');bot.message.from.is_bot=true;assert.equal(await router.ingest(bot),false);
  const topic=group(9,456,-100,'@demo_bot hi');topic.message.message_thread_id=12;assert.equal(await router.ingest(topic),false);
  assert.deepEqual(a.store.prepare('SELECT actor_id FROM inputs WHERE $scope ORDER BY id').all().map(r=>r.actor_id),['123','123']);
  assert.equal(a.store.get('conversation-owner'),'123');assert.equal(store.prepare("SELECT count(*) AS n FROM inputs WHERE $scope AND state='pending'").get().n,0);
});

test('group rename and supergroup migration preserve state and route future replies',async t=>{
  const {router,link,sent}=await fixture(t);const a=await link();const id=a.store.get('conversation-id'),session=a.store.get('main-session');
  const renamed=group(2,123,-100,'@demo_bot hello');renamed.message.chat.title='Renamed';await router.ingest(renamed);await a.conversation();
  const migration=group(3);migration.message.migrate_to_chat_id=-100999;await router.ingest(migration);
  assert.equal(router.find(-100),undefined);assert.equal(router.find(-100999).id,id);assert.equal(a.store.get('main-session'),session);
  await a.deliver();assert.ok(sent.every(r=>r.chat==='-100999'));
  assert.equal(await router.ingest(group(4,456,-100,'@demo_bot hi')),false);
});

test('shared owner memory, profiles, learning and forgetting coexist with separate recent history',async t=>{
  const {service,link,workspace}=await fixture(t);const a=await link(1),b=await link(2,-200);
  service.store.history('123','user','DM fact');a.store.history('123','user','Group A fact');b.store.history('123','user','Group B fact');
  const id=service.store.search('123')[0].id;
  service.memory.save({key:'shared',category:'facts',title:'Shared fact',content:'Shared owner knowledge',certainty:'confirmed',sources:[`history:${id}`],expected_revision:0});
  for(const s of [a,b])assert.equal((await s.tool(capability(s),'memory_read',{key:'shared'})).content,'Shared owner knowledge');
  assert.equal((await a.tool(capability(a),'history_search',{}))[0].text,'Group A fact');
  assert.equal((await a.tool(capability(a),'history_search',{scope:'all'})).length,3);
  assert.equal(a.learning.evidence(`history:${b.store.search('123')[0].id}`).original_owner_statement,false); // Legacy row kind is not authority.
  const profile=await a.tool(capability(a),'profile_read',{file:'USER.md'});
  await a.tool(capability(a),'profile_write',{file:'USER.md',content:'Shared owner preference',expected_hash:profile.hash});
  assert.equal(await fs.readFile(path.join(workspace,'USER.md'),'utf8'),'Shared owner preference');
  assert.equal(a.cfg.workspace,b.cfg.workspace);assert.equal(a.cfg.codexHome,service.cfg.codexHome);
  await assert.rejects(a.tool(capability(a,'456'),'memory_read',{key:'shared'}));
  await a.tool(capability(a),'memory_forget',{key:'shared'});assert.equal(b.memory.get('shared'),null);assert.equal(service.memory.get('shared'),null);
});

test('group SDK turns load current owner rules and tools while injecting only their recent context',async t=>{
  const {service,link,workspace}=await fixture(t,{BROWSER_ENABLED:'false'});const a=await link(1),b=await link(2,-200);
  service.store.history('123','user','DM-only recent marker');a.store.history('123','user','A-only recent marker');b.store.history('123','user','B-only recent marker');
  await fs.writeFile(path.join(workspace,'SOUL.md'),'Shared new owner rule');let options,context,threadOptions;
  const cap=(...args)=>a.capability(...args);cap.release=token=>a.releaseCapability(token);
  const thread={runStreamed:async input=>{context=input[0].text;return {events:async function*(){yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'ok',voice:false,files:[]})}};yield {type:'turn.completed'};}()};}};
  const agent=new Agent(a.cfg,a.store,cap,opts=>{options=opts;return {startThread:opts=>{threadOptions=opts;return thread;}};},a.memory,a.learning);
  await agent.run('123','Owner group request','main',[],undefined,undefined,undefined,false,{actorId:'123',settings:a.effectiveSettings('main')});
  assert.ok(options.config.developer_instructions.includes('Shared new owner rule'));
  assert.equal(options.env.CODEX_HOME,service.cfg.codexHome);assert.equal(options.codexPathOverride,undefined);
  assert.equal(threadOptions.sandboxMode,'danger-full-access');assert.ok(!options.configOverrides.some(s=>s.includes('features.plugins=false')));
  assert.ok(context.includes('A-only recent marker'));assert.ok(!context.includes('DM-only recent marker')&&!context.includes('B-only recent marker'));
});

test('task capability binds audience, session, task and actor; overrides cannot widen permissions',async t=>{
  const {service,link}=await fixture(t);const a=await link(1),b=await link(2,-200),cap=capability(a,'123');
  const task=await a.tool(cap,'create_task',{prompt:'A worker',settings:{effort:'medium',timeout:30,toolScope:'read'}});
  assert.equal(JSON.parse(a.store.get(`task-settings:${task.id}`)).effort,'medium');
  assert.equal(a.store.prepare('SELECT actor_id FROM jobs WHERE $scope AND id=?').get(task.id).actor_id,'123');
  assert.equal((await b.tool(capability(b,'123'),'cancel_task',{id:task.id})).cancelled,false);
  assert.equal((await service.tool({user:'123'},'cancel_task',{id:task.id})).cancelled,false);
  await assert.rejects(a.tool(capability(a,'789'),'cancel_task',{id:task.id}));
  await assert.rejects(b.tool(cap,'history_search',{}));
  const before=a.store.jobs('123').length;await assert.rejects(a.tool(cap,'create_task',{prompt:'invalid',settings:{toolScope:'all'}}));assert.equal(a.store.jobs('123').length,before);
  await assert.rejects(a.tool({...cap,toolScope:'read'},'create_task',{prompt:'widen'}));
  a.store.prepare("UPDATE jobs SET state='running' WHERE $scope AND id=?").run(task.id);
  const worker=capability(a,'123',true,{taskId:task.id,toolScope:'read'});await assert.rejects(a.tool(worker,'memory_save',{}));
  a.store.rotateSession('123');await assert.rejects(a.tool(cap,'history_search',{}),/revoked/);
});

test('worker results, files, reminders and restart notices retain the source destination',async t=>{
  const {service,router,link,sent}=await fixture(t);const a=await link(1),b=await link(2,-200);
  await router.ingest(group(3,123,-100,'@demo_bot A'));await a.conversation();await router.ingest(dm(4,'DM'));await service.conversation();await router.ingest(group(5,123,-200,'@demo_bot B'));await b.conversation();
  const task=await a.tool(capability(a,'123'),'create_task',{prompt:'A worker'});const job=a.store.prepare('SELECT * FROM jobs WHERE $scope AND id=?').get(task.id);
  await fs.writeFile(path.join(a.cfg.workspace,'outputs','a.txt'),'A artifact');a.agent={run:async()=>({text:'A completed',files:['outputs/a.txt'],voice:false})};
  a.store.prepare("UPDATE jobs SET state='running' WHERE $scope AND id=?").run(task.id);await a.runJob(job,new AbortController());await a.conversation();
  const schedule=await a.tool(capability(a,'123'),'schedule',{kind:'reminder',prompt:'A reminder',due:new Date(Date.now()+60000).toISOString(),key:'same'});a.schedules(schedule.due+1);
  const interrupted=a.store.job('123','Interrupted A');a.store.prepare("UPDATE jobs SET state='running' WHERE $scope AND id=?").run(interrupted);a.store.recover();
  await a.deliver();assert.ok(sent.every(r=>r.chat==='-100'));assert.ok(sent.some(r=>r.payload.text==='A reminder'));assert.ok(sent.some(r=>r.payload.filename==='a.txt'&&r.payload.bytes?.toString()==='A artifact'));assert.ok(sent.some(r=>r.payload.text?.includes('restart')));
});

test('/new affects only its conversation and a late worker result bypasses its new model session',async t=>{
  const {router,link}=await fixture(t);const a=await link(1),b=await link(2,-200);
  a.store.set('thread:123','A');b.store.set('thread:123','B');const task=await a.tool(capability(a,'123'),'create_task',{prompt:'late'}),job=a.store.prepare('SELECT * FROM jobs WHERE $scope AND id=?').get(task.id);
  await router.ingest(group(3,123,-100,'/new@demo_bot'));await a.conversation();assert.equal(a.store.get('thread:123'),'');assert.equal(b.store.get('thread:123'),'B');
  a.store.prepare("UPDATE jobs SET state='running' WHERE $scope AND id=?").run(task.id);await a.runJob(job,new AbortController());
  assert.equal(a.store.prepare("SELECT count(*) AS n FROM inputs WHERE $scope AND json_extract(payload,'$.event')=1").get().n,0);
  assert.ok(a.store.prepare('SELECT payload FROM outbox WHERE $scope').all().some(r=>JSON.parse(r.payload).text==='Synthetic reply'));
});

test('disconnect and bot removal block delivery and tools without redirecting; reconnect is explicit',async t=>{
  const {router,link,sent}=await fixture(t);const a=await link();a.store.enqueue('123',{text:'Retained'});const cap=capability(a,'123');
  router.disconnect(a.store.get('conversation-id'));await router.ingest(group(2,123,-100,'@demo_bot hello'));router.tick();await flush();assert.equal(sent.length,0);await assert.rejects(a.tool(cap,'history_search',{}));
  await router.ingest(group(3));await a.deliver();assert.ok(sent.some(r=>r.payload.text==='Retained'&&r.chat==='-100'));
  await router.ingest({my_chat_member:{chat:{id:-100},new_chat_member:{status:'kicked'}}});assert.equal(a.cfg.group.state,'disconnected');
});

test('shared main/worker limits and fairness allow B to run while A is busy',async t=>{
  const {router,service,link}=await fixture(t,{MAX_MAIN_TURNS:'2',MAX_EXECUTIONS:'2',MAX_WORKERS:'1'});const a=await link(1),b=await link(2,-200),releases=[];
  const done={text:'done',voice:false,files:[]};
  for(const s of [a,b])s.agent={run:(_user,_prompt,_profile,_images,signal)=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});releases.push(()=>resolve(done));})};
  await router.ingest(group(3,123,-100,'@demo_bot A'));await router.ingest(group(4,123,-200,'@demo_bot B'));router.tick();
  const deadline=Date.now()+5000;while(releases.length<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(releases.length,2);
  assert.equal(a.mainBusy,true);assert.equal(b.mainBusy,true);assert.equal(service.mainBusy,false);assert.equal(router.all().reduce((n,s)=>n+s.controllers.size,0),2);
  const task=await a.tool(capability(a,'123'),'create_task',{prompt:'queued while mains run'});router.tick();assert.equal(a.store.prepare('SELECT state FROM jobs WHERE $scope AND id=?').get(task.id).state,'queued');
  releases.forEach(release=>release());await Promise.all([a.activeTurn,b.activeTurn]);
  for(const s of [a,b])s.agent={run:async()=>done};
  router.tick();assert.ok(router.all().reduce((n,s)=>n+s.controllers.size,0)<=2);await Promise.all([...(a.workerRuns?.values()||[]),...(b.workerRuns?.values()||[])]);
});

test('group reopen preserves its thread, schedule, scope and safe auth reference',async t=>{
  const {router,link,service}=await fixture(t);const a=await link(),id=a.store.get('conversation-id');a.store.set('thread:123','saved-group-thread');
  const schedule=await a.tool(capability(a,'123'),'schedule',{kind:'reminder',prompt:'Restart reminder',due:new Date(Date.now()+60000).toISOString(),key:'restart'});
  a.store.db.close();router.services.clear();await router.init();const reopened=router.services.get(id);
  assert.equal(reopened.store.get('thread:123'),'saved-group-thread');assert.equal(reopened.store.prepare('SELECT conversation_id FROM schedules WHERE $scope AND id=?').get(schedule.id).conversation_id,id);
  assert.equal(reopened.cfg.codexHome,service.cfg.codexHome);assert.equal(reopened.memory,service.memory);
});

test('global login availability still permits /usage without a model call',async t=>{
  const {router,service,calls}=await fixture(t);service.auth={ready:false,phase:'idle',notifyMissing:()=>{}};service.usageText=async()=>'Synthetic usage limits';
  await router.ingest(dm(1,'/usage'));router.tick();await service.activeTurn;assert.equal(service.store.db.prepare('SELECT state FROM inputs').get().state,'done');assert.equal(calls.length,0);
});

test('shared HTTP MCP dispatch routes the capability to its conversation and rejects revoked tokens',async t=>{
  const {router,service,link}=await fixture(t);const a=await link();service.store.history('123','user','DM secret');a.store.history('123','user','Group-only text','123');
  await service.listen(0);t.after(()=>new Promise(resolve=>service.server.close(resolve)));
  const token=router.issueCapability(a,'123',false,false,undefined,{actorId:'123'});
  const request=()=>fetch(`http://127.0.0.1:${service.server.address().port}/tool`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({name:'history_search',args:{}})});
  const response=await request();assert.equal(response.status,200);assert.equal((await response.json())[0].text,'Group-only text');
  const mcp=body=>fetch(`http://127.0.0.1:${service.server.address().port}/mcp`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,...body})});
  const tools=await (await mcp({method:'tools/list'})).json();assert.ok(tools.result.tools.some(tool=>tool.name==='memory_search'));assert.ok(tools.result.tools.some(tool=>tool.name==='location_get'));assert.ok(tools.result.tools.some(tool=>tool.name==='profile_write'));
  const called=await (await mcp({method:'tools/call',params:{name:'history_search',arguments:{}}})).json();assert.equal(JSON.parse(called.result.content[0].text)[0].text,'Group-only text');
  assert.equal(a.learning.evidence(`history:${a.store.search('123')[0].id}`).original_owner_statement,false);
  router.disconnect(a.store.get('conversation-id'));assert.equal((await request()).status,403);assert.equal((await mcp({method:'tools/list'})).status,403);
});

test('authorization changes reset every group thread and revoke running capabilities',async t=>{
  const {router,link}=await fixture(t);const a=await link(1),b=await link(2,-200);a.store.set('thread:123','A');b.store.set('thread:123','B');const cap=capability(a,'123'),previous=a.store.get('main-session');router.invalidateAll();assert.equal(a.store.get('thread:123'),'');assert.equal(b.store.get('thread:123'),'');assert.notEqual(a.store.get('main-session'),previous);await assert.rejects(a.tool(cap,'history_search',{}));
});
