import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Agent} from '../src/agent.js';
import {config} from '../src/config.js';
import {verifyRestrictedConfiguration} from '../src/restricted-config.js';

// Independent lower-layer reproduction. No model/thread RPC, auth, raw receipts
// or network requests. All effective configuration stays in memory.
async function effective(options,cwd) {
 const scalars=Object.entries(options.config).map(([k,v])=>`${k}=${JSON.stringify(v)}`);
 const suppress=['analytics.enabled=false','otel.exporter="none"','otel.trace_exporter="none"','otel.metrics_exporter="none"','features.remote_control=false'];
 const child=spawn(path.resolve('node_modules/.bin/codex'),[...scalars,...options.configOverrides,...suppress].flatMap(x=>['-c',x]).concat(['app-server','--stdio','--strict-config']),{cwd,env:{...options.env,RUST_LOG:'off',CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED:'1'},detached:true,stdio:['pipe','pipe','ignore']});
 const stop=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
 let buffer='',bytes=0,next=0;const pending=new Map();
 const closed=new Promise(resolve=>child.once('close',resolve));
 const failure=()=>{for(const p of pending.values())p.reject(new Error('Synthetic preflight unavailable'));pending.clear();};
 child.on('error',failure);child.on('exit',failure);child.stdin.on('error',failure);
 child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>1048576){failure();stop();return;}buffer+=chunk.toString();let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const msg=JSON.parse(line),p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(new Error('Synthetic config read failed')):p.resolve(msg.result);}}catch{failure();}}});
 const deadline=setTimeout(()=>{failure();stop();},10000);
 const ask=(method,params)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
 try {const init=await ask('initialize',{clientInfo:{name:'synthetic-config-test',version:'1'},capabilities:{experimentalApi:true}});assert.equal(typeof init.userAgent,'string');child.stdin.write('{"method":"initialized","params":{}}\n');return (await ask('config/read',{includeLayers:false,cwd})).config;}
 finally {clearTimeout(deadline);child.stdin.destroy();stop();await closed;buffer='';pending.clear();}
}

async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'restricted-config-test-')),home=path.join(root,'home'),codexHome=path.join(home,'codex'),workspace=path.join(root,'service'),cwd=path.join(root,'empty'),marker=path.join(root,'helper-started');
 await fs.mkdir(codexHome,{recursive:true});await fs.mkdir(workspace);await fs.mkdir(cwd);
 for(const f of ['AGENTS.md','SOUL.md','USER.md'])await fs.writeFile(path.join(workspace,f),'Synthetic bounded context');
 const previous=process.env.HOME;process.env.HOME=home;t.after(async()=>{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;await fs.rm(root,{recursive:true,force:true});});
 const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',WORKSPACE_DIR:workspace,CODEX_HOME:codexHome,RESTRICTED_READ_PROFILE_PROTOTYPE:'true',LEARNING_ENABLED:'false'});
 let constructions=0,options,releases=0;const cap=()=> 'SYNTHETIC_CAPABILITY';cap.release=()=>releases++;
 const agent=new Agent(cfg,{get:()=>undefined,search:()=>[],jobs:()=>[]},cap,opts=>{constructions++;options=opts;return {startThread:()=>({runStreamed:async()=>({events:async function*(){yield {type:'item.completed',item:{type:'agent_message',text:'{"text":"done","voice":false,"files":[]}'}};yield {type:'turn.completed'};}()})})};},{context:()=>[]});
 await agent.run('123','Synthetic clean control','research');
 const helper=path.join(root,'helper.js');await fs.writeFile(helper,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');`);
 // Prove the owned marker helper is executable before clearing its positive
 // control. No server/service is started; later absence covers preflight only.
 const positive=spawn(process.execPath,[helper],{cwd:root,env:options.env,stdio:'ignore'});
 const positiveCode=await new Promise((resolve,reject)=>{positive.once('error',()=>reject(new Error('Synthetic helper control unavailable')));positive.once('close',resolve);});
 assert.equal(positiveCode,0);assert.equal(await fs.readFile(marker,'utf8'),'started');await fs.unlink(marker);
 return {agent,options,cwd,marker,codexHome,helper,get constructions(){return constructions;},get releases(){return releases;}};
}

test('anonymous pinned clean effective configuration permits restricted construction',async t=>{
 const f=await fixture(t);const c=await effective(f.options,f.cwd);
 assert.equal(c.shell_environment_policy.inherit,'none');assert.equal(Object.keys(c.shell_environment_policy.set).length,2);
 assert.deepEqual(Object.keys(c.mcp_servers),['assistant']);assert.equal(f.constructions,1);assert.equal(f.releases,1);
 // Only fixed booleans about known source-verified normalization are observed.
 assert.equal(c.mcp_servers.assistant.environment_id==='local',true);
 assert.equal(!Object.hasOwn(c.mcp_servers.assistant,'supports_parallel_tool_calls')||c.mcp_servers.assistant.supports_parallel_tool_calls===false,true);
 assert.equal(c.shell_environment_policy.include_only.length,2);
});

async function rpcFixture(t,behavior='valid') {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'restricted-rpc-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const home=path.join(root,'home'),codexHome=path.join(home,'codex');await fs.mkdir(codexHome,{recursive:true});
 const assistant={command:'node',args:['synthetic-broker'],env:{ASSISTANT_CAPABILITY:'SYNTHETIC_ONLY'},startup_timeout_sec:30,required:true};
 const config={shell_environment_policy:{inherit:'none',set:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},ignore_default_excludes:true,exclude:[],include_only:['PATH','LANG'],experimental_use_profile:false},mcp_servers:{assistant},analytics:{enabled:false},otel:{exporter:'none',trace_exporter:'none',metrics_exporter:'none'},features:{apps:false,plugins:false,hooks:false,multi_agent:false,multi_agent_v2:false,remote_control:false},agents:{enabled:false},allow_login_shell:false};
 const binary=path.join(root,'fake-runtime'),pidFile=path.join(root,'owned-pid'),receipt=path.join(root,'receipt');
 await fs.writeFile(binary,`#!${process.execPath}
import fs from 'node:fs';import readline from 'node:readline';
fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const behavior=${JSON.stringify(behavior)},config=${JSON.stringify(config)},methods=[];
const suppressed=['analytics.enabled=false','otel.exporter="none"','otel.trace_exporter="none"','otel.metrics_exporter="none"','features.apps=false','features.plugins=false','features.hooks=false','features.multi_agent=false','features.multi_agent_v2=false','agents.enabled=false','features.remote_control=false','allow_login_shell=false'].every(x=>process.argv.includes(x));
const sanitized=process.env.RUST_LOG==='off'&&process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED==='1'&&!Object.keys(process.env).some(k=>/^(OPENAI|CHATGPT|CODEX_API|ASSISTANT_CAPABILITY|NODE_OPTIONS)/.test(k));
if(behavior==='early_exit')process.exit(0);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);methods.push(msg.method);
 fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({methods,suppressed,sanitized}));
 if(msg.id===undefined)return;
 if(behavior==='timeout')return;
 if(behavior==='malformed'){process.stdout.write('SYNTHETIC_RAW_CANARY\\n');return;}
 if(behavior==='stdout_overflow'){process.stdout.write('x'.repeat(8192));return;}
 if(behavior==='stderr_overflow'){process.stderr.write('x'.repeat(8192));return;}
 if(behavior==='rpc_error'){console.log(JSON.stringify({id:msg.id,error:{message:'SYNTHETIC_RAW_CANARY'}}));return;}
 if(msg.method==='initialize'){console.log(JSON.stringify({id:msg.id,result:{userAgent:'fixture/'+(behavior==='runtime_mismatch'?'0.159.20':'0.159.2')+' unix',codexHome:process.env.CODEX_HOME,platformFamily:'unix',platformOs:process.platform==='darwin'?'macos':'linux'}}));return;}
 if(behavior==='unknown_mcp')config.mcp_servers.assistant.unreviewed='SYNTHETIC_RAW_CANARY';
 if(behavior==='foreign_disabled')config.mcp_servers.foreign={command:'node',enabled:false};
 if(behavior==='changed_args')config.mcp_servers.assistant.args=['unreviewed'];
 if(behavior==='extra_env')config.mcp_servers.assistant.env.NODE_OPTIONS='SYNTHETIC_RAW_CANARY';
 if(behavior==='changed_policy')config.shell_environment_policy.inherit='all';
 if(behavior==='unknown_policy')config.shell_environment_policy.unreviewed=true;
 const result={config,origins:{}};if(behavior==='unknown_response')result.unreviewed=true;
 console.log(JSON.stringify({id:msg.id,result}));
});setInterval(()=>{},1000);
`,{mode:0o700});
 const options={env:{PATH:'/usr/bin:/bin',HOME:home,CODEX_HOME:codexHome,LANG:'C.UTF-8'},config:{forced_login_method:'chatgpt'},configOverrides:[]};
 return {root,binary,pidFile,receipt,assistant,options};
}

test('bounded preflight uses only initialization and config RPC, suppresses startup integrations and awaits owned exit',async t=>{
 const f=await rpcFixture(t);await verifyRestrictedConfiguration(f.options,f.root,f.assistant,{binary:f.binary});
 assert.deepEqual(JSON.parse(await fs.readFile(f.receipt,'utf8')),{methods:['initialize','initialized','config/read'],suppressed:true,sanitized:true});
 const pid=Number(await fs.readFile(f.pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

for(const behavior of ['malformed','stdout_overflow','stderr_overflow','timeout','early_exit','rpc_error','runtime_mismatch','unknown_response','unknown_mcp','foreign_disabled','changed_args','extra_env','changed_policy','unknown_policy'])test(`bounded preflight rejects ${behavior} without raw error and awaits cleanup`,async t=>{
 const f=await rpcFixture(t,behavior);
 await assert.rejects(verifyRestrictedConfiguration(f.options,f.root,f.assistant,{binary:f.binary,timeoutMs:2000,maxBytes:4096}),error=>error.message==='Restricted read configuration rejected'&&!String(error).includes('SYNTHETIC_RAW_CANARY'));
 const pid=Number(await fs.readFile(f.pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});

test('bounded preflight abort and failed spawn reject with fixed error',async t=>{
 const f=await rpcFixture(t,'timeout'),controller=new AbortController();
 const timer=setInterval(()=>{void fs.stat(f.receipt).then(()=>controller.abort()).catch(()=>{});},20);
 try {await assert.rejects(verifyRestrictedConfiguration(f.options,f.root,f.assistant,{binary:f.binary,signal:controller.signal}),{message:'Restricted read configuration rejected'});}finally{clearInterval(timer);}
 const pid=Number(await fs.readFile(f.pidFile,'utf8'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 await assert.rejects(verifyRestrictedConfiguration(f.options,f.root,f.assistant,{binary:path.join(f.root,'missing')}),{message:'Restricted read configuration rejected'});
});

for(const kind of ['shell_set','foreign_mcp','owned_env','owned_timeout'])test(`rejects actual lower-layer ${kind} before SDK and helper launch`,async t=>{
 const f=await fixture(t);const toml={
  shell_set:'[shell_environment_policy.set]\nREVIEW_SYNTHETIC_SECRET="DISPOSABLE_CANARY"\n',
  foreign_mcp:`[mcp_servers.foreign]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(f.helper)}]\nenabled=true\n`,
  owned_env:'[mcp_servers.assistant]\ncommand="node"\n[mcp_servers.assistant.env]\nNODE_OPTIONS="--synthetic-disallowed-hook"\n',
  owned_timeout:'[mcp_servers.assistant]\ncommand="node"\ntool_timeout_sec=999\n'
 }[kind];await fs.writeFile(path.join(f.codexHome,'config.toml'),toml);
 const c=await effective(f.options,f.cwd);
 const survived=kind==='shell_set'?Object.hasOwn(c.shell_environment_policy.set,'REVIEW_SYNTHETIC_SECRET'):kind==='foreign_mcp'?c.mcp_servers.foreign.enabled===true:kind==='owned_env'?Object.hasOwn(c.mcp_servers.assistant.env,'NODE_OPTIONS'):c.mcp_servers.assistant.tool_timeout_sec===999;
 assert.equal(survived,true,'pinned lower-layer merge must reproduce');
 await assert.rejects(f.agent.run('123','Synthetic rejection control','research'),{message:'Restricted read configuration rejected'});
 assert.equal(f.constructions,1,'no rejected SDK construction');assert.equal(f.releases,2);
 await assert.rejects(fs.stat(f.marker),{code:'ENOENT'});
});
