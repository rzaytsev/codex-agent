import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,answer,waitFor} from './control-fixture.js';
const stop=(id,update=30,extra={})=>({update_id:update,stopped_message_generation:{chat:{id:123,type:'private'},draft_id:id,...extra}});
const intake=(service,id=10)=>service.ingest({update_id:id,message:{message_id:id,from:{id:123},chat:{id:123,type:'private'},text:'Explain the synthetic example'}});

test('answer fragments reach native drafts while the model is running; final delivery is durable and previews close',async t=>{
 const {service,store,agent,sent}=await fixture(t);let release;
 agent.run=async(...args)=>{const cap={user:'123',worker:false,inputId:args[8].inputId};await service.tool(cap,'stream_reply',{sequence:1,text:'First paragraph.\n\n'});await new Promise(r=>setTimeout(r,850));await service.tool(cap,'stream_reply',{sequence:2,text:'Second paragraph.'});await new Promise(r=>{release=r;});return {...answer,text:'First paragraph.\n\nSecond paragraph.'};};
 intake(service);const run=service.conversation();await waitFor(()=>release);await waitFor(()=>sent.filter(c=>c.method==='sendMessageDraft').some(c=>c.body.text.includes('Second')));
 assert.ok(!sent.some(c=>c.method==='sendChatAction'),'native drafts must not compete with plain typing');const drafts=sent.filter(c=>c.method==='sendMessageDraft');assert.ok(drafts.length>=2);assert.ok(drafts.every(c=>c.body.can_stop&&!c.body.keep_on_stop));assert.equal(store.prepare("SELECT state FROM inputs WHERE $scope AND id=10").get().state,'processing');
 const active=[...service.streams.active.values()][0];release();await run;await service.deliver();const n=sent.length;await service.streams.flush(active,true);assert.equal(sent.length,n);assert.equal(service.streams.active.size,0);assert.ok(sent.some(c=>c.method==='sendMessage'&&c.body.text.includes('Second paragraph.')));
});

test('stream sequences are idempotent, bounded and role restricted; preview failure leaves normal delivery available',async t=>{
 const {service,agent,sent}=await fixture(t);let release,cap;
 agent.run=async(...args)=>{cap={user:'123',worker:false,inputId:args[8].inputId};await new Promise(r=>{release=r;});return answer;};intake(service);const run=service.conversation();await waitFor(()=>cap);
 const a={sequence:1,text:'😀'.repeat(400)};assert.deepEqual(await service.tool(cap,'stream_reply',a),await service.tool(cap,'stream_reply',a));await assert.rejects(service.tool(cap,'stream_reply',{sequence:1,text:'different'}),/conflict/);await assert.rejects(service.tool(cap,'stream_reply',{sequence:3,text:'gap'}),/increase/);
 await service.tool(cap,'stream_reply',{sequence:2,text:'a'.repeat(4000)});const d=service.streams.active.get(cap.inputId);assert.ok(d.text.length<=3400);
 for(const scope of [{worker:true},{toolScope:'read'},{worker:true,memoryReview:true}])await assert.rejects(service.tool({...cap,...scope},'stream_reply',{sequence:3,text:'denied'}));
 let fallback=0,stopped=0;service.telegram.startTyping=()=>{fallback++;return ()=>{stopped++;};};service.telegram.draft=async()=>{throw new Error('synthetic unavailable');};await service.streams.flush(d,true);assert.equal(fallback,1);release();await run;assert.equal(stopped,1);await service.deliver();assert.ok(sent.some(c=>c.method==='sendMessage'&&c.body.text==='Synthetic answer'));
});

test('native Stop cancels only the exact active draft; duplicate, foreign, stale and wrong-topic controls are rejected',async t=>{
 const {service,store,router,agent,sent}=await fixture(t);let release,signal;
 agent.run=async(...args)=>{signal=args[4];return new Promise(r=>{release=r;});};intake(service);const run=service.conversation();await waitFor(()=>release);const d=[...service.streams.active.values()][0];
 for(const q of [...['+'+d.id,String(d.id)+'\n',String(d.id)+'\r\n','0'+d.id,String(d.id)+'.0',String(d.id)+'e0'].map(id=>stop(id)),stop('0'),stop('01'),stop('1e3'),stop('+1'),stop(' 1'),stop('9007199254740993'),stop(null),stop({}),stop(1.5),stop(d.id,30,{chat:{id:456,type:'private'}}),stop(d.id,30,{message_thread_id:77}),stop(d.id+1),stop(d.id,30,{chat:{id:123,type:'group'}})])assert.equal(await router.ingest(q),false);
 assert.equal(signal.aborted,false);assert.equal(await router.ingest(stop(String(d.id))),true);assert.equal(signal.aborted,true);assert.equal(await router.ingest(stop(String(d.id))),false);assert.equal(store.prepare('SELECT state FROM inputs WHERE $scope AND id=10').get().state,'cancel_requested');
 release({...answer,text:'forbidden late output'});await run;await service.deliver();assert.equal(store.prepare('SELECT state FROM inputs WHERE $scope AND id=10').get().state,'cancelled');assert.ok(!sent.some(c=>c.body.text?.includes('forbidden late output')));
 release=null;intake(service,11);const next=service.conversation();await waitFor(()=>release);assert.equal(await router.ingest(stop(String(d.id),31)),false);assert.equal(signal.aborted,false);release(answer);await next;
});

test('restart interrupts previews without replay; topic native drafts carry the original route',async t=>{
 const {service,router,agent,sent}=await fixture(t);await router.ingest({update_id:1,message:{from:{id:123},chat:{id:123,type:'private'},message_thread_id:77,forum_topic_created:{name:'Synthetic'}}});const topic=router.all().find(s=>s.cfg.topic);let release;
 agent.run=async()=>new Promise(r=>{release=r;});assert.equal(await router.ingest({update_id:10,message:{from:{id:123},chat:{id:123,type:'private'},message_thread_id:77,text:'Topic explanation'}}),true);
 const run=topic.conversation();await waitFor(()=>release);assert.equal(sent.find(c=>c.method==='sendMessageDraft').body.message_thread_id,77);const d=[...topic.streams.active.values()][0];
 assert.equal(await router.ingest(stop(String(d.id))),false);assert.equal(await router.ingest(stop(d.id,31,{message_thread_id:77})),true);release(answer);await run;
 service.store.db.prepare("INSERT INTO telegram_reply_drafts(draft_id,owner,conversation_id,session_id,input_id,state,created) VALUES (999,'123',?,?,123,'active',0)").run(service.store.get('conversation-id'),service.store.get('main-session'));const n=sent.length;service.streams.recover();assert.equal(sent.length,n);assert.equal(service.store.db.prepare('SELECT state FROM telegram_reply_drafts WHERE draft_id=999').get().state,'interrupted');
});
