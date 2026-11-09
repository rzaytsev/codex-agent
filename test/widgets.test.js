import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';
import {Conversations} from '../src/conversations.js';
import {Telegram,telegramUpdates,TelegramError} from '../src/telegram.js';
import {responsePayloads} from '../src/presentation.js';

const result={text:'Choose an explanation.',voice:false,files:[],presentation:{kind:'widget',content:'<button onclick="TelegramWidget.request(\'explain\')">Explain</button>',state:'{"selected":"none"}',actions:[{id:'explain',label:'Explain jitter',prompt:'Explain retry jitter briefly. Answer directly.'}]}};
async function fixture(t) {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'widgets-'));
 const cfg=config({WORKSPACE_DIR:workspace,CODEX_HOME:path.join(workspace,'codex'),TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',BROWSER_ENABLED:'false'});
 const store=new Store(path.join(workspace,'db')),sent=[],requests=[];let messageId=100;
 const telegram=new Telegram('unused');telegram.call=async(method,body)=>{sent.push({method,body});return method==='sendWidget'?{message_id:++messageId,chat:{id:123},widget:{},...(body.message_thread_id!==undefined?{message_thread_id:body.message_thread_id}:{})}:true;};
 const service=new Service(cfg,store,telegram,{run:async(_user,prompt)=>{requests.push(prompt);return {text:'Jitter spreads retries.',voice:false,files:[]};}});await service.init();
 const router=new Conversations(service,{agentFactory:()=>service.agent});service.conversations=router;router.setIdentity({username:'demo_bot',has_topics_enabled:true});
 t.after(async()=>{await router.stop();for(const s of router.all())s.store.db.close();await fs.rm(workspace,{recursive:true,force:true});});
 const publish=async(s=service)=>{await s.output('123',result);await s.deliver();return s.store.prepare('SELECT * FROM telegram_widgets WHERE $scope ORDER BY created DESC LIMIT 1').get();};
 const query=(row,id=20,patch={})=>({update_id:id,widget_query:{id:'query-'+id,from:{id:123},chat:{id:123,type:'private'},message_id:row.message_id,type:{type:'data'},data:'explain',...patch}});
 return {workspace,cfg,store,service,router,sent,requests,publish,query};
}

test('interactive metadata is bounded, allowlisted, and sent with initial live state',async t=>{
 const {publish,sent}=await fixture(t);const row=await publish();assert.ok(row);
 const call=sent.find(c=>c.method==='sendWidget');assert.equal(call.body.allow_queries,true);assert.equal(call.body.is_shared,false);assert.equal(JSON.parse(call.body.chat_data).data.selected,'none');assert.ok(telegramUpdates.includes('widget_query'));
 for(const presentation of [{...result.presentation,actions:[{id:'bad space',label:'x',prompt:'x'}]},{...result.presentation,actions:[...result.presentation.actions,...result.presentation.actions]},{...result.presentation,state:'[]'},{...result.presentation,state:JSON.stringify({value:'😀'.repeat(160)})}])assert.deepEqual(responsePayloads({...result,presentation}),[{text:result.text}]);
});

test('callback queues one source-bound agent event, promptly acknowledges, and updates the original widget',async t=>{
 const {store,service,router,sent,requests,publish,query}=await fixture(t),row=await publish();
 assert.equal(await router.ingest(query(row)),true);assert.equal(requests.length,0);assert.equal(sent.at(-1).method,'answerWidgetQuery');assert.equal(JSON.parse(sent.at(-1).body.data).accepted,true);
 assert.equal(await router.ingest(query(row)),false);assert.equal(store.prepare('SELECT count(*) AS n FROM inputs WHERE $scope').get().n,1);
 await service.deliver();assert.equal(JSON.parse(sent.at(-1).body.chat_data).status,'queued');
 await service.conversation();await service.deliver();
 assert.equal(requests.length,1);assert.match(requests[0],/Explain retry jitter/);assert.match(requests[0],/not typed owner text or approval/);
 const state=service.widgets.read({id:row.id});assert.equal(state.status,'completed');assert.equal(state.reply,'Jitter spreads retries.');assert.equal(store.historySource(store.search('123').find(r=>r.role==='event').id,'123'),'event');
 const edits=sent.filter(c=>c.method==='editMessageWidgetData');assert.ok(edits.length>=2);assert.ok(edits.every(c=>c.body.chat_id==='123'&&c.body.message_id===row.message_id));assert.equal(JSON.parse(edits.at(-1).body.chat_data).status,'completed');
});

test('foreign, inline, shared, wallet, unknown and stale controls cannot enter history or execute',async t=>{
 const {store,service,router,sent,publish,query}=await fixture(t),row=await publish();
 const patches=[{from:{id:456}},{from:{id:123,is_bot:true}},{chat:{id:456,type:'private'}},{chat:{id:123,type:'group'}},{inline_message_id:'foreign'},{widget_id:'shared'},{type:{type:'sent_transaction'}},{type:{type:'data',wallet:{}}},{message_id:999},{data:'/approve x'},{data:'unknown'}];
 for(let i=0;i<patches.length;i++)assert.equal(await router.ingest(query(row,30+i,patches[i])),false);
 assert.equal(store.prepare('SELECT count(*) AS n FROM inputs WHERE $scope').get().n,0);
 store.rotateSession('123');assert.equal(await router.ingest(query(row,50)),false);assert.equal(JSON.parse(sent.at(-1).body.data).error,'expired');
 assert.equal(store.search('123').length,1);await assert.rejects(service.tool({user:'123'},'widget_update',{id:row.id,state:'{}',expected_revision:0}));
});

test('busy click is rejected, stale revisions conflict, updates coalesce, and scope/role denials hold',async t=>{
 const {service,router,sent,publish,query}=await fixture(t),row=await publish();
 await router.ingest(query(row));assert.equal(await router.ingest(query(row,21)),false);assert.equal(JSON.parse(sent.at(-1).body.data).error,'busy');
 await assert.rejects(service.tool({user:'123',worker:true},'widget_read',{id:row.id}));
 await assert.rejects(service.tool({user:'123',toolScope:'read'},'widget_update',{id:row.id,state:'{}',expected_revision:1}));
 await assert.rejects(service.tool({user:'456'},'widget_read',{id:row.id}));
 await assert.rejects(service.tool({user:'123'},'widget_update',{id:row.id,state:'{}',expected_revision:0}));
 await service.tool({user:'123'},'widget_update',{id:row.id,state:'{"selected":"jitter"}',expected_revision:1});
 await service.deliver();const edits=sent.filter(c=>c.method==='editMessageWidgetData');assert.equal(edits.length,1);assert.equal(JSON.parse(edits[0].body.chat_data).data.selected,'jitter');
});

test('private-topic callbacks use the registered topic, retain queues on restart, and expire after reset',async t=>{
 const {cfg,store,service,router,sent,publish,query}=await fixture(t);
 await router.ingest({update_id:1,message:{message_id:1,from:{id:123},chat:{id:123,type:'private'},message_thread_id:77,forum_topic_created:{name:'Synthetic'}}});
 const topic=router.all().find(s=>s.cfg.topic),row=await publish(topic);
 assert.equal(await router.ingest(query(row)),true);await topic.init();await topic.conversation();await topic.deliver();
 assert.equal(topic.widgets.read({id:row.id}).status,'completed');assert.ok(sent.some(c=>c.method==='sendMessage'&&c.body.message_thread_id===77&&c.body.text.includes('Jitter')));
 router.setIdentity({username:'demo_bot',has_topics_enabled:false});assert.equal(await router.ingest(query(row,21)),false);
 router.setIdentity({username:'demo_bot',has_topics_enabled:true});await router.ingest(query(row,22));
 router.setIdentity({username:'demo_bot',has_topics_enabled:false});topic.store.prepare("UPDATE inputs SET state='processing' WHERE $scope AND id=22").run();await topic.init();
 router.setIdentity({username:'demo_bot',has_topics_enabled:true});assert.equal(topic.widgets.read({id:row.id}).status,'interrupted');
 await router.ingest(query(row,23));topic.store.rotateSession('123');await topic.conversation();assert.equal(topic.store.prepare('SELECT state FROM inputs WHERE $scope AND id=23').get().state,'rejected');
});

test('recovery marks interrupted callback state without replaying the agent or unknown sends',async t=>{
 const {store,service,router,publish,query,requests}=await fixture(t),row=await publish();
 await router.ingest(query(row));store.prepare("UPDATE inputs SET state='processing' WHERE $scope AND id=20").run();
 await service.init();assert.equal(service.widgets.read({id:row.id}).status,'interrupted');await service.conversation();assert.equal(requests.length,0);
 service.telegram.call=async()=>{throw new TelegramError('network');};await service.deliver();
 assert.ok(store.prepare("SELECT id FROM outbox WHERE $scope AND state='uncertain'").get());
 await service.init();assert.equal(requests.length,0);
});
