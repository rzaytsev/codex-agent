import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readUsage,normalizeUsage,formatUsage,isUsageLimit,UsageLimitError} from '../src/usage.js';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';
import {Agent} from '../src/agent.js';
const raw={accountId:'must-not-leak',rateLimits:{primary:{usedPercent:1}},rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:100,windowDurationMins:300,resetsAt:1790791200},secondary:{usedPercent:20,windowDurationMins:10080,resetsAt:1790877600}}}};
test('usage reports multi-bucket remaining percentages and timezone resets without secrets',()=>{
 const usage=normalizeUsage(raw);const text=formatUsage(usage,'Europe/Madrid');
 assert.match(text,/0% remaining/);assert.match(text,/80% remaining/);assert.match(text,/Europe\/Madrid/);assert.doesNotMatch(text,/99%|must-not-leak/);
 assert.match(formatUsage(normalizeUsage({rateLimits:{}}),'Europe/Madrid'),/unavailable/);
 assert.match(formatUsage(normalizeUsage({rateLimits:{primary:{usedPercent:150}}}),'Europe/Madrid'),/0% remaining/);
 assert(isUsageLimit({codexErrorInfo:'UsageLimitExceeded'}));assert(isUsageLimit(new Error("You've hit your usage limit. Try again later")));assert(!isUsageLimit(new Error('HTTP 429 too many requests')));assert(!isUsageLimit(new Error('ContextWindowExceeded')));
});
test('account RPC handshakes, normalizes data and fails safely on timeout/error',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'usage-rpc-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const binary=path.join(dir,'rpc');
 await fs.writeFile(binary,`#!/usr/bin/env node\nconst rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,result:${JSON.stringify(raw)}}));});`,{mode:0o700});
 const usage=await readUsage({codexHome:dir},{binary});assert.equal(usage.buckets[0].windows[0].usedPercent,100);assert.equal(usage.accountId,undefined);
 await fs.writeFile(binary,'#!/usr/bin/env node\nsetInterval(()=>{},1000);',{mode:0o700});
 await assert.rejects(readUsage({codexHome:dir},{binary,timeoutMs:100}),/unavailable/);
 await fs.writeFile(binary,`#!/usr/bin/env node\nprocess.stdin.on('data',()=>console.log(JSON.stringify({id:1,error:{message:'private-secret'}})));`,{mode:0o700});
 await assert.rejects(readUsage({codexHome:dir},{binary}),error=>/unavailable/.test(error.message)&&!error.message.includes('private-secret'));
});
async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'usage-service-'));const cfg=config({WORKSPACE_DIR:dir,TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',BROWSER_ENABLED:'false'});const store=new Store(path.join(dir,'db'));
 const service=new Service(cfg,store,{}, {run:async()=>{throw new UsageLimitError();}},async()=>normalizeUsage(raw));await service.init();
 t.after(()=>{store.db.close();return fs.rm(dir,{recursive:true,force:true});});return {dir,cfg,store,service};
}
const update=(id,text)=>({update_id:id,message:{message_id:id,from:{id:123},chat:{id:123,type:'private'},text}});
test('/usage works without a model login or model call; quota failures give reset times and never replay',async t=>{
 const {store,service}=await fixture(t);
 service.ingest(update(1,'hello'));service.ingest(update(2,'/usage'));
 await service.conversation(false);assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=2').get().state,'done');assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=1').get().state,'pending');
 await service.conversation();assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=1').get().state,'failed');
 const messages=store.db.prepare('SELECT payload FROM outbox').all().map(r=>JSON.parse(r.payload).text).join('\n');assert.match(messages,/usage limit reached/);assert.match(messages,/resets /);
 const before=store.db.prepare('SELECT count(*) AS n FROM outbox').get().n;await service.conversation();assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,before);
 const id=store.job('123','test');store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
 await service.runJob({...store.jobs('123')[0],user:'123',prompt:'test'},new AbortController());assert.equal(store.jobs('123')[0].state,'failed');
 service.usageReader=async()=>{throw new Error('private-secret');};assert.match(await service.usageText(true),/reset times are unavailable/);assert.doesNotMatch(await service.usageText(true),/private-secret/);
});
test('SDK streamed and thrown quota failures are classified and capability released',async t=>{
 const {cfg,store}=await fixture(t);let releases=0;const capability=()=> 'cap';capability.release=()=>releases++;
 for(const event of [{type:'turn.failed',error:{message:"You've hit your usage limit."}},{type:'error',message:'usage_limit_reached'}]) {
  const agent=new Agent(cfg,store,capability,()=>({startThread:()=>({runStreamed:async()=>({events:(async function*(){yield event;})()})})}));
  await assert.rejects(agent.run('123','hello'),UsageLimitError);
 }
 const agent=new Agent(cfg,store,capability,()=>({startThread:()=>({runStreamed:async()=>{throw new Error('UsageLimitExceeded');}})}));
 await assert.rejects(agent.run('123','hello'),UsageLimitError);assert.equal(releases,3);
});
