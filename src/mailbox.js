import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

export class MailError extends Error {
  constructor(message,code=400) {super(message);this.code=code;}
}
export function mailText(value,max=12000) {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new MailError('Invalid text');
  return value;
}
export function mailId(value) {
  if(typeof value!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,119}$/.test(value))throw new MailError('Invalid message ID');
  return value;
}
export function mailSend(args) {
  mailId(args.id);mailText(args.to,64);mailText(args.text);
  if(!['message','task_request','reply'].includes(args.kind))throw new MailError('Invalid message kind');
  if(args.context!==undefined&&(typeof args.context!=='string'||args.context.length>200))throw new MailError('Invalid context');
  if(args.kind==='reply')mailId(args.reply_to);
  else if(args.reply_to!=null)throw new MailError('Only replies have reply_to');
  return {id:args.id,to:args.to,kind:args.kind,text:args.text,context:args.context||'',reply_to:args.reply_to||null};
}

export class Mailbox {
  constructor(file,config) {
    this.config=config;
    const entries=Object.entries(config.identities||{});
    if(!entries.length||entries.some(([id,c])=>!/^[a-z][a-z0-9-]{0,63}$/.test(id)||typeof c.token!=='string'||c.token.length<32||!Array.isArray(c.peers)||c.peers.some(p=>!Object.hasOwn(config.identities,p)||p===id))||new Set(entries.map(([,c])=>c.token)).size!==entries.length)throw new Error('Invalid mailbox identity configuration');
    this.db=new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL, context TEXT NOT NULL, reply_to TEXT,
        state TEXT NOT NULL, delivered INTEGER, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS mail_recipient ON messages(recipient,delivered,seq);`);
  }
  authenticate(token) {
    if(typeof token!=='string')throw new MailError('Unauthorized',401);
    const bytes=Buffer.from(token);
    for(const [id,c] of Object.entries(this.config.identities)) {
      const expected=Buffer.from(c.token);
      if(bytes.length===expected.length&&timingSafeEqual(bytes,expected))return id;
    }
    throw new MailError('Unauthorized',401);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=fn();this.db.exec('COMMIT');return result;}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  canSend(from,to) {return from!==to&&Boolean(this.config.identities[from]?.peers.includes(to)&&this.config.identities[to]?.peers.includes(from));}
  record(id) {return this.db.prepare('SELECT * FROM messages WHERE id=?').get(mailId(id));}
  visible(actor,id) {
    const row=this.record(id);
    if(!row||![row.sender,row.recipient].includes(actor))throw new MailError('Message unavailable',404);
    return row;
  }
  insert({id,sender,recipient,kind,text,context='',reply_to=null,state='queued'}) {
    this.db.prepare('INSERT INTO messages(id,sender,recipient,kind,text,context,reply_to,state,created) VALUES (?,?,?,?,?,?,?,?,?)').run(id,sender,recipient,kind,text,context,reply_to,state,Date.now());
    return this.record(id);
  }
  statusEvent(row,state) {
    this.insert({id:`${row.id}:${state}`,sender:row.recipient,recipient:row.sender,kind:'status',text:state,reply_to:row.id});
  }
  request(actor,operation,args={}) {
    if(!Object.hasOwn(this.config.identities,actor))throw new MailError('Unauthorized',401);
    if(!args||typeof args!=='object'||Array.isArray(args))throw new MailError('Invalid arguments');
    if(operation==='list')return {identity:actor,agents:Object.keys(this.config.identities).filter(id=>this.canSend(actor,id))};
    if(operation==='send') {
      const value=mailSend(args);
      // Reserve space for service-generated status IDs.
      if(value.id.length>80||value.id.includes(':'))throw new MailError('Invalid outgoing ID');
      if(!this.canSend(actor,value.to))throw new MailError('Recipient not permitted',403);
      return this.transaction(()=>{
        const old=this.record(value.id);
        if(old) {
          if(old.sender!==actor||old.recipient!==value.to||old.kind!==value.kind||old.text!==value.text||old.context!==value.context||old.reply_to!==value.reply_to)throw new MailError('Message ID already used',409);
          return old;
        }
        if(value.kind==='reply') {
          const original=this.visible(actor,value.reply_to);
          if(original.recipient!==actor||original.sender!==value.to||!['message','task_request'].includes(original.kind))throw new MailError('Reply must address an original incoming request');
        }
        // Bound offline queues; senders can retry the same ID after consumption.
        if(this.db.prepare('SELECT count(*) AS n FROM messages WHERE sender=? AND recipient=? AND delivered IS NULL').get(actor,value.to).n>=200)throw new MailError('Recipient queue full',429);
        return this.insert({...value,sender:actor,recipient:value.to});
      });
    }
    if(operation==='status')return this.visible(actor,args.id);
    if(operation==='inbox'||operation==='replies') {
      const after=args.after??0;
      if(!Number.isSafeInteger(after)||after<0)throw new MailError('Invalid cursor');
      const rows=this.db.prepare(`SELECT * FROM messages WHERE recipient=? AND seq>? ${operation==='inbox'?'AND delivered IS NULL':''} ORDER BY seq LIMIT 51`).all(actor,after);
      return {messages:rows.slice(0,50),next_cursor:rows.slice(0,50).at(-1)?.seq||after,has_more:rows.length>50};
    }
    if(operation==='ack')return this.transaction(()=>{
      const row=this.visible(actor,args.id);
      if(row.recipient!==actor)throw new MailError('Only recipient can acknowledge',403);
      if(!row.delivered) {
        const state=row.kind==='task_request'?'pending_acceptance':'received';
        this.db.prepare('UPDATE messages SET delivered=?,state=? WHERE id=?').run(Date.now(),state,row.id);
        if(['message','task_request'].includes(row.kind))this.statusEvent(row,state);
      }
      return this.record(row.id);
    });
    if(operation==='update')return this.transaction(()=>{
      const row=this.visible(actor,args.id);
      if(row.recipient!==actor||row.kind!=='task_request')throw new MailError('Only task recipient can update',403);
      if(row.state===args.state)return row;
      const allowed={pending_acceptance:['accepted','rejected'],accepted:['completed','failed','cancelled','interrupted']};
      if(!allowed[row.state]?.includes(args.state))throw new MailError('Invalid task transition',409);
      this.db.prepare('UPDATE messages SET state=? WHERE id=?').run(args.state,row.id);
      this.statusEvent(row,args.state);
      return this.record(row.id);
    });
    throw new MailError('Unknown mailbox operation');
  }
}

export function mailboxServer(mailbox) {
  return http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.method==='GET'&&req.url==='/health'){res.end('{"status":"ready"}');return;}
    try {
      const actor=mailbox.authenticate(req.headers.authorization?.replace(/^Bearer /,''));
      if(req.method!=='POST'||req.url!=='/rpc')throw new MailError('Not found',404);
      req.setEncoding('utf8');let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw new MailError('Request too large',413);}
      const {operation,args}=JSON.parse(body);
      res.end(JSON.stringify(mailbox.request(actor,operation,args)));
    } catch(e) {
      res.writeHead(e instanceof MailError?e.code:400);
      res.end(JSON.stringify({error:e instanceof MailError?e.message:'Invalid mailbox request'}));
    }
  });
}

export async function mailboxRequest(url,token,operation,args,signal) {
  const response=await fetch(`${url}/rpc`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({operation,args}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
  if(!response.ok)throw new MailError('Mailbox request rejected',response.status);
  return response.json();
}
