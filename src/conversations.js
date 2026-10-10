import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { Service } from './service.js';
import { Agent } from './agent.js';
import { migrateConversation } from './conversation-migration.js';
import { workspaceFile } from './media.js';
import { authorized } from './config.js';

// Telegram offsets are UTF-16 code units, exactly the indexing used by slice.
export function addressed(message,username) {
  if(!username||message?.from?.is_bot||!message?.from?.id)return false;
  const text=message.text??message.caption??'';
  const entities=message.text!==undefined?message.entities:message.caption_entities;
  return (entities||[]).some(entity=>{
    if(!Number.isInteger(entity.offset)||!Number.isInteger(entity.length)||entity.offset<0||entity.length<1||entity.offset+entity.length>text.length)return false;
    const token=text.slice(entity.offset,entity.offset+entity.length).toLowerCase();
    return entity.type==='mention'&&token===`@${username.toLowerCase()}`||entity.type==='bot_command'&&entity.offset===0&&/^\/[a-z0-9_]+@/i.test(token)&&token.split('@')[1]===username.toLowerCase();
  });
}
export function normalizeCommand(message,username) {
  const text=message.text;
  if(typeof text!=='string')return message;
  const first=(message.entities||[]).find(e=>e.type==='bot_command'&&e.offset===0);
  if(!first)return message;
  const token=text.slice(0,first.length),parts=token.split('@');
  if(parts.length>1&&parts[1].toLowerCase()!==username?.toLowerCase())return null;
  return {...message,text:(parts[0]+text.slice(first.length)).trim()};
}

export class Conversations {
  constructor(dm,{agentFactory}={}) {
    this.dm=dm;this.services=new Map();this.sequence=0;this.mainServed=new Map();this.workerServed=new Map();this.agentFactory=agentFactory;this.username='';this.topicsEnabled=false;
  }
  all() {return [this.dm,...this.services.values()];}
  get busy() {return this.all().some(s=>s.activeMain||s.activeWorkers>0);}
  async init() {
    for(const row of this.dm.store.db.prepare("SELECT * FROM conversations WHERE kind IN ('group','topic')").all())await this.open(row);
    this.dm.store.set('shared-owner-store-version','2');
  }
  async open(row) {
    if(this.services.has(row.id))return this.services.get(row.id);
    const root=await fs.realpath(this.dm.cfg.workspace);
    if(row.kind==='group')await migrateConversation(this.dm.store,root,this.dm.cfg.codexHome,row);
    const workspace=root;
    const topic=row.kind==='topic';
    const cfg={...this.dm.cfg,workspace,...(topic?{topic:row}:{group:row}),conversation:{id:row.id,chatId:row.chat_id,messageThreadId:row.message_thread_id,kind:row.kind,title:row.title,sessionId:row.session_id},conversationSettings:JSON.parse(row.settings),proactive:false,cleanupEnabled:false};
    const store=new Store(this.dm.store.file);
    const thread=topic?row.message_thread_id:undefined;
    const telegram={download:(...args)=>this.dm.telegram.download(...args),startTyping:()=>this.dm.telegram.startTyping?.(row.chat_id,thread)||(()=>{}),action:(_,action)=>this.dm.telegram.action?.(row.chat_id,action,thread),sendPart:async(_,payload)=>{
      if(row.state!=='active'||topic&&!this.topicsEnabled)throw new Error('Conversation unavailable');
      if(payload.path)await workspaceFile(workspace,payload.path);
      return this.dm.telegram.sendPart(row.chat_id,payload,thread);
    }};
    const service=new Service(cfg,store,telegram,null,this.dm.usageReader,this.dm);
    service.conversations=this;
    if(topic)Object.defineProperties(service,{auth:{get:()=>this.dm.auth},tdlAuth:{get:()=>this.dm.tdlAuth}});
    const capability=(...args)=>this.issueCapability(service,...args);
    capability.release=token=>{service.releaseCapability(token);this.dm.capabilities.delete(token);this.routes.delete(token);};
    this.routes??=new Map();
    service.agent=this.agentFactory?this.agentFactory(service):new Agent(cfg,store,capability,undefined,service.memory,service.learning);
    await service.init();
    if(this.dm.store.get('memory-export-dirty')==='1')this.dm.memory.project();
    if(this.dm.store.get('learning-export-dirty')==='1')this.dm.learning.project();
    store.db.prepare('UPDATE conversations SET state=?,chat_id=? WHERE id=?').run(row.state,row.chat_id,row.id);
    this.dm.store.db.prepare('UPDATE conversations SET session_id=? WHERE id=?').run(store.get('main-session'),row.id);
    this.services.set(row.id,service);if(this.dm.store.onEnqueue)service.startDelivery();return service;
  }
  setIdentity(identity) {
    this.username=identity.username;
    const enabled=identity.has_topics_enabled===true,changed=enabled!==this.topicsEnabled;
    this.topicsEnabled=enabled;
    if(changed&&enabled)for(const service of this.services.values())if(service.cfg.topic)service.store.onEnqueue?.();
  }
  available(service) {return service===this.dm||service.cfg.group?.state==='active'||Boolean(this.topicsEnabled&&service.cfg.topic?.state==='active');}
  async topic(update,message) {
    const thread=message.message_thread_id;
    if(!this.topicsEnabled||!Number.isSafeInteger(thread)||thread<1||thread>2147483647)return false;
    let row=this.dm.store.db.prepare("SELECT * FROM conversations WHERE kind='topic' AND chat_id=? AND message_thread_id=?").get(String(message.chat.id),thread);
    if(!row) {
      const id=randomUUID();this.dm.store.db.prepare('INSERT INTO conversations(id,owner,chat_id,message_thread_id,kind,title,session_id) VALUES (?,?,?,?,?,?,?)').run(id,this.dm.cfg.owner,String(message.chat.id),thread,'topic',String(message.forum_topic_created?.name||''),randomUUID());
      row=this.dm.store.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
    }
    const service=await this.open(row);
    if(message.forum_topic_created||message.forum_topic_edited) {
      return service.store.transaction(()=>{
        if(!service.store.ingest(update.update_id,this.dm.cfg.owner,{event:true,text:'Telegram topic metadata updated'}))return false;
        service.store.prepare("UPDATE inputs SET state='done' WHERE $scope AND id=?").run(update.update_id);
        const name=message.forum_topic_created?.name??message.forum_topic_edited?.name;
        if(typeof name==='string'){service.store.db.prepare('UPDATE conversations SET title=? WHERE id=?').run(name,row.id);row.title=name;service.cfg.topic.title=name;}
        return true;
      });
    }
    // Topic service events are metadata, never model requests.
    if(message.forum_topic_closed||message.forum_topic_reopened||message.general_forum_topic_hidden||message.general_forum_topic_unhidden)return false;
    return service.ingest({...update,...(update.message?{message}:{edited_message:message})});
  }
  async ingest(update) {
    const message=update.message||update.edited_message;
    if(update.my_chat_member) {
      const change=update.my_chat_member,row=this.find(change.chat?.id);
      if(row&&['left','kicked'].includes(change.new_chat_member?.status))this.disconnect(row.id);
      return false;
    }
    if(message?.chat?.type==='private') {
      if(!authorized(message,this.dm.cfg))return false;
      if(update.edited_message&&!message.location)return false;
      const normalized=normalizeCommand(message,this.username);if(!normalized)return false;
      if(/^\/group(?:\s|$)/.test(normalized.text||'')&&String(message.from?.id)===this.dm.cfg.owner&&!message.from?.is_bot&&String(message.chat.id)===this.dm.cfg.owner&&!message.forward_origin)return this.command({...update,message:normalized});
      if(message.message_thread_id!==undefined)return this.topic(update,normalized);
      if(message.is_topic_message)return false;
      return this.dm.ingest({...update,...(update.message?{message:normalized}:{edited_message:normalized})});
    }
    if(!['group','supergroup'].includes(message?.chat?.type)||message.message_thread_id||message.from?.is_bot)return false;
    let row=this.find(message.chat.id);
    if(row&&(message.migrate_to_chat_id||message.migrate_from_chat_id)) {
      if(message.migrate_to_chat_id)this.migrate(row,String(message.migrate_to_chat_id));
      return false;
    }
    if(!row&&message.migrate_from_chat_id) {row=this.find(message.migrate_from_chat_id);if(row)this.migrate(row,String(message.chat.id));return false;}
    if(update.edited_message||String(message.from?.id)!==this.dm.cfg.owner||!addressed(message,this.username))return false;
    const normalized=normalizeCommand(message,this.username);if(!normalized)return false;
    const command=normalized.text?.trim();
    if(['/link','/unlink'].includes(command)&&String(message.from.id)===this.dm.cfg.owner&&!message.forward_origin) {
      if(!this.dm.store.ingest(update.update_id,this.dm.cfg.owner,{event:true,text:'Owner group connection command'}))return false;
      this.dm.store.db.prepare("UPDATE inputs SET state='done' WHERE id=?").run(update.update_id);
      if(command==='/unlink'){if(row)this.disconnect(row.id);return true;}
      if(!row){const id=randomUUID();this.dm.store.db.prepare('INSERT INTO conversations(id,owner,chat_id,kind,title,session_id) VALUES (?,?,?,?,?,?)').run(id,this.dm.cfg.owner,String(message.chat.id),'group',String(message.chat.title||''),randomUUID());row=this.find(message.chat.id);}
      row.state='active';this.dm.store.db.prepare("UPDATE conversations SET state='active',title=? WHERE id=?").run(String(message.chat.title||''),row.id);
      const service=await this.open(row);service.cfg.group.state='active';service.cfg.group.chat_id=row.chat_id;service.stopping=false;
      service.store.enqueue(this.dm.cfg.owner,{text:'Group connected. Your memory, rules and tools are shared; this chat has its own conversation. Mention me to begin.'});return true;
    }
    if(!row||row.state!=='active')return false;
    const service=await this.open(row);if(service.cfg.group.state!=='active')return false;
    service.cfg.group.title=String(message.chat.title||'');
    this.dm.store.db.prepare('UPDATE conversations SET title=? WHERE id=?').run(service.cfg.group.title,row.id);
    return service.ingest({...update,message:normalized});
  }
  find(chatId) {return this.dm.store.db.prepare("SELECT * FROM conversations WHERE kind='group' AND chat_id=?").get(String(chatId));}
  issueCapability(service,...args) {const token=service.capability(...args);this.dm.capabilities.set(token,service.capabilities.get(token));this.routes.set(token,service);return token;}
  migrate(row,chatId) {
    if(!/^-\d+$/.test(chatId)||this.find(chatId))return;
    this.dm.store.db.prepare('UPDATE conversations SET chat_id=? WHERE id=?').run(chatId,row.id);
    const service=this.services.get(row.id);if(service){service.cfg.group.chat_id=chatId;service.store.db.prepare('UPDATE conversations SET chat_id=? WHERE id=?').run(chatId,row.id);}
  }
  disconnect(id) {
    this.dm.store.db.prepare("UPDATE conversations SET state='disconnected' WHERE id=? AND kind='group'").run(id);
    const service=this.services.get(id);if(service){service.cfg.group.state='disconnected';for(const ctrl of service.controllers.values())ctrl.abort();for(const token of service.capabilities.keys()){service.releaseCapability(token);this.dm.capabilities.delete(token);this.routes.delete(token);}service.store.db.prepare("UPDATE conversations SET state='disconnected' WHERE id=?").run(id);}
  }
  async command(update) {
    if(!this.dm.store.ingest(update.update_id,this.dm.cfg.owner,{event:true,text:'Owner group management command'}))return false;
    this.dm.store.db.prepare("UPDATE inputs SET state='done' WHERE id=?").run(update.update_id);
    let text;
    try {
      const [,action,id,...parts]=update.message.text.split(/\s+/);
      const row=id?this.dm.store.db.prepare("SELECT * FROM conversations WHERE id=? AND kind='group'").get(id):undefined;
      if(!action)text=this.dm.store.db.prepare("SELECT id,title,state FROM conversations WHERE kind='group'").all().map(r=>`${r.id}: ${r.title} (${r.state})`).join('\n')||`No linked groups. Send /link@${this.username} in a group as the owner.`;
      else if(action==='disconnect'&&row&&!parts.length){this.disconnect(id);text='Group disconnected. Its queued results remain at the original destination.';}
      else if(action==='settings'&&row) {
        const settings=JSON.parse(parts.join(' ')),service=await this.open(row);
        service.effectiveSettings('main',settings);service.effectiveSettings('worker',settings);
        this.dm.store.db.prepare('UPDATE conversations SET settings=? WHERE id=?').run(JSON.stringify(settings),id);service.cfg.conversationSettings=settings;
        this.invalidate(service);text='Conversation settings updated; model sessions were reset.';
      } else if(action==='share'&&row&&row.state==='active'&&parts.length) {
        // Deliberately selected text, not automatic access to personal resources.
        const service=await this.open(row);service.store.enqueue(this.dm.cfg.owner,{text:parts.join(' ')});text='Selected text queued to the group.';
      } else throw new Error('Invalid group command');
    } catch {text='Use /group; /group disconnect ID; /group settings ID {"effort":"medium"}; or /group share ID selected text.';}
    this.dm.store.enqueue(this.dm.cfg.owner,{text});return true;
  }
  invalidate(service) {
    for(const ctrl of service.controllers.values())ctrl.abort();
    for(const token of service.capabilities.keys()){service.releaseCapability(token);this.dm.capabilities.delete(token);this.routes?.delete(token);}
    service.store.rotateSession(service.cfg.owner);
    service.store.prepare("UPDATE jobs SET thread=NULL WHERE $scope AND thread IS NOT NULL").run();
  }
  invalidateAll() {for(const service of this.services.values())this.invalidate(service);}
  tick() {
    const services=this.all(),ordered=services.slice().sort((a,b)=>(this.mainServed.get(a)||0)-(this.mainServed.get(b)||0));
    let mains=services.filter(s=>s.activeMain).length,workers=services.reduce((n,s)=>n+s.activeWorkers,0),active=mains+workers;
    const ready=(!this.dm.auth||this.dm.auth.ready)&&!this.dm.tdlAuth?.active;
    const eligible=services.filter(s=>this.available(s));
    const pending=eligible.some(s=>s.store.prepare("SELECT id FROM inputs WHERE $scope AND state='pending' LIMIT 1").get());
    const ordinaryQueued=eligible.some(s=>s.store.prepare("SELECT id,prompt FROM jobs WHERE $scope AND state='queued'").all().some(job=>!s.idleMaintenance(job)));
    if(pending||ordinaryQueued)for(const service of services)for(const job of service.store.prepare("SELECT id,prompt FROM jobs WHERE $scope AND state='running'").all())if(service.idleMaintenance(job))service.controllers.get(job.id)?.abort();
    for(const service of ordered) {
      if(!this.available(service))continue;
      service.schedules();void service.deliver();
      const modelReady=ready;
      if((modelReady||!service.cfg.group)&&!service.mainBusy&&mains<this.dm.cfg.maxMainTurns&&active<this.dm.cfg.maxExecutions) {
        // conversation() allocates its controller synchronously before its first await.
        service.activeTurn=service.conversation(modelReady);if(service.mainBusy){mains++;active++;this.mainServed.set(service,++this.sequence);}
      }
    }
    for(const service of services.slice().sort((a,b)=>(this.workerServed.get(a)||0)-(this.workerServed.get(b)||0))) {
      if(!ready||!this.available(service))continue;
      if(services.some(s=>s.store.prepare("SELECT id,prompt FROM jobs WHERE $scope AND state IN ('running','cancel_requested')").all().some(job=>s.idleMaintenance(job))))break;
      const before=service.controllers.size;
      service.workers(Math.min(1,this.dm.cfg.maxWorkers-workers,this.dm.cfg.maxExecutions-active),active===0&&!pending&&!ordinaryQueued);
      const started=service.controllers.size-before;workers+=started;active+=started;if(started)this.workerServed.set(service,++this.sequence);
    }
  }
  async stop() {await Promise.allSettled(this.all().map(service=>service.stop()));}
}
