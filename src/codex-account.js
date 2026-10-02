import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// A private stdio connection, never a network listener. Do not expose raw errors.
export class AccountClient extends EventEmitter {
  constructor(cfg,{binary=path.resolve('node_modules/.bin/codex'),timeoutMs=15000}={}) {
    super();this.timeoutMs=timeoutMs;this.nextId=0;this.pending=new Map();this.ended=false;
    this.child=spawn(binary,['-c','forced_login_method="chatgpt"','-c','cli_auth_credentials_store="file"','app-server','--stdio'],{
      cwd:cfg.codexHome,
      env:{PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:cfg.codexHome},stdio:['pipe','pipe','ignore']});
    this.closed=new Promise(resolve=>{this.resolveClosed=resolve;});
    this.lines=createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{
      if(line.length>1024*1024){void this.close();return;}
      let message;try {message=JSON.parse(line);}catch{return;}
      if(message.id!==undefined) {
        const pending=this.pending.get(message.id);if(!pending)return;
        this.pending.delete(message.id);clearTimeout(pending.timer);
        if(message.error)pending.reject(new Error('Codex account request failed'));
        else pending.resolve(message.result);
      } else if(typeof message.method==='string')this.emit('notification',message);
    });
    this.child.on('error',()=>this.finish());
    this.child.on('close',()=>this.finish());
    this.child.stdin.on('error',()=>{void this.close();});
  }
  async initialize() {
    await this.request('initialize',{clientInfo:{name:'codex-personal-assistant',version:'0.1.0'},capabilities:{experimentalApi:true}});
    this.child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  }
  request(method,params) {
    if(this.ended||this.closing)return Promise.reject(new Error('Codex account connection closed'));
    return new Promise((resolve,reject)=>{
      const id=++this.nextId;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Codex account request timed out'));void this.close();},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,method,...(params===undefined?{}:{params})})+'\n');
    });
  }
  finish() {
    if(this.ended)return;this.ended=true;
    clearTimeout(this.killTimer);this.lines.close();
    for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Codex account connection closed'));}
    this.pending.clear();this.resolveClosed();
  }
  close() {
    if(!this.ended&&!this.closing) {
      this.closing=true;this.child.stdin.destroy();this.child.kill('SIGTERM');
      this.killTimer=setTimeout(()=>this.child.kill('SIGKILL'),1000);this.killTimer.unref();
    }
    return this.closed;
  }
}

export async function readAccount(cfg,options) {
  const client=new AccountClient(cfg,options);
  try {
    await client.initialize();
    const result=await client.request('account/read',{refreshToken:false});
    if(!result||!Object.hasOwn(result,'account'))throw new Error('Account status unavailable');
    const account=result.account;
    if(account===null||account?.type==='apiKey')return null;
    if(account?.type!=='chatgpt')throw new Error('Unsupported authentication');
    return {email:typeof account.email==='string'?account.email:null,plan:typeof account.planType==='string'?account.planType:'unknown'};
  } finally {await client.close();}
}
