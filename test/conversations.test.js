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
const topic=(id,thread,text)=>{const update=dm(id,text);Object.assign(update.message,{message_thread_id:thread,is_topic_message:true});return update;};
function group(id,actor=123,chat=-100,text='/link@demo_bot') {
  const length=text.split(' ')[0].length;
  return {update_id:id,message:{message_id:id,date:1,from:{id:actor},chat:{id:chat,type:'group',title:'Synthetic group'},text,entities:text.startsWith('/')?[{type:'bot_command',offset:0,length}]:[{type:'mention',offset:text.indexOf('@demo_bot'),length:9}]}};
}
async function fixture(t,env={}) {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-conversations-'));
  const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',WORKSPACE_DIR:workspace,CODEX_HOME:path.join(workspace,'codex'),PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',...env});
  const store=new Store(path.join(workspace,'dm.sqlite')),sent=[],calls=[];
  const telegram={sendPart:async(chat,payload,thread)=>sent.push({chat,payload,thread})};
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

test('private topics require the Telegram capability and exact owner before any persistence',async t=>{
  const {router,store,service}=await fixture(t);
  assert.equal(await router.ingest(topic(1,101,'Disabled topic')),false);
  router.setIdentity({username:'demo_bot',has_topics_enabled:true});
  for(const thread of [0,-1,'101',1.5,2147483648])assert.equal(await router.ingest(topic(2,thread,'Invalid')),false);
  for(const change of [{from:{id:456}},{from:{id:123,is_bot:true}},{chat:{id:456,type:'private'}}]) {
    const input=topic(3,101,'Foreign');Object.assign(input.message,change);assert.equal(await router.ingest(input),false);
  }
  const edited=topic(4,101,'Edited');assert.equal(await router.ingest({update_id:4,edited_message:edited.message}),false);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM inputs').get().n,0);
  assert.equal(router.services.size,0);
  assert.equal(await router.ingest(topic(5,101,'Owner topic')),true);
  const a=[...router.services.values()][0];assert.equal(a.cfg.topic.message_thread_id,101);
  assert.equal(service.ingest(topic(6,101,'Wrong root route')),false);
  assert.equal(a.ingest(topic(7,202,'Wrong topic route')),false);
  assert.equal(a.ingest(dm(8,'Missing topic')),false);
  assert.equal(await router.ingest(topic(5,101,'Owner topic')),false);
  await assert.rejects(a.tool(capability(a,'456'),'history_search',{}));
});

test('topic contexts and controls are independent while owner knowledge and documents stay shared',async t=>{
  const {router,service,workspace}=await fixture(t,{MEMORY_ENABLED:'true',LEARNING_ENABLED:'true',PROACTIVE_ENABLED:'true'});
  router.setIdentity({username:'demo_bot',has_topics_enabled:true});
  service.store.set('thread:123','retained-default');
  await router.ingest(topic(1,101,'Topic A owner fact'));const a=[...router.services.values()][0];await a.conversation();
  await router.ingest(topic(2,202,'Topic B owner fact'));const b=[...router.services.values()][1];await b.conversation();
  const source=a.store.search('123')[0].id;
  const memoryBatch=service.memory.batch('daily',service.memory.target('daily')),learningBatch=service.learning.batch(service.learning.target());
  for(const marker of ['Topic A owner fact','Topic B owner fact']){assert.ok(memoryBatch.records.some(r=>r.text===marker));assert.ok(learningBatch.records.some(r=>r.text===marker));}
  assert.equal(a.learning.evidence(`history:${source}`).original_owner_statement,true);
  a.memory.save({key:'shared-topic-fact',category:'facts',title:'Shared topic fact',content:'Owner knowledge from topic A',certainty:'confirmed',sources:[`history:${source}`],expected_revision:0});
  assert.equal(b.memory.get('shared-topic-fact').content,'Owner knowledge from topic A');
  assert.equal(service.memory.get('shared-topic-fact').content,'Owner knowledge from topic A');assert.equal(service.learning.evidence(`history:${source}`).original_owner_statement,true);assert.equal(a.profiles,b.profiles);assert.equal(a.locations,b.locations);
  assert.equal((await a.tool(capability(a),'history_search',{}))[0].text,'Topic A owner fact');
  assert.equal((await b.tool(capability(b),'history_search',{}))[0].text,'Topic B owner fact');
  assert.equal((await b.tool(capability(b),'history_search',{scope:'all'})).length,4);
  const profile=await a.tool(capability(a),'profile_read',{file:'USER.md'});await a.tool(capability(a),'profile_write',{file:'USER.md',content:'Shared topic preference',expected_hash:profile.hash});
  assert.equal((await b.tool(capability(b),'profile_read',{file:'USER.md'})).content,'Shared topic preference');
  await fs.writeFile(path.join(workspace,'projects','shared.txt'),'Shared document');assert.equal(await fs.readFile(path.join(b.cfg.workspace,'projects','shared.txt'),'utf8'),'Shared document');
  a.store.set('thread:123','A');b.store.set('thread:123','B');const cap=capability(a),oldSession=a.store.get('main-session');
  await router.ingest(topic(3,101,'/new'));await a.conversation();
  assert.equal(a.store.get('thread:123'),'');assert.notEqual(a.store.get('main-session'),oldSession);assert.equal(b.store.get('thread:123'),'B');assert.equal(service.store.get('thread:123'),'retained-default');
  await assert.rejects(a.tool(cap,'history_search',{}),/revoked/);await assert.rejects(b.tool(capability(a),'history_search',{}),/revoked/);
  const schedules=service.store.db.prepare('SELECT kind,conversation_id FROM schedules WHERE enabled=1').all();
  assert.equal(schedules.filter(r=>r.kind==='memory').length,2);assert.equal(schedules.filter(r=>r.kind==='learning').length,1);assert.equal(schedules.filter(r=>r.kind==='review').length,3);
  assert.ok(schedules.every(r=>r.conversation_id===service.store.get('conversation-id')));
  assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM learning_events').get().n>=4,true);
  a.store.set('memory-export-dirty','1');assert.equal(service.store.get('memory-export-dirty'),'1');assert.equal(b.store.get('memory-export-dirty'),'1');
  b.store.set('learning-cursor:123','4');assert.equal(service.store.get('learning-cursor:123'),'4');assert.equal(a.store.get('learning-cursor:123'),'4');
});

test('topic worker artifacts, late results and reminders retain their topic after restart',async t=>{
  const {router,service,sent,workspace}=await fixture(t);router.setIdentity({username:'demo_bot',has_topics_enabled:true});
  await router.ingest(topic(1,101,'A'));const a=[...router.services.values()][0];await a.conversation();
  await router.ingest(topic(2,202,'B'));const b=[...router.services.values()][1];await b.conversation();
  const task=await a.tool(capability(a),'create_task',{prompt:'A worker'}),job=a.store.prepare('SELECT * FROM jobs WHERE $scope AND id=?').get(task.id);
  assert.equal((await b.tool(capability(b),'cancel_task',{id:task.id})).cancelled,false);
  await fs.writeFile(path.join(workspace,'outputs','topic.txt'),'Topic artifact');
  a.agent={run:async()=>({text:'Late A result',voice:false,files:['outputs/topic.txt']})};
  await router.ingest(topic(3,101,'/new'));await a.conversation();a.store.prepare("UPDATE jobs SET state='running' WHERE $scope AND id=?").run(task.id);await a.runJob(job,new AbortController());
  assert.equal(a.store.search('123').some(r=>r.text==='Late A result'),false);
  const schedule=await a.tool(capability(a),'schedule',{kind:'reminder',prompt:'A topic reminder',due:new Date(Date.now()+60000).toISOString(),key:'restart'});
  a.store.set('thread:123','saved-A');b.store.set('thread:123','saved-B');const ids=[a,b].map(s=>s.store.get('conversation-id'));
  for(const s of router.services.values())s.store.db.close();router.services.clear();await router.init();
  const reopened=router.services.get(ids[0]);assert.equal(reopened.store.get('thread:123'),'saved-A');assert.equal(router.services.get(ids[1]).store.get('thread:123'),'saved-B');assert.equal(service.store.get('thread:123'),undefined);
  reopened.schedules(schedule.due+1);await reopened.deliver();
  assert.ok(sent.every(r=>r.chat==='123'&&r.thread===101));assert.ok(sent.some(r=>r.payload.text==='Late A result'));assert.ok(sent.some(r=>r.payload.text==='A topic reminder'));assert.ok(sent.some(r=>r.payload.filename==='topic.txt'&&r.payload.bytes.toString()==='Topic artifact'));
});

test('disabling topic mode retains routes and queues without merging or redirecting them',async t=>{
  const {router,service,sent}=await fixture(t);router.setIdentity({username:'demo_bot',has_topics_enabled:true});
  await router.ingest(topic(1,101,'Retained topic request'));const a=[...router.services.values()][0];a.store.set('thread:123','saved-topic');a.store.enqueue('123',{text:'Retained topic reply'});const cap=capability(a);
  router.setIdentity({username:'demo_bot',has_topics_enabled:false});router.tick();await flush();await a.deliver();assert.equal(sent.length,0);assert.equal(a.mainBusy,false);
  assert.equal(await router.ingest(topic(2,101,'Stale topic message')),false);await assert.rejects(a.tool(cap,'history_search',{}));
  assert.equal(await router.ingest(dm(3,'Normal chat request')),true);await service.conversation();await service.deliver();assert.equal(sent[0].thread,undefined);
  assert.equal(a.store.get('thread:123'),'saved-topic');assert.equal(a.store.prepare("SELECT count(*) AS n FROM outbox WHERE $scope AND state='pending'").get().n,1);
  router.setIdentity({username:'demo_bot',has_topics_enabled:true});await a.deliver();assert.equal(sent[1].thread,101);assert.equal(sent[1].payload.text,'Retained topic reply');
});

test('topic metadata never becomes a model request and authentication availability is global',async t=>{
  const {router,service,calls}=await fixture(t);router.setIdentity({username:'demo_bot',has_topics_enabled:true});
  const created=topic(1,101,undefined);created.message.forum_topic_created={name:'Project A'};await router.ingest(created);
  const a=[...router.services.values()][0];const edited=topic(2,101,undefined);edited.message.forum_topic_edited={name:'Renamed A'};await router.ingest(edited);assert.equal(a.cfg.topic.title,'Renamed A');
  a.store.db.exec("CREATE TEMP TRIGGER reject_topic_title BEFORE UPDATE OF title ON conversations BEGIN SELECT RAISE(ABORT,'Synthetic metadata failure'); END");
  const failed=topic(20,101,undefined);failed.message.forum_topic_edited={name:'Failed rename'};await assert.rejects(router.ingest(failed));a.store.db.exec('DROP TRIGGER reject_topic_title');
  assert.equal(a.store.db.prepare('SELECT count(*) AS n FROM inputs WHERE id=20').get().n,0);assert.equal(a.cfg.topic.title,'Renamed A');
  assert.equal(a.store.prepare("SELECT count(*) AS n FROM inputs WHERE $scope AND state='pending'").get().n,0);
  service.auth={ready:false,phase:'idle',notifyMissing:()=>{}};assert.equal(a.auth,service.auth);
  service.auth.command=()=>service.store.set('synthetic-auth-control','shared');service.tdlAuth={active:false,command:()=>service.store.set('synthetic-tdl-control','shared')};
  await router.ingest(topic(30,101,'/auth status'));await router.ingest(topic(31,101,'/tdl_auth status'));assert.equal(service.store.get('synthetic-auth-control'),'shared');assert.equal(service.store.get('synthetic-tdl-control'),'shared');
  a.usageText=async()=>'Shared account usage';await router.ingest(topic(3,101,'/usage'));router.tick();await a.activeTurn;assert.equal(calls.length,0);
  a.store.set('thread:123','saved');const token=capability(a);router.invalidateAll();assert.equal(a.store.get('thread:123'),'');await assert.rejects(a.tool(token,'history_search',{}));
});

test('topic SDK context uses a separate thread and recent history with current shared owner rules',async t=>{
  const {router,service,workspace}=await fixture(t,{BROWSER_ENABLED:'false'});router.setIdentity({username:'demo_bot',has_topics_enabled:true});
  await router.ingest(topic(1,101,'A pending'));await router.ingest(topic(2,202,'B pending'));const [a,b]=router.services.values();
  service.store.set('thread:123','default-only');b.store.set('thread:123','B-only');
  service.store.history('123','user','Default recent marker');a.store.history('123','user','A recent marker');b.store.history('123','user','B recent marker');
  await fs.writeFile(path.join(workspace,'SOUL.md'),'Shared owner rule for every topic');let context,options;
  const thread={runStreamed:async input=>{context=input[0].text;return {events:async function*(){yield {type:'thread.started',thread_id:'A-native'};yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'ok',voice:false,files:[]})}};yield {type:'turn.completed'};}()};}};
  const cap=(...args)=>a.capability(...args);cap.release=token=>a.releaseCapability(token);
  const agent=new Agent(a.cfg,a.store,cap,opts=>{options=opts;return {startThread:()=>thread,resumeThread:()=>{throw new Error('Topic A must start fresh');}};},a.memory,a.learning);
  await agent.run('123','Topic A request','main',[],undefined,undefined,undefined,false,{actorId:'123',settings:a.effectiveSettings('main')});
  assert.ok(options.config.developer_instructions.includes('Shared owner rule for every topic'));assert.ok(context.includes('Telegram private topic 101'));assert.ok(context.includes('A recent marker'));assert.ok(!context.includes('Default recent marker')&&!context.includes('B recent marker'));
  assert.equal(a.store.get('thread:123'),'A-native');assert.equal(b.store.get('thread:123'),'B-only');assert.equal(service.store.get('thread:123'),'default-only');
});

test('opening a topic leaves in-flight mail alone and binds owner acceptance and approvals to that topic',async t=>{
  const {router,service,sent}=await fixture(t,{MAILBOX_URL:'http://127.0.0.1:1',MAILBOX_TOKEN:'x'.repeat(32),MAILBOX_ID:'synthetic'});router.setIdentity({username:'demo_bot',has_topics_enabled:true});
  service.store.db.prepare('INSERT INTO mail_outbox VALUES (?,?,?,?,?)').run('inflight','send',JSON.stringify({id:'inflight',to:'peer',text:'Existing send',kind:'message'}),'inflight',Date.now());
  await router.ingest(topic(1,101,'A'));await router.ingest(topic(2,202,'B'));const [a,b]=router.services.values();
  assert.equal(service.store.db.prepare('SELECT state FROM mail_outbox WHERE id=?').get('inflight').state,'inflight');
  service.store.db.prepare('INSERT INTO mail_received VALUES (?,?,?,NULL)').run('incoming',JSON.stringify({id:'incoming',sender:'peer',kind:'task_request',text:'Synthetic task',context:''}),'pending_acceptance');
  await router.ingest(topic(3,101,'/mail accept incoming'));assert.equal(a.store.jobs('123').length,1);assert.equal(b.store.jobs('123').length,0);assert.equal(service.store.jobs('123').length,0);
  const prepared=await a.tool(capability(a),'mail_send',{id:'topic-mail',to:'peer',text:'Owner selected text'});
  await router.ingest(topic(4,202,`/approve ${prepared.approval_id} ${prepared.hash}`));assert.equal(service.store.db.prepare('SELECT state FROM action_approvals WHERE id=?').get(prepared.approval_id).state,'pending_approval');
  await router.ingest(topic(5,101,`/approve ${prepared.approval_id} ${prepared.hash}`));assert.equal(service.store.db.prepare('SELECT state FROM action_approvals WHERE id=?').get(prepared.approval_id).state,'approved');
  const result=await a.tool(capability(a),'mail_commit',{id:'topic-mail',to:'peer',text:'Owner selected text',approval_id:prepared.approval_id});assert.equal(result.state,'pending');
  await a.deliver();assert.ok(sent.every(r=>r.thread===101));assert.ok(sent.some(r=>r.payload.plainText===true));
});
