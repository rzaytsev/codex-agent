import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Codex} from '@openai/codex-sdk';
import {superviseSdk,ExecutionUnknown} from '../src/supervised-exec.js';
import {validateOutcome,outcomeRecord} from '../src/outcomes.js';
import {Agent,responseSchema} from '../src/agent.js';
import {Service} from '../src/service.js';
import {Store} from '../src/store.js';
import {config} from '../src/config.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<400;i++){if(await fn())return;await pause(10);}assert.fail('Synthetic fixture did not settle');}
async function fixture(t,source){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'owned-task-outcome-')),binary=path.join(dir,'fixture');
 await fs.writeFile(binary,`#!${process.execPath}\n${source}`,{mode:0o700});
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 return {dir,binary,options:{codexPathOverride:binary,env:{PATH:path.dirname(process.execPath),HOME:dir,CODEX_HOME:dir}}};
}
const completed="console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}}));";

test('provider response schema requires every object property and represents optional metadata with null',()=>{
 const check=s=>{
  if(s.type==='object') {assert.deepEqual([...s.required].sort(),Object.keys(s.properties).sort());assert.equal(s.additionalProperties,false);for(const child of Object.values(s.properties))check(child);}
  if(s.items)check(s.items);
  for(const child of s.anyOf||[])check(child);
 };
 check(responseSchema);
 for(const field of ['outcome','checkpoint'])assert(responseSchema.properties[field].anyOf.some(s=>s.type==='null'));
 assert.equal(outcomeRecord({outcome:null,checkpoint:null}).goal,'unknown');
 assert.equal(outcomeRecord({}).goal,'unknown'); // Retained legacy results remain readable.
});

test('pinned SDK ignored-SIGTERM early return control stays alive; supervised Agent waits for actual exit',async t=>{
 const f=await fixture(t,`const fs=require('node:fs');fs.writeFileSync(process.env.HOME+'/pid',String(process.pid));process.on('SIGTERM',()=>{});process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-thread'}));setInterval(()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'late'}})),20);});`);
 let pid; t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}});
 const rawCtrl=new AbortController(),raw=await new Codex(f.options).startThread().runStreamed('synthetic',{signal:rawCtrl.signal});
 await assert.rejects(async()=>{for await(const event of raw.events){if(event.type==='thread.started'){rawCtrl.abort();rawCtrl.signal.throwIfAborted();}}});
 pid=Number(await fs.readFile(path.join(f.dir,'pid'),'utf8'));assert.doesNotThrow(()=>process.kill(pid,0));process.kill(pid,'SIGKILL');pid=undefined;
 const cfg=config({WORKSPACE_DIR:f.dir,CODEX_HOME:path.join(f.dir,'codex'),TELEGRAM_ALLOWED_USER_IDS:'123',BROWSER_ENABLED:'false',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false'}),store=new Store(path.join(f.dir,'db')),service=new Service(cfg,store,{},{});await service.init();
 const cap=(...args)=>service.capability(...args);cap.release=x=>service.releaseCapability(x);
 const agent=new Agent(cfg,store,cap,o=>new Codex({...o,...f.options}));const ctrl=new AbortController();
 const start=performance.now();await assert.rejects(agent.run('123','synthetic','worker',[],ctrl.signal,()=>ctrl.abort()),{name:'AbortError'});
 pid=Number(await fs.readFile(path.join(f.dir,'pid'),'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});pid=undefined;
 assert.ok(performance.now()-start>=200);assert.ok(performance.now()-start<5000);assert.equal(service.capabilities.size,0);
 assert.equal(store.db.prepare('SELECT terminal FROM run_observations').get().terminal,'cancelled');store.db.close();
});

test('pinned SDK supervision preserves argv/config/environment/schema/input and fresh/resumed thread semantics',async t=>{
 const f=await fixture(t,`const fs=require('node:fs');let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{const argv=process.argv.slice(2),i=argv.indexOf('--output-schema'),schema=i<0?null:JSON.parse(fs.readFileSync(argv[i+1]));if(i>=0)argv[i+1]='SCHEMA_FILE';console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({argv,schema,input,env:process.env})}}));${completed}});`);
 const options={...f.options,config:{forced_login_method:'chatgpt',nested:{empty:{},list:['a',{quoted_key:true}],skip:undefined},developer_instructions:'Synthetic\n"quoted"'},configOverrides:['mcp_servers={}','features.apps=false']};
 const opts={workingDirectory:f.dir,skipGitRepoCheck:true,model:'synthetic',modelReasoningEffort:'high',webSearchMode:'disabled',approvalPolicy:'never',additionalDirectories:[f.dir],networkAccessEnabled:false,threadSource:'synthetic'};
 for(const resumed of [false,true])for(const sandboxMode of [undefined,'read-only']){
  const run=async supervised=>{let sdk=new Codex(options);if(supervised)sdk=superviseSdk(sdk);const thread=resumed?sdk.resumeThread('synthetic-thread',{...opts,sandboxMode}):sdk.startThread({...opts,sandboxMode});const result=await thread.run([{type:'text',text:'synthetic input'},{type:'local_image',path:'/synthetic/image'}],{outputSchema:{type:'object'}});return JSON.parse(result.finalResponse);};
  const original=await run(false),supervised=await run(true);assert.deepEqual(supervised,original);assert.equal(supervised.argv.includes('--sandbox'),Boolean(sandboxMode));
 }
});

test('malformed SDK parser output also waits for owned child exit and hides subprocess stderr',async t=>{
 const f=await fixture(t,`const fs=require('node:fs');fs.writeFileSync(process.env.HOME+'/pid',String(process.pid));process.on('SIGTERM',()=>{});process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('PRIVATE_STDERR_CANARY');console.log('invalid');setInterval(()=>{},1000);});`);
 await assert.rejects(superviseSdk(new Codex(f.options)).startThread().run('synthetic'));
 const pid=Number(await fs.readFile(path.join(f.dir,'pid'),'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('unsupported pinned integration shape fails before execution',()=>{
 const sdk=new Codex({env:{}});sdk.exec.pathDirs=null;assert.throws(()=>superviseSdk(sdk),/boundary failed/);
});

test('bounded opt-in model outcomes never mint host verification and legacy replies remain unknown',()=>{
 assert.deepEqual(outcomeRecord({}).goal,'unknown');
 const outcome={status:'achieved',checks:['synthetic check'],evidence:['synthetic evidence'],limitations:[]};
 assert.equal(outcomeRecord({outcome}).authority,'model_reported');assert.equal(outcomeRecord({outcome}).host_verified,false);
 for(const value of [{...outcome,host_verified:true},{...outcome,status:'success'},{...outcome,checks:Array(17).fill('a')},{...outcome,evidence:['a'.repeat(2001)]}])assert.throws(()=>validateOutcome({outcome:value}));
 for(const checkpoint of [{plan_version:0,last_verified_milestone:'',next_safe_step:'',unresolved_effects:[]},{plan_version:1,last_verified_milestone:'',next_safe_step:'',unresolved_effects:[],extra:true}])assert.throws(()=>validateOutcome({checkpoint}));
});

test('unverified exit remains requested, no publication or replay, and reserves capacity',async t=>{
 const f=await fixture(t,''),cfg=config({WORKSPACE_DIR:f.dir,TELEGRAM_ALLOWED_USER_IDS:'123',BROWSER_ENABLED:'false',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MAX_WORKERS:'1'}),store=new Store(path.join(f.dir,'db')),service=new Service(cfg,store,{}, {run:async()=>{throw new ExecutionUnknown();}});await service.init();
 const id=store.job('123','synthetic');service.workers();await until(()=>!service.controllers.has(id));
 assert.equal(store.jobs('123')[0].state,'cancel_requested');assert.equal(store.db.prepare('SELECT terminal FROM run_observations').get().terminal,'execution_unknown');
 const next=store.job('123','fresh intent');service.workers();assert.equal(store.jobs('123').find(j=>j.id===next).state,'queued');assert.equal(store.db.prepare('SELECT count(*) n FROM outbox').get().n,0);store.db.close();
});

test('owned media child ignoring SIGTERM cannot settle cancellation before process exit',async t=>{
 const {ownedExec}=await import('../src/owned-process.js');
 const f=await fixture(t,`const fs=require('node:fs');fs.writeFileSync(process.env.HOME+'/pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`),ctrl=new AbortController();
 const running=ownedExec(f.binary,[],{signal:ctrl.signal,env:f.options.env});
 await until(()=>fs.access(path.join(f.dir,'pid')).then(()=>true,()=>false));
 const pid=Number(await fs.readFile(path.join(f.dir,'pid'),'utf8'));let settled=false;const rejected=assert.rejects(running,{name:'AbortError'}).then(()=>{settled=true;});
 ctrl.abort();await pause(30);assert.equal(settled,false);assert.doesNotThrow(()=>process.kill(pid,0));await rejected;assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('unknown exit takes precedence over budget telemetry and cancellation over late quota',async()=>{
 const {Observations,terminalReason,BudgetError}=await import('../src/observations.js');const {UsageLimitError}=await import('../src/usage.js');const store=new Store(':memory:'),ctrl=new AbortController(),o=new Observations(store),run=o.run({},ctrl);ctrl.abort(new BudgetError());o.finishRun(run,'execution_unknown');assert.equal(store.db.prepare('SELECT terminal FROM run_observations').get().terminal,'execution_unknown');store.db.close();const cancel=new AbortController();cancel.abort();assert.equal(terminalReason(new UsageLimitError(),cancel.signal),'cancelled');
});

test('Agent drains revoked in-flight voice tools before final logical observation',async t=>{
 const f=await fixture(t,''),cfg=config({WORKSPACE_DIR:f.dir,TELEGRAM_ALLOWED_USER_IDS:'123',BROWSER_ENABLED:'false',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false'}),store=new Store(path.join(f.dir,'db')),service=new Service(cfg,store,{},{});await service.init();
 const bin=path.join(f.dir,'bin'),marker=path.join(f.dir,'voice-pid');await fs.mkdir(bin);const original=process.env.PATH;t.after(()=>{process.env.PATH=original;store.db.close();});
 await fs.writeFile(path.join(bin,'espeak-ng'),`#!${process.execPath}\nconst fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,{mode:0o700});process.env.PATH=bin+path.delimiter+original;
 const capability=(...args)=>service.capability(...args);capability.release=t=>service.releaseCapability(t);let voiceFailure;
 const sdkFactory=()=>({startThread:()=>({runStreamed:async()=>({events:async function*(){
  const cap=[...service.capabilities.values()][0];voiceFailure=assert.rejects(service.tool(cap,'send_voice',{text:'synthetic voice'}),{name:'AbortError'});
  await until(()=>fs.access(marker).then(()=>true,()=>false));
  yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'complete',voice:false,files:[]})}};yield {type:'turn.completed'};
 }()})})});
 const agent=new Agent(cfg,store,capability,sdkFactory);let returned=false;const run=agent.run('123','synthetic').then(x=>{returned=true;return x;});
 await until(()=>fs.access(marker).then(()=>true,()=>false));await pause(30);assert.equal(returned,false);assert.equal(store.db.prepare('SELECT terminal FROM run_observations').get().terminal,null);
 await run;await voiceFailure;const pid=Number(await fs.readFile(marker,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(store.db.prepare('SELECT terminal FROM run_observations').get().terminal,'completed');assert.equal(store.db.prepare('SELECT count(*) n FROM outbox').get().n,0);
});

for(const interruption of ['none','cancel','timeout','budget'])test(`EOF before owned exit settles after cleanup and releases capacity: ${interruption}`,async t=>{
 const source=`const fs=require('node:fs');fs.writeFileSync(process.env.HOME+'/pid',String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync(process.env.HOME+'/term','ready');${interruption==='none'?'process.exit(0);':''}});process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'late EOF final',voice:false,files:[]})}}));${completed}process.stdout.end();setInterval(()=>{},1000);});`;
 const f=await fixture(t,source),cfg=config({WORKSPACE_DIR:f.dir,CODEX_HOME:path.join(f.dir,'codex'),TELEGRAM_ALLOWED_USER_IDS:'123',BROWSER_ENABLED:'false',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',MAX_WORKERS:'1'}),store=new Store(path.join(f.dir,'db')),service=new Service(cfg,store,{},{});await service.init();
 let pid; t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}store.db.close();});
 const capability=(...args)=>service.capability(...args);capability.release=token=>service.releaseCapability(token);
 service.agent=new Agent(cfg,store,capability,options=>new Codex({...options,...f.options}));
 const first=store.job('123','synthetic EOF before exit');service.workers();
 if(interruption!=='none'){
  // Interrupt only after EOF's initial wait has expired and cleanup sent TERM.
  await until(()=>fs.access(path.join(f.dir,'term')).then(()=>true,()=>false));
  if(interruption==='cancel')service.cancelTask('123',first);
  else {const {BudgetError}=await import('../src/observations.js');service.controllers.get(first).abort(interruption==='budget'?new BudgetError():Object.assign(new Error('Execution deadline'),{code:'timeout'}));}
 }
 await Promise.all(service.workerRuns.values());pid=Number(await fs.readFile(path.join(f.dir,'pid'),'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});pid=undefined;
 const firstRow=store.jobs('123').find(j=>j.id===first);assert.equal(firstRow.state,interruption==='cancel'?'cancelled':'failed');
 assert.equal(store.db.prepare('SELECT terminal FROM run_observations').get().terminal,interruption==='none'?'provider_error':interruption==='cancel'?'cancelled':interruption);
 assert.equal(service.activeWorkers,0);assert.equal(store.search('123').filter(r=>r.role==='assistant').length,0);
 assert(!store.db.prepare('SELECT payload FROM outbox').all().some(r=>JSON.parse(r.payload).text==='late EOF final'));
 assert.equal(store.db.prepare('SELECT count(*) n FROM outbox WHERE artifact_id IS NOT NULL').get().n,0);
 // A fresh authorized task uses the actual SDK and must acquire the freed slot.
 await fs.writeFile(f.binary,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'fresh result',voice:false,files:[]})}}));${completed}});`,{mode:0o700});
 const next=store.job('123','fresh synthetic work');service.workers();assert.equal(store.jobs('123').find(j=>j.id===next).state,'running');await Promise.all(service.workerRuns.values());assert.equal(store.jobs('123').find(j=>j.id===next).state,'completed');
});

for(const interruption of ['timeout','cancel'])test(`owned media EOF retains actual exit classification: ${interruption}`,async t=>{
 const {ownedExec}=await import('../src/owned-process.js');
 const f=await fixture(t,`const fs=require('node:fs');fs.writeFileSync(process.env.HOME+'/pid',String(process.pid));process.on('SIGTERM',()=>process.exit(0));process.stdout.end();setInterval(()=>{},1000);`),ctrl=new AbortController();
 const running=ownedExec(f.binary,[],{signal:ctrl.signal,env:f.options.env,timeout:interruption==='timeout'?200:5000});const rejected=assert.rejects(running,error=>{assert.equal(error.executionUnknown,undefined);assert.equal(error.message,interruption==='timeout'?'Media process failed':'This operation was aborted');return true;});
 await until(()=>fs.access(path.join(f.dir,'pid')).then(()=>true,()=>false));if(interruption==='cancel')ctrl.abort();await rejected;
 const pid=Number(await fs.readFile(path.join(f.dir,'pid'),'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('EOF with genuinely unobserved exit retains requested capacity after bounded cleanup',async t=>{
 const f=await fixture(t,`const fs=require('node:fs');fs.writeFileSync(process.env.HOME+'/pid',String(process.pid));process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'unsettled final',voice:false,files:[]})}}));${completed}process.stdout.end();setInterval(()=>{},1000);});`),cfg=config({WORKSPACE_DIR:f.dir,CODEX_HOME:path.join(f.dir,'codex'),TELEGRAM_ALLOWED_USER_IDS:'123',BROWSER_ENABLED:'false',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',MAX_WORKERS:'1'}),store=new Store(path.join(f.dir,'db')),service=new Service(cfg,store,{},{});await service.init();
 const capability=(...args)=>service.capability(...args);capability.release=token=>service.releaseCapability(token);service.agent=new Agent(cfg,store,capability,options=>new Codex({...options,...f.options}));
 const realKill=process.kill;let pid,blockedSignals=0;
 try {
  // Fault injection is scoped to this owned fixture's group only. It models
  // unsuccessful signal delivery; the real child remains alive at settlement.
  process.kill=(target,signal)=>{if(pid&&target===-pid&&['SIGTERM','SIGKILL'].includes(signal)){blockedSignals++;return true;}return realKill(target,signal);};
  const first=store.job('123','synthetic missing exit proof');service.workers();await until(()=>fs.access(path.join(f.dir,'pid')).then(()=>true,()=>false));pid=Number(await fs.readFile(path.join(f.dir,'pid'),'utf8'));await Promise.all(service.workerRuns.values());
  assert.ok(blockedSignals>=2);assert.doesNotThrow(()=>realKill(pid,0));assert.equal(store.jobs('123').find(j=>j.id===first).state,'cancel_requested');assert.equal(store.db.prepare('SELECT terminal FROM run_observations').get().terminal,'execution_unknown');
  const next=store.job('123','fresh synthetic intent');service.workers();assert.equal(store.jobs('123').find(j=>j.id===next).state,'queued');assert.equal(service.activeWorkers,1);assert.equal(store.db.prepare('SELECT count(*) n FROM outbox').get().n,0);
 } finally {process.kill=realKill;if(pid){try{realKill(-pid,'SIGKILL');}catch{}await until(()=>{try{realKill(pid,0);return false;}catch(error){return error.code==='ESRCH';}});}store.db.close();}
});
