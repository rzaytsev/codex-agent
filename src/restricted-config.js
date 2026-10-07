import path from 'node:path';
import {spawn} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {restrictedShellEnvironment} from './restricted-read.js';

export const restrictedStartupOverrides=Object.freeze([
 'analytics.enabled=false','otel.exporter="none"','otel.trace_exporter="none"','otel.metrics_exporter="none"',
 'features.apps=false','features.plugins=false','features.hooks=false','features.multi_agent=false','features.multi_agent_v2=false',
 'agents.enabled=false','features.remote_control=false','allow_login_shell=false'
]);
export const restrictedStartupEnvironment=Object.freeze({RUST_LOG:'off',CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED:'1'});
const rejected=()=>new Error('Restricted read configuration rejected');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function exact(value,required,optional={}) {
 if(!object(value))return false;
 if(Object.entries(required).some(([key,expected])=>!Object.hasOwn(value,key)||!isDeepStrictEqual(value[key],expected)))return false;
 return Object.keys(value).every(key=>Object.hasOwn(required,key)||(Object.hasOwn(optional,key)&&isDeepStrictEqual(value[key],optional[key])));
}
const reviewedMcpDefaults=Object.freeze({
 environment_id:'local',enabled:true,env_vars:[],supports_parallel_tool_calls:false,startup_readiness:'connection',auth:'oauth',tools:{},
 tool_timeout_sec:null,tool_input_schema_max_bytes:null,omit_tools_from:null,default_tools_approval_mode:null,
 enabled_tools:null,disabled_tools:null,scopes:null,oauth:null,oauth_resource:null,cwd:null
});

// Config/read serializes the effective layered ConfigToml (including exact
// requirements). Only pinned, source-reviewed MCP normalization is accepted.
export function validateRestrictedConfiguration(config,assistant) {
 const policy=config?.shell_environment_policy;
 if(!exact(policy,{inherit:'none',set:restrictedShellEnvironment,ignore_default_excludes:true,exclude:[],include_only:['PATH','LANG'],experimental_use_profile:false},{filters:null}))throw rejected();
 if(!object(config.mcp_servers)||!isDeepStrictEqual(Object.keys(config.mcp_servers),['assistant']))throw rejected();
 if(!exact(config.mcp_servers.assistant,assistant,reviewedMcpDefaults))throw rejected();
 if(config.analytics?.enabled!==false||!object(config.otel)||['exporter','trace_exporter','metrics_exporter'].some(k=>config.otel[k]!=='none'))throw rejected();
 for(const key of ['apps','plugins','hooks','multi_agent','multi_agent_v2','remote_control'])if(config.features?.[key]!==false)throw rejected();
 if(config.agents?.enabled!==false||config.allow_login_shell!==false)throw rejected();
}

// This starts the pinned runtime, NOT a side-effect-free parser. Startup can
// load auth/cloud config, refresh models and create local state. No thread,
// model, account or MCP RPC is sent. Authenticated compatibility is still gated.
export async function verifyRestrictedConfiguration(options,cwd,assistant,{signal,binary=path.resolve('node_modules/.bin/codex'),timeoutMs=5000,maxBytes=1024*1024}={}) {
 let child,buffer=Buffer.alloc(0),bytes=0,closed,timer,pending,ended=false;
 const fail=()=>{ended=true;buffer=Buffer.alloc(0);pending?.reject(rejected());pending=undefined;};
 const stop=()=>{if(child?.pid){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}};
 const abort=()=>{fail();stop();};
 try {
  signal?.throwIfAborted();
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>5000||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>1024*1024)throw rejected();
  const scalars=Object.entries(options.config).map(([key,value])=>{
   if(!/^[a-z_]+$/.test(key)||!['string','boolean','number'].includes(typeof value)||(typeof value==='number'&&!Number.isFinite(value)))throw rejected();
   return `${key}=${JSON.stringify(value)}`;
  });
  child=spawn(binary,[...scalars,...options.configOverrides,...restrictedStartupOverrides].flatMap(value=>['-c',value]).concat(['app-server','--stdio','--strict-config']),{
   cwd,env:{...options.env,...restrictedStartupEnvironment},detached:true,stdio:['pipe','pipe','pipe']
  });
  closed=new Promise(resolve=>child.once('close',resolve));
  child.once('error',abort);child.once('exit',fail);child.stdin.on('error',abort);
  const count=chunk=>{bytes+=chunk.length;if(bytes>maxBytes){abort();return false;}return !ended;};
  child.stderr.on('data',count); // Count and discard: never retain diagnostics.
  child.stdout.on('data',chunk=>{
   if(!count(chunk))return;
   buffer=Buffer.concat([buffer,chunk]);let newline;
   while(!ended&&(newline=buffer.indexOf(10))>=0){
    const line=buffer.subarray(0,newline);buffer=buffer.subarray(newline+1);
    let message;try{message=JSON.parse(line.toString('utf8'));}catch{abort();return;}
    if(!object(message)){abort();return;}
    if(Object.hasOwn(message,'id')){
     if(!pending||message.id!==pending.id||!exact(message,{id:pending.id,result:message.result})||!object(message.result)){abort();return;}
     const current=pending;pending=undefined;current.resolve(message.result);
    }else if(typeof message.method!=='string'){abort();return;}
    // Notifications (including warning payloads) are discarded, never logged.
   }
  });
  timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});
  const ask=(id,method,params)=>new Promise((resolve,reject)=>{
   if(ended){reject(rejected());return;}
   pending={id,resolve,reject};child.stdin.write(JSON.stringify({id,method,params})+'\n');
  });
  const init=await ask(1,'initialize',{clientInfo:{name:'assistant-restricted-preflight',version:'1'},capabilities:{experimentalApi:true}});
  const pinnedVersion=typeof init.userAgent==='string'&&/(?:^|\/)0\.159\.2(?:\s|$)/.test(init.userAgent);
  const knownInitialize=exact(init,{userAgent:init.userAgent,codexHome:init.codexHome,platformFamily:init.platformFamily,platformOs:init.platformOs});
  if(!knownInitialize||!pinnedVersion||typeof init.codexHome!=='string'||init.platformFamily!=='unix'||!['macos','linux'].includes(init.platformOs))throw rejected();
  child.stdin.write('{"method":"initialized","params":{}}\n');
  let result=await ask(2,'config/read',{includeLayers:false,cwd});
  if(ended||!object(result.config)||!object(result.origins)||Object.keys(result).some(key=>!['config','origins','layers'].includes(key))||(result.layers!==undefined&&result.layers!==null))throw rejected();
  validateRestrictedConfiguration(result.config,assistant);result=undefined;
  if(ended)throw rejected();signal?.throwIfAborted();
 }catch{throw rejected();}
 finally{
  clearTimeout(timer);signal?.removeEventListener('abort',abort);fail();
  if(child){child.stdin.destroy();stop();await closed;child.stdout.removeAllListeners('data');child.stderr.removeAllListeners('data');}
  buffer=Buffer.alloc(0);pending=undefined;
 }
}
