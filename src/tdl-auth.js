import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

export class TdlAuth {
  constructor(cfg,store,{busy=()=>false,start=(home,owner)=>spawn('/usr/bin/python3',[path.resolve('scripts/tdl-auth.py'),home,owner],{env:{PATH:process.env.PATH,LANG:'C.UTF-8'},stdio:['pipe','pipe','ignore']}),cleanup=home=>promisify(execFile)('/usr/bin/python3',[path.resolve('scripts/tdl-auth.py'),'--cleanup',home],{env:{PATH:process.env.PATH},timeout:5000,maxBuffer:2048}),timeoutMs=610000}={}) {
    this.cfg=cfg;this.store=store;this.busy=busy;this.start=start;this.timeoutMs=timeoutMs;this.cleanup=cleanup;
    this.home=path.join(cfg.workspace,'state','tdl');this.phase='idle';this.stopping=false;
  }
  get active(){return this.phase!=='idle';}
  say(text){if(!this.stopping&&this.cfg.allowed.has(this.cfg.owner))this.store.enqueue(this.cfg.owner,{text});}
  async init() {
    try {await this.cleanup(this.home);}catch {console.error('Telegram login temporary-file cleanup failed; private details suppressed');}
    if(this.store.get('tdl-auth:attempt'))this.say('Telegram user login was interrupted by a restart. Use /tdl_auth status or start a new /tdl_auth attempt.');
    this.store.set('tdl-auth:attempt','');
    this.store.db.prepare("UPDATE outbox SET state='expired' WHERE state='pending' AND json_extract(payload,'$.type')='tdl-auth'").run();
  }
  command(command) {
    if(command==='/tdl_auth cancel'){void this.cancel();return;}
    if(command==='/tdl_auth status') {
      if(this.active){this.say(this.phase==='draining'?'Waiting for active work to finish before Telegram user login.':'Telegram user login is in progress. Use /tdl_auth to show the latest QR, or /tdl_auth cancel.');return;}
      void fs.stat(path.join(this.home,'.tdl/data/owner')).then(()=>this.say('A local Telegram user session is saved. Reading a chat verifies whether it is still authorized.'),()=>this.say('No local Telegram user session is saved. Use /tdl_auth to connect your account.'));return;
    }
    if(command!=='/tdl_auth'){this.say('Use /tdl_auth, /tdl_auth status or /tdl_auth cancel. Never send passwords or login codes here.');return;}
    if(this.active){if(this.phase==='waiting')this.queue();else this.say('Preparing or finishing Telegram user login. Please wait.');return;}
    this.phase='draining';this.store.set('tdl-auth:attempt',randomUUID());
    this.say('Preparing Telegram user login. New model work is paused until login finishes; active work will finish first. Scan the QR using Telegram Settings → Devices → Link Desktop Device on another screen. Never send a password here.');
  }
  tick(){if(!this.stopping&&this.phase==='draining'&&!this.busy()){this.phase='starting';this.task=this.login();}}
  queue() {
    const s=this.session;if(!s?.qr||s.cancelled)return;
    const pending=this.store.db.prepare("SELECT id FROM outbox WHERE state IN ('pending','sending') AND json_extract(payload,'$.type')='tdl-auth' AND json_extract(payload,'$.attempt')=? AND json_extract(payload,'$.version')=?").get(s.id,s.qr.version);
    if(!pending)this.store.enqueue(this.cfg.owner,{type:'tdl-auth',attempt:s.id,version:s.qr.version});
  }
  payload(attempt,version) {
    const s=this.session;
    if(this.phase!=='waiting'||s?.id!==attempt||s.cancelled||s.qr?.version!==version||Date.now()-s.qr.created>30000)return null;
    return {type:'photo',path:s.qr.path,caption:'Scan with Telegram Settings → Devices → Link Desktop Device. Use the newest QR; it expires quickly. /tdl_auth cancel stops login.'};
  }
  async login() {
    const s={id:randomUUID(),qr:null,result:'failed',cancelled:false};this.session=s;
    try {
      const child=this.start(this.home,this.cfg.owner);s.child=child;
      const closed=new Promise(resolve=>{child.once('close',code=>resolve(code));child.once('error',()=>resolve(-1));});
      child.stdin.on('error',()=>{});
      const lines=createInterface({input:child.stdout});
      lines.on('line',line=>{
        try {
          if(line.length>2048)return;
          const e=JSON.parse(line);
          if(e.type==='qr'&&!s.cancelled) {
            const relative=path.relative(this.home,e.path||'');
            if(!/^qr-login-[\w-]+\/qr-\d+\.png$/.test(relative)||!Number.isSafeInteger(e.version)||e.version<1)return;
            if(s.qr&&e.version<=s.qr.version)return;
            s.qr={path:e.path,version:e.version,created:Date.now()};this.phase='waiting';this.queue();
          } else if(e.type==='verified') {
            s.qr=null;this.phase='finishing';if(!s.cancelled&&!this.stopping)child.stdin.write('commit\n');else child.stdin.end();
          } else if(['saved','password_required','owner_mismatch','busy','expired','failed','cancelled'].includes(e.type)) {s.result=e.type;s.qr=null;}
        } catch { /* Private subprocess output is never logged or persisted. */ }
      });
      s.timer=setTimeout(()=>{s.result='expired';void this.cancel();},this.timeoutMs);
      const code=await closed;lines.close();
      if(code!==0&&s.result==='saved')s.result='failed';
    } catch {s.result='failed';}
    finally {
      clearTimeout(s.timer);clearTimeout(s.killTimer);s.qr=null;this.session=null;this.phase='idle';this.store.set('tdl-auth:attempt','');
      const messages={saved:'Telegram user login saved and verified against this bot’s owner. You can now ask me to read a specific chat.',password_required:'Telegram requires a 2FA password. Complete login on the Docker host with ./bin/agent tdl-login NAME. Never send your password here.',owner_mismatch:'The scanned Telegram account does not match this bot’s owner. The existing session was kept. Scan with the owner account and try /tdl_auth again.',busy:'tdl is already in use. Retry /tdl_auth after that operation finishes.',expired:'Telegram QR login expired. Use /tdl_auth to try again.',cancelled:'Telegram user login cancelled.',failed:'Telegram user login could not complete. Check that the rebuilt image includes tdl and try again. Private error details suppressed.'};
      this.say(messages[s.result==='saved'?'saved':s.cancelled&&s.result!=='expired'?'cancelled':s.result]||messages.failed);
    }
  }
  async cancel() {
    if(!this.active){this.say('No Telegram user login is in progress.');return;}
    if(this.phase==='draining'){this.phase='idle';this.store.set('tdl-auth:attempt','');this.say('Telegram user login cancelled.');return;}
    const s=this.session;if(!s||s.cancelled)return;
    s.cancelled=true;s.qr=null;s.child?.stdin.end();s.child?.kill('SIGTERM');
    s.killTimer=setTimeout(()=>s.child?.kill('SIGKILL'),1500);
    await this.task;
  }
  async close(){this.stopping=true;await this.cancel();await this.task;}
}
