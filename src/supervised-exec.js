import {spawn} from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import {Codex} from '@openai/codex-sdk';
import manifest from '../package.json' with {type:'json'};

const failure=()=>new Error('Codex execution boundary failed');
export class ExecutionUnknown extends Error {
  constructor(){super('Execution exit could not be verified; reconcile effects before new work');this.observationReason='execution_unknown';this.executionUnknown=true;}
}
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function toml(v) {
  if(typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
  if(Array.isArray(v))return `[${v.map(toml).join(', ')}]`;
  if(object(v))return `{${Object.entries(v).filter(([,x])=>x!==undefined).map(([k,x])=>{if(!k)throw failure();return `${/^[A-Za-z0-9_-]+$/.test(k)?k:JSON.stringify(k)} = ${toml(x)}`;}).join(', ')}}`;
  throw failure();
}
function flatten(v,prefix='') {
  if(!object(v))throw failure();
  if(prefix&&!Object.keys(v).length)return [`${prefix}={}`];
  return Object.entries(v).flatMap(([k,x])=>{if(!k)throw failure();if(x===undefined)return [];const key=prefix?`${prefix}.${k}`:k;return object(x)?flatten(x,key):[`${key}=${toml(x)}`];});
}
// Pinned SDK integration seam only: SDK still owns threads, JSON parsing,
// schema files and the native model/tool loop. No raw stderr is retained.
export function superviseSdk(sdk) {
  if(!(sdk instanceof Codex))return sdk; // Explicit injected test adapters.
  const e=sdk.exec;
  if(manifest.dependencies['@openai/codex-sdk']!=='0.159.2'||!e||typeof e.executablePath!=='string'||!Array.isArray(e.pathDirs)||typeof e.run!=='function'||!object(e.envOverride)||!['linux','darwin'].includes(process.platform))throw failure();
  e.run=async function*(a) {
    a.signal?.throwIfAborted();
    const allowed=['input','baseUrl','apiKey','threadId','images','model','threadSource','sandboxMode','workingDirectory','skipGitRepoCheck','outputSchemaFile','modelReasoningEffort','signal','networkAccessEnabled','webSearchMode','webSearchEnabled','approvalPolicy','additionalDirectories'];
    if(Object.keys(a).some(k=>!allowed.includes(k)))throw failure();
    const argv=['exec','--experimental-json'],config=v=>argv.push('--config',v),flag=(f,v)=>{if(v)argv.push(f,v);};
    for(const value of flatten(e.configOverrides||{}))config(value);
    for(const value of e.rawConfigOverrides||[])config(value);
    if(a.baseUrl)config(`openai_base_url=${toml(a.baseUrl)}`);
    flag('--model',a.model);if(!a.threadId)flag('--thread-source',a.threadSource);
    flag('--sandbox',a.sandboxMode);flag('--cd',a.workingDirectory);
    for(const dir of a.additionalDirectories||[])flag('--add-dir',dir);
    if(a.skipGitRepoCheck)argv.push('--skip-git-repo-check');
    flag('--output-schema',a.outputSchemaFile);
    if(a.modelReasoningEffort)config(`model_reasoning_effort=${toml(a.modelReasoningEffort)}`);
    if(a.networkAccessEnabled!==undefined)config(`sandbox_workspace_write.network_access=${a.networkAccessEnabled}`);
    const web=a.webSearchMode||(a.webSearchEnabled===true?'live':a.webSearchEnabled===false?'disabled':undefined);if(web)config(`web_search=${toml(web)}`);
    if(a.approvalPolicy)config(`approval_policy=${toml(a.approvalPolicy)}`);
    if(a.threadId)argv.push('resume',a.threadId);
    for(const image of a.images||[])flag('--image',image);
    const env={...e.envOverride};env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE||='codex_sdk_ts';
    if(a.apiKey)env.CODEX_API_KEY=a.apiKey;
    if(e.pathDirs.length)env.PATH=[...e.pathDirs,...(env.PATH||'').split(path.delimiter).filter(entry=>entry&&!e.pathDirs.includes(entry))].join(path.delimiter);
    let child;try{child=spawn(e.executablePath,argv,{env,detached:true,stdio:['pipe','pipe','ignore']});}catch{throw failure();}
    let exited=false,failed=false,exitCode,killTimer,drainTimer;
    let resolveExit;const exit=new Promise(resolve=>{resolveExit=resolve;});
    child.once('error',()=>{failed=true;if(!child.pid){exited=true;resolveExit();}});
    child.once('exit',code=>{exited=true;exitCode=code;resolveExit();drainTimer=setTimeout(()=>child.stdout.destroy(),250);});
    const kill=signal=>{if(!child.pid)return;try{process.kill(-child.pid,signal);}catch{try{child.kill(signal);}catch{}}};
    const abort=()=>{kill('SIGTERM');killTimer??=setTimeout(()=>{kill('SIGKILL');child.stdout.destroy();},250);};
    a.signal?.addEventListener('abort',abort,{once:true});if(a.signal?.aborted)abort();
    child.stdin.on('error',()=>{failed=true;});child.stdin.end(a.input);
    const lines=readline.createInterface({input:child.stdout,crlfDelay:Infinity});
    try {
      for await(const line of lines)yield line;
      if(!exited)await waitExit(exit,1000);
      // EOF is not exit proof or success. Cleanup below may still observe exit;
      // only its final evidence can classify execution as unknown.
      if(!exited)throw failure();
      a.signal?.throwIfAborted();
      if(failed||exitCode!==0)throw failure();
    } finally {
      a.signal?.removeEventListener('abort',abort);lines.close();
      if(!exited){abort();await waitExit(exit,1500);}
      clearTimeout(killTimer);clearTimeout(drainTimer);
      // Best effort cleanup of same-group descendants; escaped descendants are
      // outside this boundary, and even group signal delivery is not exit proof.
      kill('SIGKILL');child.stdin.destroy();child.stdout.destroy();
      if(!exited)throw new ExecutionUnknown();
    }
  };
  return sdk;
}
async function waitExit(exit,ms){let timer;try{await Promise.race([exit,new Promise(resolve=>{timer=setTimeout(resolve,ms);})]);}finally{clearTimeout(timer);}}
