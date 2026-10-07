import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Codex } from '@openai/codex-sdk';
import { Agent } from '../src/agent.js';
import { config } from '../src/config.js';
import { validateProbeInput, parseProbeOutput, runIsolationProbe } from '../scripts/isolation-probe.js';
import { restrictedReadDefinition, restrictedReadOverrides, createRestrictedWorkspace } from '../src/restricted-read.js';

async function fixture(t,{enabled=true,failure,actualSdk=false}={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'restricted-read-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const workspace=path.join(root,'workspace');await fs.mkdir(workspace);
 const home=path.join(root,'anonymous-home');await fs.mkdir(home);
 const previous=process.env.HOME;process.env.HOME=home;t.after(()=>{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;});
 await fs.mkdir(path.join(root,'auth'));
 for(const file of ['AGENTS.md','SOUL.md','USER.md'])await fs.writeFile(path.join(workspace,file),'Synthetic bounded context');
 const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',WORKSPACE_DIR:workspace,CODEX_HOME:path.join(root,'auth'),RESTRICTED_READ_PROFILE_PROTOTYPE:String(enabled),BROWSER_ENABLED:'true',LEARNING_ENABLED:'false'});
 const state=new Map([['thread:123','ordinary-privileged-thread'],['thread-history:123:ordinary-privileged-thread',12]]),reads=[],writes=[],seen=[],released=[];
 const store={get:key=>{reads.push(key);return state.get(key);},set:(key,value)=>{writes.push(key);state.set(key,value);},search:()=>[{id:11,text:'Earlier bounded context'},{id:13,text:'Latest bounded context'}],jobs:()=>[]};
 const capability=()=> 'SYNTHETIC_CAPABILITY';capability.release=value=>released.push(value);
 let sdkOptions;const binary=path.join(root,'synthetic-sdk-child');
 if(actualSdk)await fs.writeFile(binary,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{const argv=process.argv.slice(2),configs=argv.filter((x,i)=>argv[i-1]==='--config');const result={text:JSON.stringify({legacySandbox:argv.includes('--sandbox'),resumed:argv.includes('resume'),selected:configs.some(x=>/^default_permissions="assistant_restricted_read_[a-f0-9]+"$/.test(x)),custom:configs.some(x=>/^permissions=/.test(x)),webDisabled:configs.includes('web_search="disabled"')}),voice:false,files:[]};for(const event of [{type:'thread.started',thread_id:'fresh-restricted-thread'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}},{type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}])console.log(JSON.stringify(event));});\n`,{mode:0o700});
 const sdkFactory=options=>{sdkOptions=options;if(actualSdk)return new Codex({...options,codexPathOverride:binary});return {startThread:opts=>thread(opts,false),resumeThread:(id,opts)=>thread(opts,true,id)};};
 function thread(opts,resumed,id){seen.push({opts,resumed,id});return {runStreamed:async input=>{seen.at(-1).input=input;assert.deepEqual(await fs.readdir(opts.workingDirectory),resumed?await fs.readdir(workspace):[]);if(failure)throw failure;return {events:async function*(){yield {type:'thread.started',thread_id:'fresh-restricted-thread'};yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'Done',voice:false,files:[]})}};yield {type:'turn.completed'};}()};}};}
 const agent=new Agent(cfg,store,capability,sdkFactory,{context:()=>[]});
 return {root,workspace,cfg,state,reads,writes,seen,released,agent,get sdkOptions(){return sdkOptions;}};
}

test('restricted read option is disabled by default and explicit opt-in',()=>{
 assert.equal(config({}).restrictedReadProfilePrototype,false);
 assert.equal(config({RESTRICTED_READ_PROFILE_PROTOTYPE:'true'}).restrictedReadProfilePrototype,true);
 assert.equal(config({RESTRICTED_READ_PROFILE_PROTOTYPE:'TRUE'}).restrictedReadProfilePrototype,false);
});

test('restricted main read attempts are fresh and preserve ordinary thread/cursor',async t=>{
 const f=await fixture(t);const names=[],directories=[];
 for(let i=0;i<2;i++){
  await f.agent.run('123','Review synthetic data','main',[],undefined,()=>{},'also-privileged',false,{toolScope:'read'});
  const {opts,resumed,input}=f.seen.at(-1);directories.push(opts.workingDirectory);
  assert.equal(resumed,false);assert.equal(Object.hasOwn(opts,'sandboxMode'),false);assert.equal(opts.webSearchMode,'disabled');
  assert.ok(!opts.workingDirectory.startsWith(f.workspace));await assert.rejects(fs.stat(opts.workingDirectory),{code:'ENOENT'});
  names.push(f.sdkOptions.configOverrides.find(x=>x.startsWith('default_permissions=')));
  assert.match(input[0].text,/Earlier bounded context/);
 }
 assert.notEqual(names[0],names[1]);assert.notEqual(directories[0],directories[1]);
 assert.equal(f.state.get('thread:123'),'ordinary-privileged-thread');assert.equal(f.state.get('thread-history:123:ordinary-privileged-thread'),12);
 assert.equal(f.reads.some(key=>key.startsWith('thread:')||key.startsWith('thread-history:')),false);assert.deepEqual(f.writes,[]);assert.equal(f.released.length,2);
});

test('actual pinned SDK emits custom permissions with no sandbox or resume override',async t=>{
 const f=await fixture(t,{actualSdk:true});const result=await f.agent.run('123','Synthetic parser control','main',[],undefined,()=>{},undefined,false,{toolScope:'read'});
 assert.deepEqual(JSON.parse(result.text),{legacySandbox:false,resumed:false,selected:true,custom:true,webDisabled:true});
 assert.deepEqual(f.writes,[]);
});

test('ordinary main retains existing thread and cursor when prototype enabled',async t=>{
 const f=await fixture(t);await f.agent.run('123','Ordinary synthetic turn');
 assert.equal(f.seen[0].resumed,true);assert.equal(f.seen[0].id,'ordinary-privileged-thread');assert.equal(f.seen[0].opts.sandboxMode,'danger-full-access');assert.equal(f.seen[0].opts.workingDirectory,f.workspace);
 assert.ok(!f.seen[0].input[0].text.includes('Earlier bounded context'));assert.equal(f.state.get('thread:123'),'fresh-restricted-thread');
 assert.equal(f.sdkOptions.configOverrides.some(x=>x.startsWith('default_permissions=')),false);
});

for(const kind of ['failure','cancellation'])test(`restricted cwd cleans up after ${kind} and releases capability`,async t=>{
 const controller=new AbortController();const failure=new Error('Synthetic failure');const f=await fixture(t,{failure});
 if(kind==='cancellation'){failure.name='AbortError';f.agent.sdkFactory=options=>({startThread:opts=>{f.seen.push({opts});return {runStreamed:async()=>{controller.abort(failure);controller.signal.throwIfAborted();}};}});}
 await assert.rejects(f.agent.run('123','Synthetic review','research',[],controller.signal),error=>error===failure);
 assert.notEqual(f.seen[0].opts.workingDirectory,f.workspace);await assert.rejects(fs.stat(f.seen[0].opts.workingDirectory),{code:'ENOENT'});assert.equal(f.released.length,1);
});


test('probe input validation refuses symlink, hardlink and foreign paths before a grant',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'restricted-input-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const owned=path.join(root,'owned'),foreign=path.join(root,'foreign');await fs.mkdir(owned);await fs.mkdir(foreign);
 const allowed=path.join(owned,'allowed'),other=path.join(foreign,'other');await fs.writeFile(allowed,'Synthetic input');await fs.writeFile(other,'Synthetic foreign');
 assert.equal(await validateProbeInput(allowed,owned),await fs.realpath(allowed));
 const symlink=path.join(owned,'link');await fs.symlink(other,symlink);await assert.rejects(validateProbeInput(symlink,owned));
 const hardlink=path.join(owned,'hardlink');await fs.link(other,hardlink);await assert.rejects(validateProbeInput(hardlink,owned));await assert.rejects(validateProbeInput(other,owned));
 await fs.link(allowed,path.join(foreign,'allowed-link'));await assert.rejects(validateProbeInput(allowed,owned));
});

test('runtime permission grants contain only minimal and exact runtime dependencies',async()=>{
 const overrides=await restrictedReadOverrides(),runtime=await fs.realpath(process.execPath);
 assert.match(overrides[0],/^default_permissions="assistant_restricted_read_[a-f0-9]{32}"$/);
 assert.ok(overrides[1].includes(`${JSON.stringify(runtime)}="read"`));assert.ok(overrides[1].includes('":minimal"="read"'));
 assert.ok(!overrides[1].includes(':project_roots')&&!overrides[1].includes(':workspace_roots')&&!overrides[1].includes('"write"'));
 assert.ok(overrides[1].endsWith('network={enabled=false}}}'));assert.ok(overrides[2].includes('inherit="none"'));
 assert.equal(restrictedReadDefinition.applicationInputs,false);
});

test('restricted temp cwd fails closed if temporary storage is within service root',async()=>{
 await assert.rejects(createRestrictedWorkspace({workspace:path.parse(os.tmpdir()).root,codexHome:path.join(os.tmpdir(),'synthetic-auth-not-created')}),/overlaps/);
 await assert.rejects(createRestrictedWorkspace({workspace:os.tmpdir(),codexHome:path.join(os.tmpdir(),'synthetic-auth-not-created')}),/overlaps/);
});

test('probe stdout rejects raw or oversized fields and invalid mode needs no subprocess',async()=>{
 assert.throws(()=>parseProbeOutput('{"raw":"SYNTHETIC_PRIVATE_CANARY"}'));
 assert.throws(()=>parseProbeOutput('x'.repeat(4097)));
 assert.throws(()=>parseProbeOutput('null'));
 const result=await runIsolationProbe('invalid');assert.equal(result.outcome,'unavailable');assert.equal(result.reason,'invalid_mode');
});

test('restricted prototype refuses local image grants and oversized text with cleanup',async t=>{
 const f=await fixture(t);await assert.rejects(f.agent.run('123','Synthetic image review','research',[path.join(f.workspace,'image')]),/bounded text/);
 assert.equal(f.seen.length,0);assert.equal(f.released.length,1);
 await assert.rejects(f.agent.run('123','x'.repeat(100001),'research'),/exceeds bound/);assert.equal(f.released.length,2);
 await assert.rejects(fs.stat(f.seen[0].opts.workingDirectory),{code:'ENOENT'});
});
