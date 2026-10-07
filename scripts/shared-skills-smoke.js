// Codex discovery metadata check; startup can access cloud/model/local state. Never print account state, other skills or raw errors.
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {skillDiscoveryStatus} from '../src/shared-skills.js';
const workspace=await fs.realpath(path.resolve(process.env.WORKSPACE_DIR||process.cwd()));
const anonymous=process.argv.includes('--anonymous');
const disposable=anonymous?await fs.mkdtemp(path.join(os.tmpdir(),'anonymous-skills-')):null;
if(disposable)await fs.mkdir(path.join(disposable,'codex'));
const child=spawn(path.resolve('node_modules/.bin/codex'),['app-server','--stdio'],{cwd:workspace,env:{PATH:process.env.PATH,HOME:disposable||process.env.HOME,CODEX_HOME:disposable?path.join(disposable,'codex'):process.env.CODEX_HOME},stdio:['pipe','pipe','ignore']});
let exited=false;const exit=new Promise(resolve=>{child.once('exit',()=>{exited=true;resolve();});child.once('error',()=>{if(!child.pid){exited=true;resolve();}});});
const lines=createInterface({input:child.stdout});let next=0;const pending=new Map();
const fail=()=>{for(const p of pending.values())p.reject(new Error('Skill discovery unavailable'));pending.clear();};
const request=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
lines.on('line',line=>{let response;try{response=JSON.parse(line);}catch{return;}const p=pending.get(response.id);if(!p)return;pending.delete(response.id);if(response.error)p.reject(new Error('Skill discovery unavailable'));else p.resolve(response.result);});
child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);const timer=setTimeout(fail,30000);
try {
  await request('initialize',{clientInfo:{name:'assistant-shared-skills-smoke',version:'0.1.0'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  const result=await request('skills/list',{cwds:[workspace],forceReload:true});
  const discovered=result.data.filter(row=>row.cwd===workspace).flatMap(row=>row.skills);
  const status=skillDiscoveryStatus(discovered,workspace);
  console.log(JSON.stringify(status));
  if(status.some(skill=>!skill.enabled))process.exitCode=1;
} catch {console.error('Shared skills discovery unavailable; check runtime support, skill metadata and mount permissions.');process.exitCode=1;}
finally {
  clearTimeout(timer);lines.close();child.stdin.destroy();child.kill();
  let killTimer,exitTimer;
  try {killTimer=setTimeout(()=>child.kill('SIGKILL'),250);await Promise.race([exit,new Promise(resolve=>{exitTimer=setTimeout(resolve,1500);})]);}
  finally {clearTimeout(killTimer);clearTimeout(exitTimer);if(disposable&&exited)await fs.rm(disposable,{recursive:true,force:true});}
  if(!exited){console.error('Skill discovery child exit unverified');process.exitCode=1;}
}
