// Read-only Codex discovery check. Never print account state, other skills or raw errors.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const names=['learn','scrape','skillify','investigate','planning'];
const workspace=path.resolve(process.env.WORKSPACE_DIR||process.cwd());
const child=spawn(path.resolve('node_modules/.bin/codex'),['app-server','--stdio'],{cwd:workspace,env:{PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME},stdio:['pipe','pipe','ignore']});
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
  const status=names.map(name=>({name,enabled:discovered.some(skill=>skill.name===name&&skill.enabled===true&&skill.path===path.join(workspace,'.agents','skills',name,'SKILL.md'))}));
  console.log(JSON.stringify(status));
  if(status.some(skill=>!skill.enabled))process.exitCode=1;
} catch {console.error('Shared skills discovery unavailable; check runtime support, skill metadata and mount permissions.');process.exitCode=1;}
finally {clearTimeout(timer);lines.close();child.stdin.destroy();child.kill();}
