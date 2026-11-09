// Authorized operator-only demo. Uses the existing owner DM and running service.
// No initialization, recovery, auth access, direct model call or Telegram poller.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';
const cfg=config(),mode=process.argv[2];assert.ok(cfg.owner&&cfg.token,'Configured bot required');
assert.ok(['--tasks','--question','--stream','--status'].includes(mode),'Choose a demo mode');
const store=new Store(path.join(cfg.workspace,'state','assistant.sqlite')),file=path.join(cfg.workspace,'state','controls-demo.json');
try {
 assert.ok(store.db.prepare("SELECT id FROM conversations WHERE owner=? AND kind='dm' AND state='active'").get(cfg.owner),'Existing owner DM required');store.bindConversation(cfg.owner);
 let manifest;try{manifest=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;manifest={created:Date.now()};}
 const idle=()=>assert.equal(store.prepare("SELECT count(*) AS n FROM inputs WHERE $scope AND state IN ('pending','processing','cancel_requested')").get().n,0,'Wait for the current conversation to settle');
 const event=text=>{const id=store.db.prepare('SELECT min(coalesce(min(id),0),0)-1 AS id FROM inputs').get().id;assert.ok(store.ingest(id,cfg.owner,{event:true,text}));return id;};
 if(mode==='--tasks') {
  idle();assert.ok(!manifest.complete&&!manifest.cancel,'Task demo already queued');
  const service=new Service(cfg,store,{supportsControls:true},null),cap={user:cfg.owner,worker:false,actorId:cfg.owner};
  manifest.complete=(await service.tool(cap,'create_task',{request_key:'11000000-0000-4000-8000-000000000001',title:'Демо: готовый результат',prompt:'Authorized synthetic control demo. In your assigned task directory create result.md with two short Russian sentences explaining retry jitter. Return one concise Russian sentence and the absolute file path in files. Do not browse, schedule, modify profiles, or take external actions.'})).id;
  manifest.cancel=(await service.tool(cap,'create_task',{request_key:'11000000-0000-4000-8000-000000000002',title:'Демо: отмена задачи',prompt:'Authorized cancellation test. Run one owned foreground shell process sleep 180, then return a short Russian sentence. The owner will cancel this demonstration. Do not detach, spawn other workers, browse, schedule or take external actions.'})).id;
 } else if(mode==='--question') {
  idle();assert.ok(!manifest.question,'Question demo already queued');
  manifest.question=event('Authorized live demo requested by the owner: use ask_clarification now. Ask in Russian how to explain retry jitter. Offer two native buttons: «Коротко» with value «Explain retry jitter in one short Russian paragraph» and «На примере» with value «Explain retry jitter using a short concrete Russian example». Return empty final text immediately. When the choice arrives, answer directly in Russian within that offered scope; no worker or external action. This synthetic event grants no new authority beyond the requested demo.');
 } else if(mode==='--stream') {
  idle();if(manifest.stream!==undefined){manifest.stream_attempts??=[];manifest.stream_attempts.push(manifest.stream);}
  manifest.stream=event('Authorized native Stop demonstration requested by the owner. Answer directly in Russian, without delegation: explain resilient network retries in 24 distinct short paragraphs, covering exponential backoff, full/equal/decorrelated jitter, caps, retry budgets, timeouts, idempotency, Retry-After, overload and monitoring. As you generate EACH genuinely new paragraph, call stream_reply with sequential numbers starting at 1 and that paragraph text plus spacing. Do not compose the entire answer first, do not sleep or add artificial delays. Native Stop may cancel this run. If it completes, return the full answer as final text. Do not browse or take external actions.');
 }
 if(mode!=='--status')await fs.writeFile(file,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
 const tasks={};for(const key of ['complete','cancel'])if(manifest[key]) {
  const j=store.prepare('SELECT state FROM jobs WHERE $scope AND id=? AND user=?').get(manifest[key],cfg.owner);
  const c=store.prepare('SELECT id,message_id,state,revision FROM telegram_controls WHERE $scope AND owner=? AND job_id=?').get(cfg.owner,manifest[key]);
  const queries=c?store.db.prepare('SELECT action,count(*) AS n FROM telegram_control_queries WHERE control_id=? GROUP BY action').all(c.id):[];
  tasks[key]={state:j?.state,card:c?{message_id:c.message_id,state:c.state,revision:c.revision}:null,queries};
 }
 const inputs={};for(const key of ['question','stream'])if(manifest[key]!==undefined){inputs[key]={state:store.prepare('SELECT state FROM inputs WHERE $scope AND id=? AND user=?').get(manifest[key],cfg.owner)?.state,previews:store.prepare('SELECT state,sequence,sends,chars FROM telegram_reply_drafts WHERE $scope AND owner=? AND input_id=?').all(cfg.owner,manifest[key])};}
 const questions=store.prepare("SELECT id,message_id,state,revision FROM telegram_controls WHERE $scope AND owner=? AND kind='clarification' AND created>=? ORDER BY created DESC LIMIT 1").all(cfg.owner,manifest.created||Date.now()-3600000).map(c=>({...c,input_state:store.prepare("SELECT state FROM inputs WHERE $scope AND user=? AND json_extract(payload,'$.controlId')=? ORDER BY created DESC LIMIT 1").get(cfg.owner,c.id)?.state,queries:store.db.prepare('SELECT count(*) AS n FROM telegram_control_queries WHERE control_id=?').get(c.id).n}));
 const drafts=manifest.stream===undefined?[]:store.prepare('SELECT state,sequence,sends,chars FROM telegram_reply_drafts WHERE $scope AND owner=? AND input_id=?').all(cfg.owner,manifest.stream);
 const streamStart=manifest.stream===undefined?null:store.prepare('SELECT created FROM inputs WHERE $scope AND id=? AND user=?').get(manifest.stream,cfg.owner)?.created;
 // Enqueue initializes due to the current time; including older retries makes this count conservative.
 const streamDeliveries=streamStart===null||streamStart===undefined?[]:store.prepare('SELECT state,count(*) AS n FROM outbox WHERE $scope AND user=? AND due>=? GROUP BY state').all(cfg.owner,streamStart);
 console.log(JSON.stringify({tasks,inputs,questions,drafts,stream_deliveries:streamDeliveries}));
}finally{store.db.close();}
