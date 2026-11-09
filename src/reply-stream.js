import {randomInt,createHash} from 'node:crypto';
import {privateControlService} from './controls.js';
export class ReplyStreams {
  constructor(service) {
    this.s=service;this.store=service.store;this.active=new Map();
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS telegram_reply_drafts (
      draft_id INTEGER PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL,
      session_id TEXT NOT NULL, input_id INTEGER NOT NULL, state TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0, sends INTEGER NOT NULL DEFAULT 0,
      chars INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);`);
  }
  begin(input,signal) {
    if(this.s.cfg.group||typeof this.s.telegram.draft!=='function')return;
    let id;do{id=randomInt(1,2147483647);}while(this.store.db.prepare('SELECT 1 FROM telegram_reply_drafts WHERE draft_id=?').get(id));
    const d={id,input:input.id,session:input.session_id,signal,text:'',sequence:0,parts:new Map(),closed:false,failed:false,last:0};
    this.store.db.prepare("INSERT INTO telegram_reply_drafts(draft_id,owner,conversation_id,session_id,input_id,state,created) VALUES (?,?,?,?,?,'active',?)").run(id,input.user,this.store.get('conversation-id'),input.session_id,input.id,Date.now());
    this.active.set(input.id,d);d.abort=()=>this.close(d);signal.addEventListener('abort',d.abort,{once:true});
    d.refresh=setInterval(()=>void this.flush(d,true),20000);d.refresh.unref();void this.flush(d,true);
  }
  current(d) {
    return !this.s.stopping&&this.s.cfg.allowed.has(this.s.cfg.owner)&&d.session===this.store.get('main-session')&&this.s.mainInput===d.input&&Boolean(this.s.controllers.get('main'))&&(!this.s.cfg.topic||this.s.conversations?.topicsEnabled&&this.s.cfg.topic.state==='active');
  }
  async flush(d,force=false) {
    if(d.closed||d.failed||d.signal.aborted||!this.current(d))return;
    if(d.pending){d.again=true;return;}
    const delay=Math.max(0,800-(Date.now()-d.last));
    if(delay&&!force){clearTimeout(d.timer);d.timer=setTimeout(()=>void this.flush(d),delay);d.timer.unref();return;}
    d.last=Date.now();const text=d.text;
    d.pending=(async()=>{
      try {
        await this.s.telegram.draft(this.s.cfg.owner,d.id,text,d.signal);
        this.store.db.prepare('UPDATE telegram_reply_drafts SET sends=sends+1,chars=? WHERE draft_id=?').run(text.length,d.id);
      } catch {d.failed=true;if(!d.closed&&!d.signal.aborted&&this.current(d)){try{d.stopTyping=this.s.telegram.startTyping?.(this.s.cfg.owner);}catch{}}}
    })();
    try{await d.pending;}finally{d.pending=null;if(d.again){d.again=false;void this.flush(d);}}
  }
  append(cap,{sequence,text}) {
    const d=this.active.get(cap.inputId);
    if(!d||d.closed||!this.current(d)||d.signal.aborted)throw new Error('Reply preview unavailable');
    const hash=createHash('sha256').update(text).digest('hex'),prior=d.parts.get(sequence);
    if(prior){if(prior.hash!==hash)throw new Error('Stream sequence conflict');return prior.response;}
    if(sequence!==d.sequence+1)throw new Error('Stream sequence must increase by one');
    d.text=Array.from(d.text+text).slice(0,1700).join('');d.sequence=sequence;
    const response={queued:!d.failed,sequence,preview_chars:d.text.length};d.parts.set(sequence,{hash,response});
    this.store.db.prepare('UPDATE telegram_reply_drafts SET sequence=? WHERE draft_id=?').run(sequence,d.id);void this.flush(d);return response;
  }
  close(d) {d.closed=true;clearInterval(d.refresh);clearTimeout(d.timer);d.stopTyping?.();d.stopTyping=null;}
  async pause(inputId=this.s.mainInput) {
    const d=this.active.get(inputId);if(!d)return;this.close(d);await d.pending;
  }
  async end(input) {
    const d=this.active.get(input.id);if(!d)return;
    await this.pause(input.id);d.signal.removeEventListener('abort',d.abort);this.active.delete(input.id);
    const state=this.store.prepare('SELECT state FROM inputs WHERE $scope AND id=?').get(input.id)?.state||'interrupted';
    this.store.db.prepare("UPDATE telegram_reply_drafts SET state=? WHERE draft_id=? AND state='active'").run(state==='done'?'finished':state,d.id);
  }
  recover() {this.store.prepare("UPDATE telegram_reply_drafts SET state='interrupted' WHERE $scope AND state='active'").run();}
  async stop(update,router) {
    const q=update.stopped_message_generation,cfg=this.s.cfg;
    // Telegram serializes this int64 as a decimal string. Match only exact IDs
    // in our issued positive int32 range, retaining numeric fixture compatibility.
    const wireId=q?.draft_id,id=typeof wireId==='string'&&wireId.length<=10&&String(Number(wireId))===wireId?Number(wireId):wireId;
    const reject=reason=>{console.log('Native reply Stop rejected: '+reason);return false;};
    if(!q||!Number.isSafeInteger(update.update_id))return reject('invalid_update');
    if(!cfg.allowed.has(cfg.owner))return reject('owner_revoked');
    if(q.chat?.type!=='private')return reject('chat_type');
    if(String(q.chat.id)!==cfg.owner)return reject('wrong_owner');
    if(!Number.isSafeInteger(id))return reject('draft_type');
    if(id<1)return reject(id===0?'draft_zero':'draft_negative');
    const r=this.store.db.prepare("SELECT * FROM telegram_reply_drafts WHERE draft_id=? AND owner=? AND state='active'").get(id,cfg.owner);
    const service=r&&await privateControlService(router,r.conversation_id,cfg.owner);if(!service)return reject(r?'unavailable_conversation':'unknown_draft');
    if((q.message_thread_id??null)!==(service.cfg.topic?.message_thread_id??null)||r.session_id!==service.store.get('main-session')||service.mainInput!==r.input_id||!service.controllers.get('main'))return reject('stale_route');
    return service.store.transaction(()=>{
      if(!service.store.ingest(update.update_id,cfg.owner,{event:true,text:'Native reply Stop control'}))return false;
      service.store.prepare("UPDATE inputs SET state='done' WHERE $scope AND id=?").run(update.update_id);
      service.store.db.prepare("UPDATE telegram_reply_drafts SET state='stopped' WHERE draft_id=?").run(r.draft_id);service.requestMainStop();console.log('Native reply Stop accepted');return true;
    });
  }
}
