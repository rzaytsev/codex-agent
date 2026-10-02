import { randomUUID } from 'node:crypto';
import { AccountClient, readAccount } from './codex-account.js';

export class Auth {
  constructor(cfg,store,{busy=()=>false,reader=readAccount,clientFactory=()=>new AccountClient(cfg),timeoutMs=10*60*1000}={}) {
    this.cfg=cfg;this.store=store;this.busy=busy;this.reader=reader;this.clientFactory=clientFactory;this.timeoutMs=timeoutMs;
    this.status='checking';this.phase='idle';this.account=null;this.lastCheck=0;this.stopping=false;
  }
  get ready(){return this.status==='ready'&&this.phase==='idle'&&!this.stopping;}
  get health(){return this.phase!=='idle'?'setup:codex-login-pending':this.status==='ready'?'ready':this.status==='unavailable'?'degraded:codex-auth':'setup:codex-login';}
  say(text){if(!this.stopping&&this.cfg.allowed.has(this.cfg.owner))this.store.enqueue(this.cfg.owner,{text});}
  accountText() {
    if(this.status==='ready') {
      const email=this.account?.email;
      const masked=email&&email.includes('@')?email.slice(0,1)+'***@'+email.split('@').at(-1):'your ChatGPT account';
      return `Signed in as ${masked} (${this.account?.plan||'unknown'}).`;
    }
    return this.status==='unavailable'?'Account status is temporarily unavailable. Try /auth status again.':'Not signed in to ChatGPT. Use /auth to sign in.';
  }
  async init() {
    // A crash may occur after Codex saves the new login but before our completion callback.
    // Never resume an old model thread in that ambiguous state; durable history is retained.
    if(this.store.get('auth:attempt')) {
      this.store.transaction(()=>{this.store.set(`thread:${this.cfg.owner}`,'');this.store.set('auth:attempt','');});
      this.say('The previous login was interrupted by a restart. Its code is no longer used. Check /auth status or use /auth to try again.');
    }
    this.store.db.prepare("UPDATE outbox SET state='expired' WHERE state='pending' AND json_extract(payload,'$.type')='auth'").run();
    await this.check();
  }
  async check() {
    if(this.checking)return this.checking;
    if(this.phase!=='idle'||this.stopping)return;
    this.checking=Promise.resolve().then(async()=>{
      try {
        const account=await this.reader(this.cfg);
        if(this.stopping)return;
        this.account=account;this.status=account?'ready':'signed_out';
        if(account)this.store.set('auth:notice','');
        else this.notifyMissing();
      } catch {if(!this.stopping)this.status='unavailable';}
      finally {this.lastCheck=Date.now();this.checking=null;}
    });
    return this.checking;
  }
  notifyMissing() {
    if(this.phase!=='idle'||this.status!=='signed_out'||!this.store.get(`known:${this.cfg.owner}`)||this.store.get('auth:notice'))return;
    this.say('Please sign in to ChatGPT first using /auth. Your messages will wait until login succeeds.');this.store.set('auth:notice','1');
  }
  command(command) {
    if(command==='/auth status') {
      if(this.phase!=='idle'){this.say(this.phase==='draining'?'Waiting for active work to finish before login. Use /stop or /cancel <task-id> to stop it, or /auth cancel.':'Login is in progress. Use /auth to show the code or /auth cancel.');return;}
      void this.check().then(()=>this.say(this.accountText()));return;
    }
    if(command==='/auth cancel'){void this.cancel('cancelled');return;}
    if(command!=='/auth'&&command!=='/start'){this.say('Use /auth to sign in or change account, /auth status, or /auth cancel.');return;}
    if(this.phase!=='idle') {
      if(this.phase==='waiting')this.queueChallenge();
      else this.say(this.phase==='draining'?'Waiting for active work to finish. Use /stop or /cancel <task-id>, or /auth cancel.':'Preparing or checking your login. Please wait.');
      return;
    }
    this.phase='draining';this.store.set('auth:attempt',randomUUID());
    this.say(this.busy()?'New model work is paused. Login will start when active work finishes; /stop and /cancel <task-id> remain available.':'Preparing ChatGPT login. New model work is paused.');
  }
  tick() {
    if(this.stopping)return;
    if(this.phase==='draining'&&!this.busy()&&!this.checking) {
      this.phase='starting';this.task=this.login();
    } else if(this.phase==='idle'&&Date.now()-this.lastCheck>=60000)void this.check();
  }
  queueChallenge() {
    const session=this.session;if(!session?.challenge||this.phase!=='waiting')return;
    const pending=this.store.db.prepare("SELECT id FROM outbox WHERE state IN ('pending','sending') AND json_extract(payload,'$.type')='auth' AND json_extract(payload,'$.attempt')=?").get(session.id);
    if(!pending)this.store.enqueue(this.cfg.owner,{type:'auth',attempt:session.id});
  }
  payload(attempt) {
    const session=this.session;
    if(this.phase!=='waiting'||session?.id!==attempt||Date.now()>=session.deadline||session.cancelled)return null;
    return {text:`Open ${session.challenge.verificationUrl}\nSign in with the ChatGPT account you want this bot to use, then enter this one-time code: ${session.challenge.userCode}\nThis bot waits up to 10 minutes. Use a private browser window if it selects the wrong account. Enable device-code login in ChatGPT security settings if requested.\nNever send passwords or authentication files here. /auth cancel stops this attempt.`};
  }
  async login() {
    const session={id:randomUUID(),client:null,cancelled:false};this.session=session;
    let succeeded=false;
    try {
      const client=this.clientFactory();session.client=client;
      let completion;const early=[];
      const completed=new Promise(resolve=>{completion=resolve;});
      client.on('notification',message=>{
        if(message.method!=='account/login/completed')return;
        if(!session.loginId){if(early.length<4)early.push(message.params);}
        else if(message.params?.loginId===session.loginId)completion(message.params);
      });
      await client.initialize();
      const result=await client.request('account/login/start',{type:'chatgptDeviceCode'});
      if(session.cancelled)throw new Error('Cancelled');
      if(result?.type!=='chatgptDeviceCode'||typeof result.loginId!=='string'||!result.loginId||
        result.verificationUrl!=='https://auth.openai.com/codex/device'||typeof result.userCode!=='string'||! /^[A-Za-z0-9-]{4,64}$/.test(result.userCode))throw new Error('Invalid login response');
      session.loginId=result.loginId;session.challenge={verificationUrl:result.verificationUrl,userCode:result.userCode};
      session.deadline=Date.now()+this.timeoutMs;this.phase='waiting';this.queueChallenge();
      session.timer=setTimeout(()=>void this.cancel('expired'),this.timeoutMs);
      for(const event of early)if(event?.loginId===session.loginId)completion(event);
      const resultEvent=await Promise.race([completed,client.closed.then(()=>{throw new Error('Login disconnected');})]);
      succeeded=resultEvent?.success===true;
    } catch { /* Only controlled user-facing messages below; raw RPC errors can contain secrets. */ }
    finally {
      clearTimeout(session.timer);this.phase='finishing';session.challenge=null;
      if(session.client)await session.client.close();
      if(this.stopping)return;
      // Also reset on uncertain completion/cancel: credentials may already have been committed.
      this.store.transaction(()=>{this.store.set(`thread:${this.cfg.owner}`,'');this.store.set('auth:attempt','');});
      this.session=null;this.status='checking';this.phase='idle';await this.check();
      if(succeeded&&this.status==='ready')this.say(`Login saved. ${this.accountText()} Your profile, memory, files and history are preserved; the model conversation starts fresh.`);
      else if(session.cancelled)this.say(`Login ${session.reason}. ${this.accountText()}`);
      else this.say(`Login could not be completed or verified. ${this.accountText()} If device login is disabled, enable it in ChatGPT security settings and try /auth again.`);
    }
  }
  async cancel(reason) {
    if(this.phase==='idle'){this.say('No login is in progress.');return;}
    if(this.phase==='draining') {this.phase='idle';this.store.set('auth:attempt','');this.say('Login cancelled. '+this.accountText());return;}
    const session=this.session;if(!session||session.cancelled||this.phase==='finishing')return;
    session.cancelled=true;session.reason=reason;session.challenge=null;
    try {if(session.loginId)await session.client.request('account/login/cancel',{loginId:session.loginId});}catch{}
    finally {await session.client?.close();}
  }
  async close() {
    this.stopping=true;clearTimeout(this.session?.timer);
    await this.session?.client?.close();await this.task;await this.checking;
  }
}
