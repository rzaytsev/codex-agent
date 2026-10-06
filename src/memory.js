import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';

export const MEMORY_HEADING='## Durable memory v2';
export const categories=['facts','projects','episodes','procedures'];
const forgetScope='Selected structured memory, its versions, search index and Markdown copies are removed. Dependent and shared-history records are retained for explicit inspection and marked needs_review. Original history, Codex sessions, source files, unlinked copies and host backups remain.';
const memoryReference=/^memory:([a-z0-9-]+)@([1-9]\d*)$/;
const readySql=alias=>`NOT EXISTS (SELECT 1 FROM memory_invalidations i WHERE i.user=${alias}.user AND i.key=${alias}.key AND i.revision=${alias}.revision)`;
const properties={key:{type:'string',pattern:'^[a-z0-9][a-z0-9-]{0,79}$'},category:{type:'string',enum:categories},title:{type:'string'},content:{type:'string'},certainty:{type:'string',enum:['confirmed','tentative']},sources:{type:'array',items:{type:'string'}},expected_revision:{type:'integer',minimum:0},status:{type:'string',enum:['active','archived']}};
const timeFields=['observed_at','valid_from','valid_to','review_after'];
const tagFields=['entity','project'];
const metadataFields=[...timeFields,...tagFields];
for(const field of metadataFields)properties[field]={type:['string','null'],maxLength:timeFields.includes(field)?40:160};
export const memorySchema={type:'object',additionalProperties:false,required:['summary','changes'],properties:{summary:{type:'string'},changes:{type:'array',items:{type:'object',additionalProperties:false,required:Object.keys(properties),properties}}}};
const keyPattern=/^[a-z0-9][a-z0-9-]{0,79}$/;
const secretPattern=/-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+\S{12,}|(?:api[_-]?key|password|token|secret)\s*[=:]\s*["']?[A-Za-z0-9_/-]{16,}/i;
const stop=new Set('the and for with from this that what when where which have has was are you your how please about show tell find use мне меня тебя это как что для или где когда чтобы пожалуйста'.split(' '));
const timestampSchema=z.iso.datetime({offset:true}).max(40);
function timestamp(value) {
  if(!timestampSchema.safeParse(value).success)throw new Error('Invalid memory timestamp; include a timezone offset');
  const normalized=new Date(value).toISOString();
  if(!/^\d{4}-/.test(normalized))throw new Error('Invalid memory timestamp year');
  return normalized;
}
function tag(value) {
  if(typeof value!=='string'||!value.trim()||value.length>160||/[\x00-\x1f\x7f]/.test(value)||secretPattern.test(value))throw new Error('Invalid memory tag');
  return value.trim();
}
function metadata(value,previous={}) {
  const result={};
  for(const field of metadataFields) {
    const input=value[field]===undefined?previous[field]??null:value[field];
    result[field]=input===null?null:timeFields.includes(field)?timestamp(input):tag(input);
  }
  if(result.valid_from&&result.valid_to&&result.valid_from>=result.valid_to)throw new Error('Invalid memory validity interval');
  return result;
}
function filters({entity,project,as_of}={}) {
  return {entity:entity===undefined?undefined:tag(entity),project:project===undefined?undefined:tag(project),as_of:as_of===undefined?new Date().toISOString():timestamp(as_of)};
}
function validAt(row,at) {return (!row.valid_from||row.valid_from<=at)&&(!row.valid_to||row.valid_to>at);}
export class MemoryConflict extends Error { constructor(current){super('Memory revision conflict');this.current=current;} }

// SQLite owns the records and revisions. Markdown is a repairable projection,
// never a second independently edited source of truth.
export class Memory {
  constructor(workspace,store,owner) {
    this.workspace=workspace;this.store=store;this.db=store.db;this.owner=owner;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY AUTOINCREMENT,user TEXT NOT NULL,key TEXT NOT NULL,category TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,certainty TEXT NOT NULL,sources TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,seq INTEGER NOT NULL,origin TEXT NOT NULL,exported_seq INTEGER NOT NULL DEFAULT 0,UNIQUE(user,key));
      CREATE INDEX IF NOT EXISTS memories_user_seq ON memories(user,seq);
      CREATE TABLE IF NOT EXISTS memory_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,user TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(title,content,tokenize='unicode61');
      CREATE TABLE IF NOT EXISTS memory_tombstones(user TEXT NOT NULL,key TEXT NOT NULL,blocked_history TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(user,key));
      CREATE TABLE IF NOT EXISTS memory_sources(user TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(user,key,revision,source));
      CREATE INDEX IF NOT EXISTS memory_sources_lookup ON memory_sources(user,source);
      CREATE TABLE IF NOT EXISTS memory_invalidations(user TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,source TEXT NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(user,key,revision,source,reason));
      CREATE TABLE IF NOT EXISTS memory_blocked_history(user TEXT NOT NULL,history_id INTEGER NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(user,history_id));
      CREATE TABLE IF NOT EXISTS memory_review_exports(user TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(user,key));
      CREATE TRIGGER IF NOT EXISTS memory_version_sources AFTER INSERT ON memory_versions BEGIN
        INSERT OR IGNORE INTO memory_sources SELECT NEW.user,NEW.key,NEW.revision,value FROM json_each(NEW.payload,'$.sources'); END;
      CREATE TRIGGER IF NOT EXISTS memory_current_sources AFTER INSERT ON memories BEGIN
        INSERT INTO memory_sources SELECT NEW.user,NEW.key,NEW.revision,j.value FROM json_each(NEW.sources) j WHERE NOT EXISTS (SELECT 1 FROM memory_sources s WHERE s.user=NEW.user AND s.key=NEW.key AND s.revision=NEW.revision AND s.source=j.value); END;
      CREATE TRIGGER IF NOT EXISTS memory_updated_sources AFTER UPDATE OF sources,revision ON memories WHEN NEW.status!='forgotten' BEGIN
        INSERT INTO memory_sources SELECT NEW.user,NEW.key,NEW.revision,j.value FROM json_each(NEW.sources) j WHERE NOT EXISTS (SELECT 1 FROM memory_sources s WHERE s.user=NEW.user AND s.key=NEW.key AND s.revision=NEW.revision AND s.source=j.value); END;

    `);
    if(owner) {
      this.checkOwner();
      const previous=this.store.get('memory-owner');
      if((previous&&previous!==owner)||this.db.prepare('SELECT user FROM memories WHERE user!=? UNION SELECT user FROM memory_versions WHERE user!=? UNION SELECT user FROM memory_tombstones WHERE user!=? UNION SELECT user FROM memory_sources WHERE user!=? UNION SELECT user FROM memory_invalidations WHERE user!=? UNION SELECT user FROM memory_blocked_history WHERE user!=? UNION SELECT user FROM memory_review_exports WHERE user!=? LIMIT 1').get(owner,owner,owner,owner,owner,owner,owner))throw new Error('Workspace memory belongs to another owner; use a separate workspace');
      this.store.set('memory-owner',owner);
      this.store.transaction(()=>{
        this.db.prepare("INSERT OR IGNORE INTO memory_sources SELECT v.user,v.key,v.revision,j.value FROM memory_versions v,json_each(v.payload,'$.sources') j WHERE v.user=?").run(owner);
        this.db.prepare("INSERT OR IGNORE INTO memory_sources SELECT m.user,m.key,m.revision,j.value FROM memories m,json_each(m.sources) j WHERE m.user=? AND m.status!='forgotten'").run(owner);
        this.db.prepare('INSERT OR IGNORE INTO memory_blocked_history SELECT t.user,j.value,t.created FROM memory_tombstones t,json_each(t.blocked_history) j WHERE t.user=?').run(owner);
        this.reconcileEvidence();
      });
    }
    // Additive migration: legacy records remain unbounded, with untouched versions.
    this.store.transaction(()=>{
      const columns=new Set(this.db.prepare('PRAGMA table_info(memories)').all().map(row=>row.name));
      for(const field of metadataFields)if(!columns.has(field))this.db.exec(`ALTER TABLE memories ADD COLUMN ${field} TEXT`);
      this.db.exec('CREATE INDEX IF NOT EXISTS memories_user_entity ON memories(user,entity); CREATE INDEX IF NOT EXISTS memories_user_project ON memories(user,project)');
    });
  }
  checkOwner() {if(typeof this.owner!=='string'||!/^[1-9]\d*$/.test(this.owner))throw new Error('Configure a memory owner first');}
  checkKey(key) {if(typeof key!=='string'||!keyPattern.test(key))throw new Error('Invalid memory key');}
  review(row) {
    const reasons=this.db.prepare('SELECT source,reason,created FROM memory_invalidations WHERE user=? AND key=? AND revision=? ORDER BY source,reason').all(this.owner,row.key,row.revision);
    return {...row,review_state:reasons.length?'needs_review':'ready',review_reasons:reasons};
  }
  decode(row,at=new Date().toISOString()) {
    if(!row)return null;
    const entry=this.review({...row,...Object.fromEntries(metadataFields.map(field=>[field,row[field]??null])),sources:typeof row.sources==='string'?JSON.parse(row.sources):row.sources,review_due:!!row.review_after&&row.review_after<=at});
    return {...entry,path:this.relativePath(entry)};
  }
  relativePath(row) {return `memory/${(row.review_state||this.review(row).review_state)==='needs_review'?'review/':row.status==='archived'?'archive/':''}${row.category}/${row.key}.md`;}
  blockedHistory() {return new Set(this.db.prepare('SELECT history_id FROM memory_blocked_history WHERE user=? UNION SELECT j.value AS history_id FROM memory_tombstones t,json_each(t.blocked_history) j WHERE t.user=?').all(this.owner,this.owner).map(r=>r.history_id));}
  dependents(sources) {
    if(!sources.length)return [];
    return this.db.prepare(`WITH RECURSIVE affected(key,revision,source) AS (
      SELECT s.key,s.revision,j.value FROM memory_sources s,json_each(?) j WHERE s.user=? AND s.source=j.value
      UNION
      SELECT s.key,s.revision,a.source FROM memory_sources s JOIN affected a ON s.source='memory:'||a.key||'@'||a.revision WHERE s.user=?
    ) SELECT key,revision,source FROM affected ORDER BY key,revision,source`).all(JSON.stringify(sources),this.owner,this.owner);
  }
  invalidate(sources,reason) {
    const rows=this.dependents(sources);
    for(const row of rows) {
      const changed=this.db.prepare('INSERT OR IGNORE INTO memory_invalidations VALUES (?,?,?,?,?,?)').run(this.owner,row.key,row.revision,row.source,reason,Date.now()).changes;
      if(changed)this.db.prepare('UPDATE memories SET exported_seq=0 WHERE user=? AND key=? AND revision=?').run(this.owner,row.key,row.revision);
      this.db.prepare('DELETE FROM memory_fts WHERE rowid IN (SELECT id FROM memories WHERE user=? AND key=? AND revision=?)').run(this.owner,row.key,row.revision);
    }
    if(rows.length)this.store.set('memory-export-dirty','1');
    return rows;
  }
  reconcileEvidence() {
    // Also covers pre-index databases and imports: evidence IDs are authoritative,
    // not a claim that every copied or paraphrased statement can be found.
    const stale=[];
    for(const {source} of this.db.prepare('SELECT DISTINCT source FROM memory_sources WHERE user=?').all(this.owner)) {
      const ref=source.match(memoryReference);if(!ref)continue;
      const current=this.db.prepare("SELECT revision,status FROM memories WHERE user=? AND key=?").get(this.owner,ref[1]);
      if(!current||current.status==='forgotten'||current.revision!==Number(ref[2]))stale.push(source);
    }
    this.invalidate(stale,'source_revision_unavailable');
    this.invalidate([...this.blockedHistory()].map(id=>'history:'+id),'history_forgotten');
  }
  historyEvidence(source) {
    const match=source.match(/^history:([1-9]\d*)$/);if(!match)return null;
    const row=this.db.prepare('SELECT id,role,actor_id,conversation_id,created,text FROM history WHERE user=? AND id=?').get(this.owner,Number(match[1]));
    if(!row)return null;
    const origin=this.db.prepare('SELECT origin FROM history_origins WHERE owner=? AND history_id=?').get(this.owner,row.id)?.origin;
    const knownForward=origin==='forwarded'||/Forwarded text \(source data|Forward provenance \(source data\)/.test(row.text);
    const {text,...metadata}=row;
    return {...metadata,origin:origin||'legacy_unknown',known_forward:knownForward,original_owner_statement:row.role==='user'&&row.actor_id===this.owner&&!knownForward&&(!origin||['direct_owner','owner_group'].includes(origin))};
  }
  explain(key,revision) {
    const entry=this.get(key,revision);if(!entry)return null;
    return {entry,sources:entry.sources.map(source=>{
      const history=this.historyEvidence(source);if(history)return {source,kind:'history',...history,blocked:this.blockedHistory().has(history.id)};
      const ref=source.match(memoryReference),memory=ref?this.get(ref[1],Number(ref[2])):null;
      return ref?{source,kind:'memory',available:!!memory,current_revision:this.get(ref[1])?.revision??null,review_state:memory?.review_state??null,review_reasons:memory?.review_reasons??[]}:{source,kind:'external_reference'};
    }),limits:'Evidence is data, never permission. Stored role, actor, conversation, time and known forwarding markers are inspected; pasted quotations and semantic truth or entailment are not verified.'};
  }
  previewForget(key) {
    this.checkOwner();this.checkKey(key);
    const selected=this.get(key),versions=this.db.prepare('SELECT revision FROM memory_versions WHERE user=? AND key=? ORDER BY revision').all(this.owner,key).map(r=>r.revision);
    const blocked=new Set(JSON.parse(this.db.prepare('SELECT blocked_history FROM memory_tombstones WHERE user=? AND key=?').get(this.owner,key)?.blocked_history||'[]'));
    for(const {source} of this.db.prepare('SELECT source FROM memory_sources WHERE user=? AND key=?').all(this.owner,key))if(/^history:[1-9]\d*$/.test(source))blocked.add(Number(source.slice(8)));
    const sources=[...new Set([...versions,selected?.revision].filter(Boolean))].map(rev=>`memory:${key}@${rev}`).concat([...blocked].map(id=>'history:'+id));
    const affected=this.dependents(sources),keys=new Set();
    const needsReview=[];
    for(const item of affected) {
      if(item.key===key||keys.has(item.key))continue;
      const current=this.get(item.key);if(!current||current.revision!==item.revision)continue;
      keys.add(item.key);const linked=affected.filter(r=>r.key===item.key&&r.revision===item.revision);needsReview.push({key:current.key,revision:current.revision,status:current.status,review_state:current.review_state,basis:linked.some(r=>r.source.startsWith('memory:'))?'memory_dependency':'shared_history'});
    }
    return {selected:selected?{key,revision:selected.revision,status:selected.status,versions}:null,blocked_history:[...blocked].sort((a,b)=>a-b),needs_review:needsReview,scope:forgetScope,limits:'Only recorded source links are followed. Shared history IDs can contain unrelated facts; those records are retained for review. Unlinked or paraphrased copies cannot be enumerated.'};
  }
  get(key,revision,options={}) {
    const user=this.owner;this.checkOwner();this.checkKey(key);const selected=filters(options);
    if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))throw new Error('Invalid revision');
    if(this.db.prepare('SELECT key FROM memory_tombstones WHERE user=? AND key=?').get(user,key))return null;
    let row=this.db.prepare('SELECT * FROM memories WHERE user=? AND key=?').get(user,key);
    if(revision!==undefined&&row?.revision!==revision) {
      const version=this.db.prepare('SELECT payload FROM memory_versions WHERE user=? AND key=? AND revision=?').get(user,key,revision);
      row=version?JSON.parse(version.payload):null;
    }
    if(!row||(selected.entity!==undefined&&row.entity!==selected.entity)||(selected.project!==undefined&&row.project!==selected.project)||(options.as_of!==undefined&&!validAt(row,selected.as_of)))return null;
    // Unfiltered key/revision reads deliberately retain historical evidence for correction.
    return this.decode(row,selected.as_of);
  }
  search(query='',{category,limit=10,after=0,since=0,entity,project,as_of}={}) {
    const user=this.owner;this.checkOwner();const selected=filters({entity,project,as_of});
    if(typeof query!=='string'||query.length>30000||!Number.isInteger(limit)||limit<1||limit>30||!Number.isSafeInteger(after)||after<0||!Number.isFinite(since)||(category&&!categories.includes(category)))throw new Error('Invalid memory search');
    const tokens=[...new Set((query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]).filter(x=>!stop.has(x)))].slice(0,24);
    // Restrict eligible rows before LIMIT in both FTS and ID-paginated listing.
    const where=["m.user=?","m.status='active'",readySql('m'),'(m.valid_from IS NULL OR m.valid_from<=?)','(m.valid_to IS NULL OR m.valid_to>?)','m.updated>=?'];
    const args=[user,selected.as_of,selected.as_of,since];
    for(const [field,value] of [['category',category||undefined],['entity',selected.entity],['project',selected.project]])if(value!==undefined){where.push(`m.${field}=?`);args.push(value);}
    let rows;
    if(query.trim()&&!tokens.length)rows=[];
    else if(tokens.length) {
      const match=tokens.map(x=>`"${x}"`).join(' OR ');
      rows=this.db.prepare(`SELECT m.* FROM memory_fts JOIN memories m ON m.id=memory_fts.rowid WHERE memory_fts MATCH ? AND ${where.join(' AND ')} ORDER BY bm25(memory_fts,4.0,1.0),m.updated DESC LIMIT ?`).all(match,...args,limit);
    } else rows=this.db.prepare(`SELECT m.* FROM memories m WHERE ${where.join(' AND ')} AND m.id>? ORDER BY m.id LIMIT ?`).all(...args,after,limit);
    return {entries:rows.map(row=>this.decode(row,selected.as_of)),next_cursor:rows.at(-1)?.id||after};
  }
  context(query,{entity,project,as_of}={}) {
    const entries=[];let size=0;
    for(const row of this.search(query,{entity,project,as_of,limit:6}).entries) {
      const entry={key:row.key,category:row.category,title:row.title,content:row.content.slice(0,900),certainty:row.certainty,revision:row.revision,updated:new Date(row.updated).toISOString(),...Object.fromEntries(metadataFields.filter(field=>row[field]!==null).map(field=>[field,row[field]])),...(row.review_after?{review_due:row.review_due}:{}),sources:row.sources.slice(0,4),path:row.path,truncated:row.content.length>900};
      const length=JSON.stringify(entry).length;if(size+length>6500)break;size+=length;entries.push(entry);
    }
    return entries;
  }
  validateSource(source) {
    const user=this.owner;
    if(typeof source!=='string'||source.length>500||secretPattern.test(source))throw new Error('Invalid memory source');
    const history=source.match(/^history:([1-9]\d*)$/);
    if(history) {if(this.blockedHistory().has(Number(history[1])))throw new Error('Forgotten source cannot be reused');if(!this.db.prepare('SELECT id FROM history WHERE id=? AND user=?').get(Number(history[1]),user))throw new Error('Unavailable history source');return;}
    const memory=source.match(memoryReference);
    if(memory) {const entry=this.get(memory[1],Number(memory[2])),current=this.get(memory[1]);if(!entry||entry.review_state!=='ready'||current?.revision!==Number(memory[2]))throw new Error('Unavailable or non-current memory source; review primary evidence');return;}
    if(/^https?:\/\//.test(source)) {const url=new URL(source);if(url.username||url.password||[...url.searchParams.keys()].some(k=>/token|key|secret|signature|password/i.test(k)))throw new Error('Sensitive source URL');return;}
    const relative=path.isAbsolute(source)?path.relative(this.workspace,source):source;
    const local=relative.replace(/^conversations\/[0-9a-f-]{36}\//,'');
    if(relative.includes('..')||!(/^(inbox|projects|tasks|outputs|memory\/learnings|memory\/cleanup)\//.test(local)||local==='USER.md')||!fs.existsSync(path.join(this.workspace,relative)))throw new Error('Invalid workspace source');
    // Sources are references, not files to read. Do not follow a link out of the workspace.
    const actual=fs.realpathSync(path.join(this.workspace,relative));
    if(!actual.startsWith(fs.realpathSync(this.workspace)+path.sep))throw new Error('Source escaped workspace');
  }
  validate(value) {
    const user=this.owner;this.checkOwner();this.checkKey(value.key);
    if(!categories.includes(value.category)||!['confirmed','tentative'].includes(value.certainty)||!['active','archived'].includes(value.status??'active')||typeof value.title!=='string'||!value.title.trim()||value.title.length>160||typeof value.content!=='string'||!value.content.trim()||value.content.length>6000||secretPattern.test(value.title+'\n'+value.content)||!Array.isArray(value.sources)||!value.sources.length||value.sources.length>100||!Number.isSafeInteger(value.expected_revision)||value.expected_revision<0)throw new Error('Invalid memory record');
    metadata(value);
    for(const source of value.sources)this.validateSource(source);
    if(value.certainty==='confirmed'&&!value.sources.some(source=>{
      if(source.startsWith('history:'))return this.historyEvidence(source)?.original_owner_statement;
      const memory=source.match(/^memory:([a-z0-9-]+)@(\d+)$/);return memory?this.get(memory[1],Number(memory[2]))?.certainty==='confirmed':true;
    }))throw new Error('Confirmed memory needs primary or confirmed evidence');
  }
  put(value,origin='conversation',restore=false) {
    // Retain the legacy argument only to refuse old callers safely. Source text
    // and a model-supplied boolean cannot establish owner restoration authority.
    if(restore||value.restore)throw new Error('Memory restoration is disabled; forgotten keys remain tombstoned');
    const user=this.owner;this.validate(value);
    const tombstone=this.db.prepare('SELECT key FROM memory_tombstones WHERE user=? AND key=?').get(user,value.key);
    if(tombstone)throw new Error('Forgotten memory remains tombstoned; restoration is disabled');
    const old=this.get(value.key),revision=old?.revision||0;
    if(revision!==value.expected_revision)throw new MemoryConflict(old);
    if(old&&old.category!==value.category)throw new Error('Keep the existing memory category');
    const now=Date.now(),row={user,key:value.key,category:value.category,title:value.title.trim(),content:value.content.trim(),certainty:value.certainty,sources:[...new Set(value.sources)],status:value.status||'active',revision:revision+1,created:old?.created||now,updated:now,origin,...metadata(value,old||{})};
    const seq=this.db.prepare('INSERT INTO memory_versions(user,key,revision,payload,created) VALUES (?,?,?,?,?)').run(user,row.key,row.revision,JSON.stringify(row),now).lastInsertRowid;
    this.db.prepare(`INSERT INTO memories(user,key,category,title,content,certainty,sources,status,revision,created,updated,seq,origin,${metadataFields.join(',')}) VALUES (${Array(13+metadataFields.length).fill('?').join(',')}) ON CONFLICT(user,key) DO UPDATE SET title=excluded.title,content=excluded.content,certainty=excluded.certainty,sources=excluded.sources,status=excluded.status,revision=excluded.revision,updated=excluded.updated,seq=excluded.seq,origin=excluded.origin,${metadataFields.map(field=>`${field}=excluded.${field}`).join(',')}`).run(user,row.key,row.category,row.title,row.content,row.certainty,JSON.stringify(row.sources),row.status,row.revision,row.created,row.updated,seq,origin,...metadataFields.map(field=>row[field]));
    const id=this.db.prepare('SELECT id FROM memories WHERE user=? AND key=?').get(user,row.key).id;
    this.db.prepare('DELETE FROM memory_fts WHERE rowid=?').run(id);
    if(row.status==='active')this.db.prepare('INSERT INTO memory_fts(rowid,title,content) VALUES (?,?,?)').run(id,row.title,row.content);
    if(old)this.invalidate([`memory:${old.key}@${old.revision}`],'source_revision_changed');
    this.store.set('memory-export-dirty','1');return this.get(row.key);
  }
  save(value,{restore=false}={}) {
    const entry=this.store.transaction(()=>this.put(value,'conversation',restore));
    return {saved:true,entry,markdown_synced:this.project()};
  }
  forget(key) {
    const user=this.owner;this.checkOwner();this.checkKey(key);
    const affected=this.store.transaction(()=>{
      const impact=this.previewForget(key),row=this.get(key);
      const sources=[...(impact.selected?.versions||[]),row?.revision].filter(Boolean).map(rev=>`memory:${key}@${rev}`);
      this.invalidate(sources,'memory_forgotten');
      this.invalidate(impact.blocked_history.map(id=>'history:'+id),'history_forgotten');
      for(const id of impact.blocked_history)this.db.prepare('INSERT OR IGNORE INTO memory_blocked_history VALUES (?,?,?)').run(user,id,Date.now());
      if(row)this.db.prepare('DELETE FROM memory_fts WHERE rowid=?').run(row.id);
      for(const table of ['memory_versions','memory_sources','memory_invalidations'])this.db.prepare(`DELETE FROM ${table} WHERE user=? AND key=?`).run(user,key);
      // Keep only non-content identifiers to remove the projected files on recovery.
      if(row)this.db.prepare("UPDATE memories SET title='',content='',sources='[]',status='forgotten',certainty='tentative',observed_at=NULL,valid_from=NULL,valid_to=NULL,review_after=NULL,entity=NULL,project=NULL WHERE user=? AND key=?").run(user,key);
      this.db.prepare('INSERT INTO memory_tombstones(user,key,blocked_history,created) VALUES (?,?,?,?) ON CONFLICT(user,key) DO UPDATE SET blocked_history=excluded.blocked_history,created=excluded.created').run(user,key,JSON.stringify(impact.blocked_history),Date.now());
      this.store.set('memory-export-dirty','1');return impact;
    });
    return {forgotten:true,affected,markdown_synced:this.project(),scope:forgetScope};
  }
  directory(relative) {
    let current=this.workspace;
    for(const part of relative.split('/')) {current=path.join(current,part);try{fs.mkdirSync(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}if(!fs.lstatSync(current).isDirectory()||fs.lstatSync(current).isSymbolicLink())throw new Error('Unsafe memory directory');}
    return current;
  }
  write(relative,text) {
    const dir=this.directory(path.dirname(relative)),dest=path.join(dir,path.basename(relative)),temp=dest+'.'+randomUUID()+'.tmp';
    try {fs.writeFileSync(temp,text,{flag:'wx',mode:0o600});fs.renameSync(temp,dest);}finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  }
  render(row) {
    const labels={observed_at:'Observed at',valid_from:'Valid from',valid_to:'Valid to',review_after:'Review after',entity:'Entity',project:'Project'};
    const detail=metadataFields.filter(field=>row[field]!=null).map(field=>`\n${labels[field]}: ${row[field]}`).join('');
    return `# ${row.title}\n\nCategory: ${row.category}\nStatus: ${row.status}\nReview: ${row.review_state||this.review(row).review_state}\nCertainty: ${row.certainty}\nRevision: ${row.revision}\nCreated: ${new Date(row.created).toISOString()}\nUpdated: ${new Date(row.updated).toISOString()}${detail}\n\n${row.content}\n\nSources:\n${JSON.parse(row.sources).map(s=>'- '+s).join('\n')}\n`;
  }
  migrate() {
    if(!this.owner||this.store.get('memory-layout')==='flat-v1')return;
    // Records, revisions, source IDs and consolidation cursors stay untouched.
    // Regenerate first; keep the old tree as a recoverable backup afterwards.
    const index=path.join(this.workspace,'memory/INDEX.md');this.directory('memory');
    if(fs.existsSync(index)&&(!fs.lstatSync(index).isFile()||fs.lstatSync(index).isSymbolicLink()||!fs.readFileSync(index,'utf8').startsWith('# Memory index\n\nGenerated from state/assistant.sqlite.')))throw new Error('Memory migration found an unrelated destination index; preserve it before retrying');
    for(const row of this.db.prepare('SELECT * FROM memories').all())for(const variant of [{status:'active',review_state:'ready'},{status:'archived',review_state:'ready'},{status:row.status,review_state:'needs_review'}]) {
      this.checkKey(row.key);if(row.user!==this.owner||!categories.includes(row.category))throw new Error('Invalid projection owner or category');
      const projected={...row,...variant},relative=this.relativePath(projected);this.directory(path.dirname(relative));const file=path.join(this.workspace,relative);
      if(fs.existsSync(file)) {
        if(row.status==='forgotten'||!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw new Error('Memory migration found an unrelated destination file; preserve it before retrying');
        const expected=this.render(projected),actual=fs.readFileSync(file,'utf8');
        if(actual!==expected&&actual!==expected.replace(/^Review: .*\n/m,''))throw new Error('Memory migration found an unrelated destination file; preserve it before retrying');
      }
    }
    const legacy=`memory/users/${this.owner}`;
    // Validate the old parent before touching it; never traverse a symlink.
    if(fs.existsSync(path.join(this.workspace,'memory/users')))this.directory('memory/users');
    if(fs.existsSync(path.join(this.workspace,legacy)))this.directory(legacy);
    this.db.exec('UPDATE memories SET exported_seq=0');this.store.set('memory-export-dirty','1');
    if(!this.project())throw new Error('Memory layout migration could not export Markdown; original records remain intact');
    if(fs.existsSync(path.join(this.workspace,legacy))) {
      const backup=`state/memory-layout-backup-${randomUUID()}`;this.directory('state');
      fs.renameSync(path.join(this.workspace,legacy),path.join(this.workspace,backup));this.store.set('memory-layout-backup',backup);
      try{fs.rmdirSync(path.join(this.workspace,'memory/users'));}catch(e){if(e.code!=='ENOTEMPTY'&&e.code!=='ENOENT')throw e;}
    }
    this.store.set('memory-layout','flat-v1');
  }
  reviewProjection(row) {
    const relative=`memory/review/${row.category}/${row.key}.md`;
    this.directory(path.dirname(relative));const file=path.join(this.workspace,relative);
    let stat;try {stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Unowned memory review projection');
    const actual=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const saved=this.db.prepare('SELECT hash FROM memory_review_exports WHERE user=? AND key=?').get(this.owner,row.key)?.hash;
    // Exact current generated bytes also recover a crash after rename but before
    // its hash receipt was saved. A similar header alone never establishes ownership.
    const expected=row.status!=='forgotten'&&row.review_state==='needs_review'?createHash('sha256').update(this.render(row)).digest('hex'):null;
    if(actual!==saved&&actual!==expected)throw new Error('Unrelated memory review file; preserve it before retrying');
  }
  project() {
    try {
      this.checkOwner();
      const entries=[];let dirty=!fs.existsSync(path.join(this.workspace,'memory/INDEX.md'));
      const rows=this.db.prepare('SELECT * FROM memories ORDER BY category,key').all().map(row=>this.review(row));
      // Flat-v1 predates the review namespace. Preflight every affected destination
      // before deleting or replacing any projection, including ready-record cleanup.
      for(const row of rows) {
        this.checkKey(row.key);if(row.user!==this.owner||!categories.includes(row.category))throw new Error('Invalid projection owner or category');
        if(row.exported_seq!==(row.status==='forgotten'?-1:row.seq))this.reviewProjection(row);
      }
      for(const row of rows) {
        this.checkKey(row.key);if(row.user!==this.owner||!categories.includes(row.category))throw new Error('Invalid projection owner or category');
        const base='memory';
        const exported=row.status==='forgotten'?-1:row.seq;
        if(row.exported_seq!==exported) {
          dirty=true;
          for(const folder of ['', 'archive/', 'review/']) {const relative=`${base}/${folder}${row.category}/${row.key}.md`;this.directory(path.dirname(relative));if(row.status==='forgotten'||relative!==this.relativePath(row))try{fs.unlinkSync(path.join(this.workspace,relative));}catch(e){if(e.code!=='ENOENT')throw e;}}
          if(row.status!=='forgotten') {
            const rendered=this.render(row);this.write(this.relativePath(row),rendered);
            if(row.review_state==='needs_review')this.db.prepare('INSERT INTO memory_review_exports VALUES (?,?,?) ON CONFLICT(user,key) DO UPDATE SET hash=excluded.hash').run(this.owner,row.key,createHash('sha256').update(rendered).digest('hex'));
          }
          if(row.status==='forgotten'||row.review_state!=='needs_review')this.db.prepare('DELETE FROM memory_review_exports WHERE user=? AND key=?').run(this.owner,row.key);
        }
        if(row.status==='forgotten')continue;
        if(row.status==='active'&&row.review_state==='ready')entries.push(`- [${row.title.replace(/[\r\n\[\]]/g,' ')}](${row.category}/${row.key}.md) — ${row.certainty}; revision ${row.revision}`);
      }
      if(dirty)this.write('memory/INDEX.md','# Memory index\n\nGenerated from state/assistant.sqlite. Use memory tools to edit; this index is not loaded in full for every message.\n\n'+entries.join('\n')+'\n');
      this.db.exec("UPDATE memories SET exported_seq=CASE WHEN status='forgotten' THEN -1 ELSE seq END");
      this.store.set('memory-export-dirty','0');return true;
    } catch {this.store.set('memory-export-dirty','1');console.error('Memory Markdown export pending; private details suppressed');return false;}
  }
  target(period) {this.checkOwner();return period==='daily'?this.db.prepare("SELECT coalesce(max(id),0) AS n FROM history WHERE user=? AND role NOT IN ('memory','maintenance')").get(this.owner).n:this.db.prepare("SELECT coalesce(max(seq),0) AS n FROM memories WHERE user=? AND status!='forgotten' AND origin!='weekly'").get(this.owner).n;}
  batch(period,target) {
    const user=this.owner;this.checkOwner();
    const after=Number(this.store.get(`memory-cursor:${user}:${period}`)||0);
    const rows=period==='daily'?this.db.prepare("SELECT id,role,text,created FROM history WHERE user=? AND id>? AND id<=? AND role NOT IN ('memory','maintenance') ORDER BY id LIMIT 50").all(user,after,target):this.db.prepare("SELECT * FROM memories WHERE user=? AND seq>? AND seq<=? AND status!='forgotten' AND origin!='weekly' ORDER BY seq LIMIT 50").all(user,after,target);
    const blocked=this.blockedHistory();
    const records=[];let size=0,cursor=after,truncated=0;
    for(const row of rows) {
      let record=period==='daily'?{...row,source:`history:${row.id}`}:{...this.decode(row),source:`memory:${row.key}@${row.revision}`};
      if(period==='daily'&&blocked.has(row.id)) {cursor=row.id;continue;}
      if(period!=='daily'&&record.review_state==='needs_review') {cursor=row.seq;continue;}
      const field=period==='daily'?'text':'content';let wasTruncated=record[field].length>50000;if(wasTruncated)record={...record,[field]:record[field].slice(0,50000),truncated:true};
      let length=JSON.stringify(record).length;
      while(length>60000&&record[field].length) {wasTruncated=true;record={...record,[field]:record[field].slice(0,Math.floor(record[field].length*0.8)),truncated:true};length=JSON.stringify(record).length;}
      if(size+length>60000&&records.length)break;
      records.push(record);if(wasTruncated)truncated++;size+=length;cursor=period==='daily'?row.id:row.seq;
    }
    if(!rows.length)cursor=target;
    return {after,cursor,target,records,truncated};
  }
  consolidate(period,batch,result,jobId) {
    const user=this.owner;this.checkOwner();
    if(typeof result.summary!=='string'||result.summary.length>6000||secretPattern.test(result.summary)||!Array.isArray(result.changes)||result.changes.length>20)throw new Error('Invalid consolidation');
    // One transaction covers all proposals, the audit episode and the watermark.
    this.store.transaction(()=>{
      if(Number(this.store.get(`memory-cursor:${user}:${period}`)||0)!==batch.after)throw new Error('Consolidation cursor conflict');
      const sources=new Set(batch.records.map(x=>x.source));
      // Insert the audit against the input snapshot first. A proposal that changes
      // an input then marks the audit for review in the same transaction.
      if(result.summary.trim()&&batch.records.length)this.put({key:`${period}-${jobId}-${batch.cursor}`,category:'episodes',title:`${period} memory consolidation`,content:result.summary,certainty:'tentative',sources:[...sources],expected_revision:0,status:'active'},period);
      for(const change of result.changes) {
        if(!change.sources?.some(s=>sources.has(s)))throw new Error('Consolidation needs batch evidence');
        this.put(change,period);
      }
      this.store.set(`memory-cursor:${user}:${period}`,batch.cursor);
    });
    return {changes:result.changes.length,processed:batch.records.length,cursor:batch.cursor,markdown_synced:this.project()};
  }
}
