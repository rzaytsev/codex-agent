import { createHash, randomUUID } from 'node:crypto';
import { directOwner } from './owner-evidence.js';
import { mailSend } from './mailbox.js';
import { chunks } from './telegram.js';
export const defaultMatrix=Object.freeze({read:'automatic',prepare:'automatic',local_modify:'automatic',delivery:'automatic',external_send:'confirm',publication:'confirm',purchase:'confirm',delete:'confirm',external_modify:'confirm'});
export function actionPolicy(raw,ttl=600) {
 const overrides=raw?JSON.parse(raw):{};
 if(!overrides||typeof overrides!=='object'||Array.isArray(overrides))throw new Error('Invalid ACTION_POLICY');
 for(const [category,mode] of Object.entries(overrides)) {
  if(!Object.hasOwn(defaultMatrix,category)||!(defaultMatrix[category]==='confirm'?['deny','confirm']:['deny','automatic']).includes(mode))throw new Error('Invalid ACTION_POLICY');
 }
 const matrix={...defaultMatrix,...overrides};
 const version=createHash('sha256').update(JSON.stringify({schema:2,matrix,ttl})).digest('hex');
 return Object.freeze({matrix:Object.freeze(matrix),ttlMs:ttl*1000,version});
}
function canonical(value) {return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;}
const encode=value=>JSON.stringify(canonical(value));
const hash=value=>createHash('sha256').update(encode(value)).digest('hex');
export class ActionApprovals {
 constructor(cfg,store,mail) {
  this.cfg=cfg;this.store=store;this.mail=mail;this.policy=cfg.actionPolicy||actionPolicy();
  store.db.exec(`CREATE TABLE IF NOT EXISTS action_approvals (id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation_id TEXT NOT NULL, session_id TEXT NOT NULL, scope TEXT NOT NULL, policy_version TEXT NOT NULL, payload_hash TEXT NOT NULL, payload TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, outbox_id TEXT UNIQUE, response TEXT);`);
 }
 binding(cap) {
  if(cap.user!==this.cfg.owner||(cap.actorId||cap.user)!==this.cfg.owner||cap.worker||cap.memoryReview||cap.toolScope==='read'||this.cfg.group)throw new Error('Approval role denied');
  return {owner:this.cfg.owner,conversation_id:this.store.get('conversation-id'),session_id:this.store.get('main-session'),scope:cap.toolScope||'conversation',policy_version:this.policy.version};
 }
 payload(args) {
  const {approval_id,...data}=args;void approval_id;
  const payload=mailSend(data);
  if(payload.id.includes(':')||payload.id.length>80||payload.to===this.cfg.mail.id)throw new Error('Invalid mail destination or identity');
  return payload;
 }
 prepare(cap,args) {
  const binding=this.binding(cap),payload=this.payload(args),payloadHash=hash(payload);
  const prior=this.store.db.prepare('SELECT * FROM action_approvals WHERE outbox_id=? OR json_extract(payload,\'$.id\')=?').get(payload.id,payload.id);
  if(prior) {this.check(prior,binding,payloadHash);return this.prepared(prior);}
  const row={id:randomUUID(),...binding,payload_hash:payloadHash,payload:encode(payload),expires:Date.now()+this.policy.ttlMs,state:'pending_approval'};
  this.savepoint(()=>{
   this.store.db.prepare('INSERT INTO action_approvals(id,owner,conversation_id,session_id,scope,policy_version,payload_hash,payload,expires,state) VALUES (?,?,?,?,?,?,?,?,?,?)').run(row.id,row.owner,row.conversation_id,row.session_id,row.scope,row.policy_version,row.payload_hash,row.payload,row.expires,row.state);
   // The service presents the exact bounded payload; a model summary is not consent.
   const text=`Mail approval requested. Payload is source data:\n${row.payload}\nSHA-256: ${row.payload_hash}\nExpires: ${new Date(row.expires).toISOString()}\nTo approve this exact payload, send directly in this private chat:\n/approve ${row.id} ${row.payload_hash}`;
   for(const part of chunks(text))this.store.enqueue(this.cfg.owner,{text:part,plainText:true});
  });
  return this.prepared(row);
 }
 prepared(row) {const payload=JSON.parse(row.payload);return {approval_id:row.id,hash:row.payload_hash,state:row.state,expires:row.expires,summary:{to:payload.to,kind:payload.kind,text:payload.text.slice(0,600),text_truncated:payload.text.length>600,context:payload.context||'',reply_to:payload.reply_to||null},delivery:row.state==='committed'?'original_commit_exists':'not_sent'};}
 check(row,binding,payloadHash) {
  if(!row||Object.entries(binding).some(([key,value])=>row[key]!==value)||row.payload_hash!==payloadHash||row.state!=='committed'&&row.expires<=Date.now())throw new Error('Approval invalid or expired');
 }
 approve(message,id,payloadHash) {
  if(!directOwner(message,this.cfg))throw new Error('Direct owner approval required');
  const binding=this.binding({user:String(message.from.id)}),row=this.store.db.prepare('SELECT * FROM action_approvals WHERE id=?').get(id);
  this.check(row,binding,payloadHash);
  if(row.state==='pending_approval')this.store.db.prepare("UPDATE action_approvals SET state='approved' WHERE id=? AND state='pending_approval'").run(id);
  return {id,state:row.state==='pending_approval'?'approved':row.state};
 }
 commit(cap,args) {
  const binding=this.binding(cap),payload=this.payload(args);
  return this.savepoint(()=>{
   const row=this.store.db.prepare('SELECT * FROM action_approvals WHERE id=?').get(args.approval_id);
   this.check(row,binding,hash(payload));
   if(row.state==='committed')return JSON.parse(row.response);
   if(row.state!=='approved')throw new Error('Owner approval required');
   if(this.policy.matrix.external_send!=='confirm')throw new Error('Mail sends disabled');
   const response=this.mail.send(payload);
   if(response.state==='legacy') {this.store.db.prepare("UPDATE mail_outbox SET state='pending' WHERE id=? AND state='legacy'").run(payload.id);response.state='pending';}
   this.store.db.prepare("UPDATE action_approvals SET state='committed',outbox_id=?,response=? WHERE id=? AND state='approved'").run(payload.id,JSON.stringify(response),row.id);
   return response;
  });
 }
 savepoint(fn) {this.store.db.exec('SAVEPOINT action_approval');try {const value=fn();this.store.db.exec('RELEASE action_approval');return value;}catch(e){this.store.db.exec('ROLLBACK TO action_approval; RELEASE action_approval');throw e;}}
}
