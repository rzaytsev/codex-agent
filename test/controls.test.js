import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {TelegramError} from '../src/telegram.js';
import {fixture,answer,waitFor} from './control-fixture.js';

test('task Cancel is bound to owner, message, route and exact job; duplicate callbacks do not replay',async t=>{
 const {service,store,router,sent,query,task}=await fixture(t),card=await task();
 assert.equal(sent.at(-1).body.reply_markup.inline_keyboard[0][0].text,'Cancel');
 for(const patch of [{from:{id:456}},{message:{message_id:999,chat:{id:123,type:'private'}}},{message:{message_id:card.message_id,chat:{id:123,type:'group'}}},{message:{message_id:card.message_id,message_thread_id:98,chat:{id:123,type:'private'}}},{inline_message_id:'forwarded'}])assert.equal(await router.ingest(query(card,'cancel',20,patch)),false);
 assert.equal(store.jobs('123',card.job_id)[0].state,'queued');
 assert.equal(await router.ingest(query(card,'cancel')),true);assert.equal(await router.ingest(query(card,'cancel')),false);
 assert.equal(store.jobs('123',card.job_id)[0].state,'cancelled');await service.deliver();assert.match(sent.at(-1).body.text,/Cancelled/);assert.deepEqual(sent.at(-1).body.reply_markup.inline_keyboard,[]);
});

test('running task card reports Stopping until execution exits and suppresses late output',async t=>{
 const {service,store,router,agent,query,task,row}=await fixture(t),card=await task();let resolve,signal;
 agent.run=async(...args)=>{signal=args[4];return new Promise(r=>{resolve=r;});};
 service.workers();const run=service.workerRuns.get(card.job_id);await waitFor(()=>resolve);
 assert.equal(await router.ingest(query(row(card.id),'cancel')),true);assert.equal(signal.aborted,true);assert.equal(row(card.id).state,'cancel_requested');
 resolve(answer);await run;assert.equal(row(card.id).state,'cancelled');assert.equal(store.prepare("SELECT id FROM outbox WHERE $scope AND payload LIKE '%Synthetic answer%'").get(),undefined);
});

test('Open result uses immutable artifact and text snapshots across sessions without a new model call',async t=>{
 const {service,store,router,agent,query,task,row,workspace,sent}=await fixture(t),card=await task();const file=path.join(workspace,'result.txt');await fs.writeFile(file,'original bytes');
 let calls=0;agent.run=async()=>{calls++;return {...answer,files:[file]};};
 service.workers();await service.workerRuns.get(card.job_id);await service.deliver();await service.deliver();
 const completed=row(card.id);assert.equal(completed.state,'completed');assert.ok(JSON.parse(completed.payloads).some(p=>p.artifactId));
 await fs.writeFile(file,'changed bytes');store.rotateSession('123');sent.length=0;
 assert.equal(await router.ingest(query(completed,'open')),true);assert.equal(await router.ingest(query(completed,'open')),false);await service.deliver();
 assert.equal(calls,1);const form=sent.find(c=>c.method==='sendDocument').body;assert.equal(await form.get('document').text(),'original bytes');assert.ok(sent.some(c=>c.body.text==='Synthetic answer'));
});

test('initial delivery race catches up card state; uncertain sends are not replayed on recovery',async t=>{
 const {service,store,sent}=await fixture(t);const {id}=await service.tool({user:'123',worker:false},'create_task',{prompt:'Synthetic'});
 const original=service.telegram.call;service.telegram.call=async(method,body)=>{const receipt=await original(method,body);if(method==='sendMessage')service.cancelTask('123',id,'123');return receipt;};
 await service.deliver();await service.deliver();assert.ok(sent.some(c=>c.method==='editMessageText'&&/Cancelled/.test(c.body.text)));
 const count=sent.length;await service.init();await service.deliver();assert.equal(sent.length,count);
 await service.tool({user:'123',worker:false},'create_task',{prompt:'Unknown receipt'});service.telegram.call=async()=>{throw new TelegramError('network');};await service.deliver();assert.ok(store.prepare("SELECT id FROM outbox WHERE $scope AND state='uncertain'").get());await service.init();service.telegram.call=original;await service.deliver();assert.equal(sent.length,count);
});

test('clarification choices queue one agent event and expire after free-form input or session changes',async t=>{
 const {service,store,router,query,row,requests}=await fixture(t);
 const ask=()=>service.tool({user:'123',worker:false},'ask_clarification',{question:'Which explanation?',options:[{label:'Brief',value:'Explain in one paragraph'},{label:'Detailed',value:'Explain with examples'}]});
 const c=await ask();await service.deliver();const card=row(c.id);
 assert.equal(await router.ingest(query(card,'1')),true);assert.equal(await router.ingest(query(card,'0',21)),false);assert.equal(requests.length,0);
 await service.conversation();assert.match(requests[0],/Explain with examples/);assert.equal(store.prepare("SELECT origin FROM history_origins WHERE origin='event'").get().origin,'event');
 const next=await ask();await service.deliver();service.ingest({update_id:22,message:{message_id:222,from:{id:123},chat:{id:123,type:'private'},text:'I prefer a diagram'}});assert.equal(row(next.id).state,'expired');assert.equal(await router.ingest(query(row(next.id),'0',23)),false);
 const old=await ask();await service.deliver();store.rotateSession('123');assert.equal(await router.ingest(query(row(old.id),'0',24)),false);
 for(const cap of [{user:'123',worker:true},{user:'123',worker:false,toolScope:'read'},{user:'123',worker:true,memoryReview:true}])await assert.rejects(service.tool(cap,'ask_clarification',{question:'x',options:[{label:'a',value:'a'},{label:'b',value:'b'}]}));
});

test('topic controls stay routed to their original topic and disabled topics reject callbacks',async t=>{
 const {service,router,query}=await fixture(t);await router.ingest({update_id:1,message:{from:{id:123},chat:{id:123,type:'private'},message_thread_id:77,forum_topic_created:{name:'Synthetic'}}});const topic=router.all().find(s=>s.cfg.topic);
 const c=await topic.tool({user:'123',worker:false,actorId:'123'},'ask_clarification',{question:'Which?',options:[{label:'A',value:'a'},{label:'B',value:'b'}]});await topic.deliver();const card=topic.controls.row(c.id);
 const q=query(card,'0');assert.equal(await router.ingest(q),false);q.callback_query.message.message_thread_id=77;assert.equal(await router.ingest(q),true);
 router.setIdentity({username:'demo_bot',has_topics_enabled:false});assert.equal(await router.ingest({...q,update_id:21,callback_query:{...q.callback_query,id:'disabled'}}),false);
 assert.equal(service.store.prepare('SELECT id FROM inputs WHERE $scope AND id=20').get(),undefined);
});

test('effective agent instructions expose controls only to ordinary private main turns',async t=>{
 const {cfg,store,service}=await fixture(t);const {Agent}=await import('../src/agent.js');
 for(const [profile,scope,internal,group,available] of [['main',{},false,false,true],['worker',{},false,false,false],['main',{toolScope:'read'},false,false,false],['main',{},false,true,false],['research',{},true,false,false]]) {
  let instructions;const capability=(...args)=>service.capability(...args);capability.release=token=>service.releaseCapability(token);
  const sdkFactory=options=>{instructions=options.config.developer_instructions;const thread=()=>({runStreamed:async()=>({events:async function*(){yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(internal?{summary:'',changes:[]}:answer)}};yield {type:'turn.completed'};}()})});return {startThread:thread,resumeThread:thread};};
  const agent=new Agent({...cfg,...(group?{group:{chat_id:'-456',title:'Synthetic'}}:{})},store,capability,sdkFactory,service.memory,service.learning);
  await agent.run('123','Synthetic request',profile,[],undefined,()=>{},undefined,internal,scope);
  assert.equal(instructions.includes('# Conversation controls'),available);if(!available&&!internal)assert.match(instructions,/clarification and reply preview service tools are unavailable/);
 }
});
