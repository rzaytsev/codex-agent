// Read-only connection metadata. Never print auth state, account IDs or RPC errors.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
const child=spawn(path.resolve('node_modules/.bin/codex'),['app-server','--stdio'],{cwd:process.env.WORKSPACE_DIR||process.cwd(),env:{PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME},stdio:['pipe','pipe','ignore']});
const lines=createInterface({input:child.stdout});let next=0;let stage='initialize';const pending=new Map();
const request=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({id,method,params})+'\n');
});
const fail=()=>{for(const p of pending.values())p.reject(new Error('Connection metadata unavailable'));pending.clear();};
lines.on('line',line=>{
  let response;try {response=JSON.parse(line);}catch{return;}
  const p=pending.get(response.id);if(!p)return;pending.delete(response.id);
  if(response.error)p.reject(new Error(`RPC code ${Number(response.error.code)||0}`));else p.resolve(response.result);
});
child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);
const timer=setTimeout(fail,60000);
try {
  await request('initialize',{clientInfo:{name:'assistant-google-status',version:'0.1.0'},capabilities:{experimentalApi:true}});
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  stage='app/installed';const installed=await request('app/installed',{forceRefresh:true});
  stage='app/read';const metadata=installed.apps.length?await request('app/read',{appIds:installed.apps.map(a=>a.id).slice(0,100),includeTools:false}):{apps:[]};
  const names=new Map(metadata.apps.map(a=>[a.id,a.name]));
  console.log(JSON.stringify(installed.apps.filter(a=>/^(Gmail|Google Calendar|Google Drive)$/i.test(names.get(a.id)||a.runtimeName||'')).map(a=>({name:names.get(a.id)||a.runtimeName,enabled:a.enabled,callable:a.callable})),null,2));
} catch(e) {console.error(`Google connection metadata unavailable at ${stage}${/^RPC code -?\d+$/.test(e.message)?' ('+e.message+')':''}; check ChatGPT login, installed plugins and runtime support.`);process.exitCode=1;}
finally {clearTimeout(timer);lines.close();child.stdin.destroy();child.kill();}
