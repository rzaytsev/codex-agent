import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Agent } from '../src/agent.js';
import { UsageLimitError } from '../src/usage.js';

const reply={text:'Done',voice:false,files:[]};
async function fixture(t,{browserEnabled=false,events,sdkFactory,memory}={}) {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-agent-lifecycle-'));
  t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
  for(const file of ['AGENTS.md','SOUL.md','USER.md']) await fs.writeFile(path.join(workspace,file),'Synthetic test context');
  const issued=[],released=[],runs=[];
  const capability=(...args)=>{issued.push(args);return 'synthetic-capability';};
  capability.release=token=>released.push(token);
  const thread={runStreamed:async(input,options)=>{
    runs.push({input,options});
    return {events:events?events():async function*(){
      yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(reply)}};
      yield {type:'turn.completed'};
    }()};
  }};
  const cfg={workspace,codexHome:path.join(workspace,'codex'),timezone:'UTC',browserEnabled,browserExecutable:'/synthetic/chromium',profiles:{main:{effort:'low'},worker:{effort:'high'}}};
  const store={get:()=>undefined,set:()=>{},search:()=>[],jobs:()=>[]};
  const agent=new Agent(cfg,store,capability,sdkFactory||(()=>({startThread:()=>thread})),memory||{context:()=>[]});
  return {workspace,agent,issued,released,runs};
}

test('SDK construction failure releases the allocated capability and preserves the error',async t=>{
  const failure=new Error('Synthetic SDK setup failure');
  const {agent,issued,released}=await fixture(t,{sdkFactory:()=>{throw failure;}});
  await assert.rejects(agent.run('123','hello'),error=>error===failure);
  assert.equal(issued.length,1);
  assert.deepEqual(released,['synthetic-capability']);
});

test('browser output setup failure releases the capability before constructing the SDK',async t=>{
  let constructed=false;
  const {workspace,agent,released}=await fixture(t,{browserEnabled:true,sdkFactory:()=>{constructed=true;throw new Error('SDK must not be constructed');}});
  await fs.writeFile(path.join(workspace,'outputs'),'Not a directory');
  await assert.rejects(agent.run('123','hello'),{code:'ENOTDIR'});
  assert.equal(constructed,false);
  assert.deepEqual(released,['synthetic-capability']);
});

test('context preparation failure releases the allocated capability',async t=>{
  const failure=new Error('Synthetic memory read failure');
  const {agent,released,runs}=await fixture(t,{memory:{context:()=>{throw failure;}}});
  await assert.rejects(agent.run('123','hello'),error=>error===failure);
  assert.equal(runs.length,0);
  assert.deepEqual(released,['synthetic-capability']);
});

test('completed turns forward cancellation to the capability and SDK and release once',async t=>{
  const controller=new AbortController();
  const {agent,issued,released,runs}=await fixture(t);
  assert.deepEqual(await agent.run('123','hello','worker',[],controller.signal),reply);
  assert.equal(issued.length,1);assert.deepEqual(issued[0].slice(0,4),['123',true,false,controller.signal]);
  assert.match(issued[0][4].observationRun.id,/^[a-f0-9-]{36}$/);
  assert.equal(runs[0].options.signal,controller.signal);
  assert.deepEqual(released,['synthetic-capability']);
});

test('already cancelled turns do not allocate a capability or start the SDK',async t=>{
  const controller=new AbortController(),reason=new Error('Cancelled before setup');
  controller.abort(reason);
  const {agent,issued,released,runs}=await fixture(t);
  await assert.rejects(agent.run('123','hello','main',[],controller.signal),error=>error===reason);
  assert.equal(issued.length,0);
  assert.equal(runs.length,0);
  assert.deepEqual(released,[]);
});

test('cancellation during SDK setup releases the capability without starting a turn',async t=>{
  const controller=new AbortController(),reason=new Error('Cancelled during setup');
  let started=false;
  const {agent,released}=await fixture(t,{sdkFactory:()=>{
    controller.abort(reason);
    return {startThread:()=>({runStreamed:()=>{started=true;throw new Error('Turn must not start');}})};
  }});
  await assert.rejects(agent.run('123','hello','main',[],controller.signal),error=>error===reason);
  assert.equal(started,false);
  assert.deepEqual(released,['synthetic-capability']);
});

test('cancellation stops a stream that ignores the signal from returning success',async t=>{
  const controller=new AbortController(),reason=new Error('Cancelled during stream');
  const {agent,released}=await fixture(t,{events:async function*(){
    yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(reply)}};
    controller.abort(reason);
    yield {type:'turn.completed'};
  }});
  await assert.rejects(agent.run('123','hello','main',[],controller.signal),error=>error===reason);
  assert.deepEqual(released,['synthetic-capability']);
});

for(const [name,error,expected] of [
  ['ordinary stream failure',{message:'Synthetic failure'},/Codex turn failed/],
  ['streamed quota failure',{code:'usage_limit_exceeded'},UsageLimitError]
])test(`${name} releases the capability once`,async t=>{
  const {agent,released}=await fixture(t,{events:async function*(){yield {type:'turn.failed',error};}});
  await assert.rejects(agent.run('123','hello'),expected);
  assert.deepEqual(released,['synthetic-capability']);
});

test('SDK setup quota failure retains usage-limit classification and releases once',async t=>{
  const {agent,released}=await fixture(t,{sdkFactory:()=>{throw Object.assign(new Error('Synthetic quota failure'),{code:'usage_limit_exceeded'});}});
  await assert.rejects(agent.run('123','hello'),UsageLimitError);
  assert.deepEqual(released,['synthetic-capability']);
});
