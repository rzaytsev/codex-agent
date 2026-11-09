import {randomUUID} from 'node:crypto';
import {responsePayloads} from './presentation.js';

export async function privateControlService(router,id,owner) {
  const row=router.dm.store.db.prepare('SELECT * FROM conversations WHERE id=? AND owner=?').get(id,owner);
  if(!row||row.state!=='active'||!['dm','topic'].includes(row.kind)||row.kind==='topic'&&!router.topicsEnabled)return null;
  return row.kind==='dm'?router.dm:router.open(row);
}
export class Controls {
  constructor(service) {
    this.s=service;this.store=service.store;
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS telegram_controls (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL,
      session_id TEXT NOT NULL, actor_id TEXT NOT NULL, kind TEXT NOT NULL,
      job_id TEXT UNIQUE, message_id INTEGER, revision INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL, text TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]',
      payloads TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_control_queries (
      id TEXT PRIMARY KEY, control_id TEXT NOT NULL, action TEXT NOT NULL, created INTEGER NOT NULL);`);
  }
  row(id) {return this.store.prepare('SELECT * FROM telegram_controls WHERE $scope AND owner=? AND id=?').get(this.s.cfg.owner,id);}
  valid(r) {
    if(!r||this.s.cfg.group||!this.s.cfg.allowed.has(r.owner)||r.owner!==this.s.cfg.owner||r.actor_id!==r.owner||r.conversation_id!==this.store.get('conversation-id'))return false;
    if(this.s.cfg.topic&&(!this.s.conversations?.topicsEnabled||this.s.cfg.topic.state!=='active'))return false;
    if(r.kind==='clarification')return r.session_id===this.store.get('main-session');
    return Boolean(this.store.prepare('SELECT id FROM jobs WHERE $scope AND id=? AND user=? AND session_id=? AND actor_id=?').get(r.job_id,r.owner,r.session_id,r.actor_id));
  }
  create(kind,text,{job,options=[]}={}) {
    const id=randomUUID(),owner=this.s.cfg.owner,session=job?.session_id||this.store.get('main-session'),actor=job?.actor_id||owner;
    this.store.db.prepare('INSERT INTO telegram_controls(id,owner,conversation_id,session_id,actor_id,kind,job_id,state,text,options,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,owner,this.store.get('conversation-id'),session,actor,kind,job?.id||null,job?.state||'pending',text,JSON.stringify(options),Date.now());
    this.store.enqueue(owner,{type:'control',controlId:id,revision:0},false,{sessionId:session,actorId:actor});return id;
  }
  task(job) {
    if(!this.s.telegram.supportsControls||this.s.cfg.group||job.user!==this.s.cfg.owner||job.actor_id&&job.actor_id!==this.s.cfg.owner)return;
    const prior=this.store.prepare("SELECT id FROM telegram_controls WHERE $scope AND job_id=?").get(job.id);if(prior)return prior.id;
    return this.create('task',this.store.get(`task-title:${job.id}`)||'Background task',{job});
  }
  refreshTask(id) {
    const r=this.store.prepare('SELECT * FROM telegram_controls WHERE $scope AND job_id=?').get(id);if(!r)return;
    const job=this.store.prepare('SELECT state FROM jobs WHERE $scope AND id=?').get(id);
    if(job&&r.state!==job.state)this.change(r,job.state);
  }
  completed(job,result,files) {
    const r=this.store.prepare('SELECT * FROM telegram_controls WHERE $scope AND job_id=?').get(job.id);if(!r)return;
    const payloads=[...files,...responsePayloads(result,{widgets:!this.s.cfg.group})];
    this.store.db.prepare('UPDATE telegram_controls SET payloads=? WHERE id=?').run(JSON.stringify(payloads),r.id);
    this.refreshTask(job.id);
  }
  change(r,state,text=r.text) {
    this.store.db.prepare('UPDATE telegram_controls SET revision=revision+1,state=?,text=? WHERE id=?').run(state,text,r.id);
    if(r.message_id)this.store.enqueue(r.owner,{type:'control-edit',controlId:r.id,revision:r.revision+1},false,{sessionId:r.session_id,actorId:r.actor_id});
  }
  expireQuestions() {
    for(const r of this.store.prepare("SELECT * FROM telegram_controls WHERE $scope AND kind='clarification' AND state='pending'").all())this.change(r,'expired');
  }
  clarify({question,options}) {
    if(!this.s.telegram.supportsControls||this.s.cfg.group)throw new Error('Clarification buttons require a supported private chat');
    return this.store.transaction(()=>{this.expireQuestions();return {queued:true,id:this.create('clarification',question,{options})};});
  }
  view(r) {
    const button=(text,action)=>({text,callback_data:`ctl:${r.id}:${action}`});let text=r.text,buttons=[];
    if(r.kind==='task') {
      const labels={queued:'Queued',running:'Working',cancel_requested:'Stopping…',completed:'Completed',cancelled:'Cancelled',failed:'Failed',interrupted:'Interrupted',superseded:'Superseded'};
      text+='\n'+(labels[r.state]||r.state);
      if(['queued','running'].includes(r.state))buttons=[button('Cancel','cancel')];
      if(r.state==='completed'&&r.payloads)buttons=[button('Open result','open')];
    } else if(r.state==='pending')buttons=JSON.parse(r.options).map((o,i)=>button(o.label,String(i)));
    else if(r.state==='expired')text+='\nThis question is no longer active.';
    return {text,replyMarkup:{inline_keyboard:buttons.map(b=>[b])}};
  }
  prepare(outbox,p) {
    const r=this.row(p.controlId);if(!this.valid(r)||outbox.user!==r.owner||outbox.session_id!==r.session_id||outbox.actor_id!==r.actor_id||p.type==='control-edit'&&(r.revision!==p.revision||!r.message_id))return null;
    return {type:p.type==='control-edit'?'control-edit':'control-message',...this.view(r),controlRevision:r.revision,...(r.message_id?{messageId:r.message_id}:{})};
  }
  register(outbox,p,result,revision) {
    if(p.type!=='control')return;const r=this.row(p.controlId);
    if(!this.valid(r)||!Number.isSafeInteger(result?.message_id)||result.message_id<1||String(result.chat?.id)!==String(this.s.cfg.conversation?.chatId||this.s.cfg.owner)||this.s.cfg.topic&&result.message_thread_id!==this.s.cfg.topic.message_thread_id)throw Object.assign(new Error('Invalid control receipt'),{code:'invalid-response'});
    this.store.db.prepare('UPDATE telegram_controls SET message_id=? WHERE id=? AND message_id IS NULL').run(result.message_id,r.id);
    if(revision!==r.revision)this.store.enqueue(r.owner,{type:'control-edit',controlId:r.id,revision:r.revision},false,{sessionId:r.session_id,actorId:r.actor_id});
  }
  recover() {
    for(const r of this.store.prepare('SELECT * FROM telegram_controls WHERE $scope').all()) {
      if(r.kind==='task')this.refreshTask(r.job_id);
      else if(r.state==='pending'&&r.session_id!==this.store.get('main-session'))this.change(r,'expired');
    }
  }
  async query(update,router) {
    const q=update.callback_query,cfg=this.s.cfg;
    if(!q||!cfg.allowed.has(cfg.owner)||q.from?.is_bot||String(q.from?.id)!==cfg.owner||q.message?.chat?.type!=='private'||String(q.message.chat.id)!==cfg.owner||q.inline_message_id||typeof q.id!=='string'||!q.id||q.id.length>256||typeof q.data!=='string'||!Number.isSafeInteger(update.update_id))return false;
    const m=/^ctl:([a-f0-9-]{36}):(cancel|open|[0-5])$/.exec(q.data);if(!m)return false;
    const bound=this.store.db.prepare('SELECT conversation_id FROM telegram_controls WHERE id=? AND owner=? AND message_id=?').get(m[1],cfg.owner,q.message.message_id);
    const service=bound&&await privateControlService(router,bound.conversation_id,cfg.owner);let accepted=false,notice='This control is no longer available.';
    if(service) {
      service.store.transaction(()=>{
        const controls=service.controls,r=controls.row(m[1]);if(!controls.valid(r)||r.message_id!==q.message.message_id||(q.message.message_thread_id??null)!==(service.cfg.topic?.message_thread_id??null)||service.cfg.topic&&q.message.message_thread_id!==service.cfg.topic.message_thread_id)return;
        const prior=service.store.db.prepare('SELECT control_id,action FROM telegram_control_queries WHERE id=?').get(q.id);
        if(prior){notice=prior.control_id===r.id&&prior.action===m[2]?'Already received.':notice;return;}
        const remember=()=>service.store.db.prepare('INSERT INTO telegram_control_queries VALUES (?,?,?,?)').run(q.id,r.id,m[2],Date.now());
        if(r.kind==='task') {
          const job=service.store.prepare('SELECT * FROM jobs WHERE $scope AND id=?').get(r.job_id);
          if(m[2]==='cancel'&&['queued','running','cancel_requested'].includes(job.state)) {remember();service.cancelTask(cfg.owner,job.id,cfg.owner);accepted=true;notice='Cancellation requested.';}
          else if(m[2]==='open'&&job.state==='completed'&&r.payloads) {remember();for(const p of JSON.parse(r.payloads))service.store.enqueue(cfg.owner,p,false,{sessionId:r.session_id,actorId:r.actor_id});accepted=true;notice='Result queued.';}
        } else if(r.state==='pending'&&/^\d$/.test(m[2])) {
          const option=JSON.parse(r.options)[Number(m[2])];if(!option)return;
          if(!service.store.ingest(update.update_id,cfg.owner,{event:true,controlId:r.id,text:`Clarification choice: ${option.label}\nQuestion: ${r.text}\nSelected option: ${option.value}\nThis is a clarification event, not typed owner text or approval. Continue within existing authority.`}))return;
          remember();controls.change(r,'answered',r.text+'\nSelected: '+option.label);accepted=true;notice='Selected.';
        }
      });
    }
    try{await this.s.telegram.call('answerCallbackQuery',{callback_query_id:q.id,text:notice},5000);}catch{}
    return accepted;
  }
}
