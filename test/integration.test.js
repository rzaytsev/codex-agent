import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Codex } from '@openai/codex-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Agent } from '../src/agent.js';
import { Mailbox } from '../src/mailbox.js';
const exec=promisify(execFile);
test('real MCP stdio handshake routes tools with user capability and worker restriction',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-mcp-'));
 const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',WORKSPACE_DIR:dir,MAILBOX_ID:'alpha',MAILBOX_URL:'http://mailbox:8766',MAILBOX_TOKEN:'a'.repeat(32)});const store=new Store(path.join(dir,'state.sqlite'));
 const service=new Service(cfg,store,{},{});await service.init();await service.listen();
 const broker=new Mailbox(':memory:',{identities:{alpha:{token:'a'.repeat(32),peers:['beta']},beta:{token:'b'.repeat(32),peers:['alpha']}}});
 service.mail.request=async(url,token,operation,args)=>broker.request(broker.authenticate(token),operation,args);
 t.after(async()=>{await new Promise(r=>service.server.close(r));store.db.close();broker.db.close();await fs.rm(dir,{recursive:true,force:true});});
 for(const [worker,review] of [[false,false],[true,false],[true,true]]) {
  const cap=service.capability('123',worker,review);
  const transport=new StdioClientTransport({command:'node',args:[path.resolve('src/mcp.js')],env:{PATH:process.env.PATH,ASSISTANT_CAPABILITY:cap,ASSISTANT_WORKER:String(worker),ASSISTANT_MEMORY_REVIEW:String(review)}});
  const client=new Client({name:'integration-test',version:'1.0.0'});
  await client.connect(transport);
  try {
   const tools=await client.listTools();assert.equal(tools.tools.length,review?11:worker?14:32);assert.equal(tools.tools.some(tool=>tool.name==='mail_send'),!worker);assert.equal(tools.tools.some(tool=>tool.name==='send_voice'),!worker);assert(tools.tools.some(tool=>tool.name==='memory_search'));assert(tools.tools.some(tool=>tool.name==='memory_explain'));assert(tools.tools.some(tool=>tool.name==='memory_forget_preview'));assert(tools.tools.some(tool=>tool.name==='learning_read'));assert.equal(tools.tools.some(tool=>tool.name==='learning_feedback'),!worker);assert.equal(tools.tools.some(tool=>tool.name==='memory_save'),!review);assert.equal(tools.tools.some(tool=>tool.name==='memory_forget'),!worker);
   assert(tools.tools.some(tool=>tool.name==='profile_read'));assert.equal(tools.tools.some(tool=>tool.name==='profile_patch'),!worker);assert.equal(tools.tools.some(tool=>tool.name==='profile_write'),!worker);
   for(const name of ['profile_read','memory_search','task_status'])assert.equal(tools.tools.find(tool=>tool.name===name).annotations?.readOnlyHint,true);
   for(const name of ['memory_save','profile_patch','create_task','mail_send','mail_commit']) {const tool=tools.tools.find(tool=>tool.name===name);if(tool)assert.equal(tool.annotations?.readOnlyHint,false);}
   const profileResult=await client.callTool({name:'profile_read',arguments:{file:'USER.md'}});assert.equal(profileResult.isError,false);
   const snapshot=JSON.parse(profileResult.content[0].text);assert.match(snapshot.hash,/^[a-f0-9]{64}$/);
   if(!worker) {
    const changed=await client.callTool({name:'profile_write',arguments:{file:'USER.md',content:'Synthetic profile'}});assert.equal(changed.isError,false);assert.equal(JSON.parse(changed.content[0].text).updated,'USER.md');
    const stale=await client.callTool({name:'profile_patch',arguments:{file:'USER.md',expected_hash:snapshot.hash,old_text:'Synthetic',new_text:'Updated'}});assert.equal(stale.isError,false);assert.equal(JSON.parse(stale.content[0].text).conflict,true);
    const current=JSON.parse((await client.callTool({name:'profile_read',arguments:{file:'USER.md'}})).content[0].text);
    const patched=await client.callTool({name:'profile_patch',arguments:{file:'USER.md',expected_hash:current.hash,old_text:'Synthetic',new_text:'Updated'}});assert.equal(patched.isError,false);assert.equal(JSON.parse(patched.content[0].text).updated,'USER.md');
    assert.equal((await client.callTool({name:'profile_patch',arguments:{file:'USER.md',old_text:'Updated',new_text:'Missing hash'}})).isError,true);
   }
   const searchSchema=tools.tools.find(tool=>tool.name==='memory_search').inputSchema.properties;
   const readSchema=tools.tools.find(tool=>tool.name==='memory_read').inputSchema.properties;
   for(const name of ['entity','project','as_of']){assert.ok(searchSchema[name]);assert.ok(readSchema[name]);}
   if(!review) {
    const saveSchema=tools.tools.find(tool=>tool.name==='memory_save').inputSchema.properties;assert.equal(saveSchema.restore,undefined);
    for(const name of ['observed_at','valid_from','valid_to','review_after','entity','project'])assert.ok(saveSchema[name]);
    const key=worker?'worker-memory':'main-memory';
    const saved=await client.callTool({name:'memory_save',arguments:{key,category:'facts',title:'Temporal',content:'Cobalt evidence',certainty:'confirmed',sources:['https://example.com/'],expected_revision:0,entity:'Traveler',project:'Launch',valid_from:'2026-06-01T00:00:00Z',valid_to:'2026-07-01T00:00:00Z'}});
    assert.equal(saved.isError,false);assert.equal(JSON.parse(saved.content[0].text).entry.project,'Launch');
   }
   const recalled=await client.callTool({name:'memory_search',arguments:{query:'cobalt',entity:'Traveler',project:'Launch',as_of:'2026-06-15T00:00:00Z'}});
   assert.equal(recalled.isError,false);assert.ok(JSON.parse(recalled.content[0].text).entries.length);
   const excluded=await client.callTool({name:'memory_read',arguments:{key:'main-memory',as_of:'2026-07-01T00:00:00Z'}});
   assert.equal(excluded.isError,false);assert.equal(JSON.parse(excluded.content[0].text),null);
   const invalid=await client.callTool({name:'memory_search',arguments:{as_of:'2026-06-01T00:00:00'}});assert.equal(invalid.isError,true);
   const result=await client.callTool({name:'task_status',arguments:{}});assert.equal(result.isError,false);
   assert.equal((await client.callTool({name:'history_search',arguments:{query:'',extra:'malicious'}})).isError,true);
   const rejected=await fetch('http://127.0.0.1:8765/tool',{method:'POST',headers:{authorization:`Bearer ${cap}`,'content-type':'application/json'},body:JSON.stringify({name:'history_search',args:{query:'',extra:'malicious'}})});assert.equal(rejected.status,400);
   const extraEnvelope=await fetch('http://127.0.0.1:8765/tool',{method:'POST',headers:{authorization:`Bearer ${cap}`,'content-type':'application/json'},body:JSON.stringify({name:'task_status',args:{},owner:'456'})});assert.equal(extraEnvelope.status,400);
   if(!worker) {
    const memoryArgs={key:'forgotten-test',category:'facts',title:'Test',content:'Synthetic evidence',certainty:'confirmed',sources:['https://example.com/evidence'],expected_revision:0};
    assert.equal((await client.callTool({name:'memory_save',arguments:memoryArgs})).isError,false);
    assert.equal((await client.callTool({name:'memory_forget',arguments:{key:memoryArgs.key}})).isError,false);
    assert.equal((await client.callTool({name:'memory_save',arguments:{...memoryArgs,restore:true}})).isError,true);
    assert.equal(service.memory.get(memoryArgs.key),null);
    assert.ok(tools.tools.find(tool=>tool.name==='create_task').inputSchema.properties.request_key);
    const taskArgs={prompt:'test objective',profile:'research',acknowledgment:'Хорошо, ищу рестораны.',request_key:'synthetic-mcp-admission'};
    const created=await client.callTool({name:'create_task',arguments:taskArgs});
    assert.equal(created.isError,false);assert.equal(store.jobs('123')[0].profile,'research');
    assert.equal(store.get(`task-acknowledgment:${store.jobs('123')[0].id}`),'Хорошо, ищу рестораны.');
    const retried=await client.callTool({name:'create_task',arguments:taskArgs});assert.deepEqual(retried,created);assert.equal(store.jobs('123').length,1);
    const conflict=await client.callTool({name:'create_task',arguments:{...taskArgs,prompt:'Different objective'}});assert.equal(conflict.isError,true);assert.match(conflict.content[0].text,/Admission conflict/);
    const scheduleArgs={kind:'reminder',prompt:'Synthetic scheduled reminder',due:new Date(Date.now()+60000).toISOString(),key:'synthetic-mcp-admission'};
    const scheduled=await client.callTool({name:'schedule',arguments:scheduleArgs});assert.equal(scheduled.isError,false);
    assert.deepEqual(await client.callTool({name:'schedule',arguments:scheduleArgs}),scheduled);
    assert.equal((await client.callTool({name:'schedule',arguments:{...scheduleArgs,prompt:'Different reminder'}})).isError,true);
    const sent=await client.callTool({name:'mail_send',arguments:{id:'mcp-message-test',to:'beta',kind:'message',text:'Hello from the tool'}});
    assert.equal(sent.isError,false);const prepared=JSON.parse(sent.content[0].text);
    service.ingest({update_id:9876,message:{text:`/approve ${prepared.approval_id} ${prepared.hash}`,from:{id:123},chat:{id:123,type:'private'}}});
    const committed=await client.callTool({name:'mail_commit',arguments:{id:'mcp-message-test',to:'beta',kind:'message',text:'Hello from the tool',approval_id:prepared.approval_id}});assert.equal(committed.isError,false);await service.mail.tick(true);
    assert.equal(broker.request('beta','inbox').messages[0].text,'Hello from the tool');
   }
  } finally {await client.close();}
 }
});
test('actual Codex SDK subprocess accepts structured events, persists thread ID and isolates environment',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-sdk-'));
 const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',WORKSPACE_DIR:dir,CODEX_HOME:path.join(dir,'codex')});const store=new Store(path.join(dir,'state.sqlite'));
 const service=new Service(cfg,store,{},{});await service.init();
 cfg.pythonEnv={PATH:process.env.PATH,VIRTUAL_ENV:path.join(dir,'state','python'),UV_CACHE_DIR:path.join(dir,'state','uv-cache')};
 t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
 const binary=path.join(dir,'fake-codex');
 await fs.writeFile(binary,`#!/usr/bin/env node\nif(process.env.TELEGRAM_BOT_TOKEN)process.exit(9);process.stdin.resume();process.stdin.on('end',()=>{for(const event of [{type:'thread.started',thread_id:'test-thread'},{type:'item.completed',item:{type:'agent_message',id:'1',text:JSON.stringify({text:'SDK checked',voice:false,files:[]})}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}}])console.log(JSON.stringify(event));});\n`,{mode:0o700});
 let options;const capability=(...args)=>service.capability(...args);capability.release=t=>service.releaseCapability(t);
 const agent=new Agent(cfg,store,capability,o=>{options=o;return new Codex({...o,codexPathOverride:binary});});
 const result=await agent.run('123','hello','main');assert.equal(result.text,'SDK checked');assert.equal(store.get('thread:123'),'test-thread');
 assert.equal(options.env.TELEGRAM_BOT_TOKEN,undefined);assert.equal(options.apiKey,undefined);assert.equal(options.config.forced_login_method,'chatgpt');assert(options.configOverrides.some(o=>o.startsWith('mcp_servers.browser=')&&o.includes('--isolated')&&o.includes('--headless')));assert.equal(service.capabilities.size,0);
 assert.equal(options.env.VIRTUAL_ENV,cfg.pythonEnv.VIRTUAL_ENV);assert.equal(options.env.UV_CACHE_DIR,cfg.pythonEnv.UV_CACHE_DIR);
});
test('SQLite backup restores history, jobs and pending reminders',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-backup-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const source=path.join(dir,'state.sqlite');const target=path.join(dir,'snapshot.sqlite');const store=new Store(source);
 store.history('123','user','remember me');const job=store.admit('123','task','synthetic-backup-key',{prompt:'unfinished'},()=>({id:store.job('123','unfinished')})).id;store.db.prepare('INSERT INTO schedules(id,user,kind,prompt,timezone,due) VALUES (?,?,?,?,?,?)').run('r','123','reminder','hello','Europe/Madrid',Date.now()+60000);
 await exec('node',[path.resolve('scripts/backup.js'),source,target]);store.db.close();
 const restored=new Store(target);assert.equal(restored.search('123')[0].text,'remember me');assert.equal(restored.jobs('123')[0].id,job);assert.equal(restored.db.prepare('SELECT count(*) AS n FROM schedules').get().n,1);assert.deepEqual(restored.admit('123','task','synthetic-backup-key',{prompt:'unfinished'},()=>{throw new Error('Must retain admission');}),{id:job});restored.db.close();
});
test('unconfigured main process starts in setup mode with an empty database',async t=>{
 const {spawn}=await import('node:child_process');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-entry-'));
 const child=spawn('node',['src/main.js'],{env:{...process.env,TELEGRAM_BOT_TOKEN:'',TELEGRAM_ALLOWED_USER_IDS:'',WORKSPACE_DIR:dir,CODEX_HOME:path.join(dir,'codex')},stdio:'ignore'});
 t.after(async()=>{child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);});await fs.rm(dir,{recursive:true,force:true});});
 let health;
 for(let i=0;i<50;i++) {try {health=await (await fetch('http://127.0.0.1:8765/health')).json();if(health.status==='setup:telegram')break;}catch {}await new Promise(r=>setTimeout(r,50));}
 assert.equal(health.status,'setup:telegram');
 const store=new Store(path.join(dir,'state/assistant.sqlite'));assert.equal(store.db.prepare('SELECT count(*) AS n FROM inputs').get().n,0);store.db.close();
});
