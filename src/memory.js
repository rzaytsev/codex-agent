import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MEMORY_HEADING='## Durable memory v2';
export const categories=['facts','projects','episodes','procedures'];
const properties={key:{type:'string',pattern:'^[a-z0-9][a-z0-9-]{0,79}$'},category:{type:'string',enum:categories},title:{type:'string'},content:{type:'string'},certainty:{type:'string',enum:['confirmed','tentative']},sources:{type:'array',items:{type:'string'}},expected_revision:{type:'integer',minimum:0},status:{type:'string',enum:['active','archived']}};
export const memorySchema={type:'object',additionalProperties:false,required:['summary','changes'],properties:{summary:{type:'string'},changes:{type:'array',items:{type:'object',additionalProperties:false,required:Object.keys(properties),properties}}}};
const keyPattern=/^[a-z0-9][a-z0-9-]{0,79}$/;
const secretPattern=/-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+\S{12,}|(?:api[_-]?key|password|token|secret)\s*[=:]\s*["']?[A-Za-z0-9_/-]{16,}/i;
const stop=new Set('the and for with from this that what when where which have has was are you your how please about show tell find use мне меня тебя это как что для или где когда чтобы пожалуйста'.split(' '));
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
    `);
    if(owner) {
      this.checkOwner();
      const previous=this.store.get('memory-owner');
      if((previous&&previous!==owner)||this.db.prepare('SELECT user FROM memories WHERE user!=? UNION SELECT user FROM memory_versions WHERE user!=? UNION SELECT user FROM memory_tombstones WHERE user!=? LIMIT 1').get(owner,owner,owner))throw new Error('Workspace memory belongs to another owner; use a separate workspace');
      this.store.set('memory-owner',owner);
    }
  }
  checkOwner() {if(typeof this.owner!=='string'||!/^[1-9]\d*$/.test(this.owner))throw new Error('Configure a memory owner first');}
  checkKey(key) {if(typeof key!=='string'||!keyPattern.test(key))throw new Error('Invalid memory key');}
  decode(row) {return row?{...row,sources:JSON.parse(row.sources),path:this.relativePath(row)}:null;}
  relativePath(row) {return `memory/${row.status==='archived'?'archive/':''}${row.category}/${row.key}.md`;}
  get(key,revision) {
    const user=this.owner;this.checkOwner();this.checkKey(key);
    if(this.db.prepare('SELECT key FROM memory_tombstones WHERE user=? AND key=?').get(user,key))return null;
    const current=this.decode(this.db.prepare('SELECT * FROM memories WHERE user=? AND key=?').get(user,key));
    if(revision===undefined||current?.revision===revision)return current;
    if(!Number.isSafeInteger(revision)||revision<1)throw new Error('Invalid revision');
    const version=this.db.prepare('SELECT payload FROM memory_versions WHERE user=? AND key=? AND revision=?').get(user,key,revision);
    return version?JSON.parse(version.payload):null;
  }
  search(query='',{category,limit=10,after=0,since=0}={}) {
    const user=this.owner;this.checkOwner();
    if(typeof query!=='string'||query.length>30000||!Number.isInteger(limit)||limit<1||limit>30||!Number.isSafeInteger(after)||after<0||!Number.isFinite(since)||(category&&!categories.includes(category)))throw new Error('Invalid memory search');
    const tokens=[...new Set((query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]).filter(x=>!stop.has(x)))].slice(0,24);
    let rows;
    if(query.trim()&&!tokens.length)rows=[];
    else if(tokens.length) {
      const match=tokens.map(x=>`"${x}"`).join(' OR ');
      rows=this.db.prepare(`SELECT m.* FROM memory_fts JOIN memories m ON m.id=memory_fts.rowid WHERE memory_fts MATCH ? AND m.user=? AND m.status='active' AND (? IS NULL OR m.category=?) AND m.updated>=? ORDER BY bm25(memory_fts,4.0,1.0),m.updated DESC LIMIT ?`).all(match,user,category||null,category||null,since,limit);
    } else rows=this.db.prepare("SELECT * FROM memories WHERE user=? AND status='active' AND id>? AND (? IS NULL OR category=?) AND updated>=? ORDER BY id LIMIT ?").all(user,after,category||null,category||null,since,limit);
    return {entries:rows.map(row=>this.decode(row)),next_cursor:rows.at(-1)?.id||after};
  }
  context(query) {
    const entries=[];let size=0;
    for(const row of this.search(query,{limit:6}).entries) {
      const entry={key:row.key,category:row.category,title:row.title,content:row.content.slice(0,900),certainty:row.certainty,revision:row.revision,updated:new Date(row.updated).toISOString(),sources:row.sources.slice(0,4),path:row.path,truncated:row.content.length>900};
      const length=JSON.stringify(entry).length;if(size+length>6500)break;size+=length;entries.push(entry);
    }
    return entries;
  }
  validateSource(source) {
    const user=this.owner;
    if(typeof source!=='string'||source.length>500||secretPattern.test(source))throw new Error('Invalid memory source');
    const history=source.match(/^history:([1-9]\d*)$/);
    if(history) {if(!this.db.prepare('SELECT id FROM history WHERE id=? AND user=?').get(Number(history[1]),user))throw new Error('Unavailable history source');return;}
    const memory=source.match(/^memory:([a-z0-9-]+)@(\d+)$/);
    if(memory) {if(!this.get(memory[1],Number(memory[2])))throw new Error('Unavailable memory source');return;}
    if(/^https?:\/\//.test(source)) {const url=new URL(source);if(url.username||url.password||[...url.searchParams.keys()].some(k=>/token|key|secret|signature|password/i.test(k)))throw new Error('Sensitive source URL');return;}
    const relative=path.isAbsolute(source)?path.relative(this.workspace,source):source;
    if(relative.includes('..')||!(/^(inbox|projects|tasks|outputs|memory\/learnings|memory\/cleanup)\//.test(relative)||relative==='USER.md')||!fs.existsSync(path.join(this.workspace,relative)))throw new Error('Invalid workspace source');
    // Sources are references, not files to read. Do not follow a link out of the workspace.
    const actual=fs.realpathSync(path.join(this.workspace,relative));
    if(!actual.startsWith(fs.realpathSync(this.workspace)+path.sep))throw new Error('Source escaped workspace');
  }
  validate(value) {
    const user=this.owner;this.checkOwner();this.checkKey(value.key);
    if(!categories.includes(value.category)||!['confirmed','tentative'].includes(value.certainty)||!['active','archived'].includes(value.status??'active')||typeof value.title!=='string'||!value.title.trim()||value.title.length>160||typeof value.content!=='string'||!value.content.trim()||value.content.length>6000||secretPattern.test(value.title+'\n'+value.content)||!Array.isArray(value.sources)||!value.sources.length||value.sources.length>100||!Number.isSafeInteger(value.expected_revision)||value.expected_revision<0)throw new Error('Invalid memory record');
    for(const source of value.sources)this.validateSource(source);
    if(value.certainty==='confirmed'&&!value.sources.some(source=>{
      if(source.startsWith('history:'))return this.db.prepare('SELECT role FROM history WHERE id=? AND user=?').get(Number(source.slice(8)),user)?.role==='user';
      const memory=source.match(/^memory:([a-z0-9-]+)@(\d+)$/);return memory?this.get(memory[1],Number(memory[2]))?.certainty==='confirmed':true;
    }))throw new Error('Confirmed memory needs primary or confirmed evidence');
  }
  put(value,origin='conversation',restore=false) {
    const user=this.owner;this.validate(value);
    if(origin!=='conversation') {
      const blocked=new Set(this.db.prepare('SELECT blocked_history FROM memory_tombstones WHERE user=?').all(user).flatMap(row=>JSON.parse(row.blocked_history)));
      if(value.sources.some(source=>/^history:\d+$/.test(source)&&blocked.has(Number(source.slice(8)))))throw new Error('Forgotten source cannot be reconsolidated');
    }
    const tombstone=this.db.prepare('SELECT key FROM memory_tombstones WHERE user=? AND key=?').get(user,value.key);
    if(tombstone&&!restore)throw new Error('Forgotten memory cannot be restored automatically');
    const old=this.get(value.key),revision=old?.revision||0;
    if(revision!==value.expected_revision)throw new MemoryConflict(old);
    if(old&&old.category!==value.category)throw new Error('Keep the existing memory category');
    if(restore&&tombstone) {this.db.prepare('DELETE FROM memory_tombstones WHERE user=? AND key=?').run(user,value.key);this.db.prepare("DELETE FROM memories WHERE user=? AND key=? AND status='forgotten'").run(user,value.key);}
    const now=Date.now(),row={user,key:value.key,category:value.category,title:value.title.trim(),content:value.content.trim(),certainty:value.certainty,sources:[...new Set(value.sources)],status:value.status||'active',revision:revision+1,created:old?.created||now,updated:now,origin};
    const seq=this.db.prepare('INSERT INTO memory_versions(user,key,revision,payload,created) VALUES (?,?,?,?,?)').run(user,row.key,row.revision,JSON.stringify(row),now).lastInsertRowid;
    this.db.prepare(`INSERT INTO memories(user,key,category,title,content,certainty,sources,status,revision,created,updated,seq,origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user,key) DO UPDATE SET title=excluded.title,content=excluded.content,certainty=excluded.certainty,sources=excluded.sources,status=excluded.status,revision=excluded.revision,updated=excluded.updated,seq=excluded.seq,origin=excluded.origin`).run(user,row.key,row.category,row.title,row.content,row.certainty,JSON.stringify(row.sources),row.status,row.revision,row.created,row.updated,seq,origin);
    const id=this.db.prepare('SELECT id FROM memories WHERE user=? AND key=?').get(user,row.key).id;
    this.db.prepare('DELETE FROM memory_fts WHERE rowid=?').run(id);
    if(row.status==='active')this.db.prepare('INSERT INTO memory_fts(rowid,title,content) VALUES (?,?,?)').run(id,row.title,row.content);
    this.store.set('memory-export-dirty','1');return this.get(row.key);
  }
  save(value,{restore=false}={}) {
    const entry=this.store.transaction(()=>this.put(value,'conversation',restore));
    return {saved:true,entry,markdown_synced:this.project()};
  }
  forget(key) {
    const user=this.owner;this.checkOwner();this.checkKey(key);
    this.store.transaction(()=>{
      const row=this.get(key);const blocked=new Set();
      for(const version of this.db.prepare('SELECT payload FROM memory_versions WHERE user=? AND key=?').all(user,key))for(const source of JSON.parse(version.payload).sources||[])if(/^history:\d+$/.test(source))blocked.add(Number(source.slice(8)));
      const old=this.db.prepare('SELECT blocked_history FROM memory_tombstones WHERE user=? AND key=?').get(user,key);for(const id of JSON.parse(old?.blocked_history||'[]'))blocked.add(id);
      if(row)this.db.prepare('DELETE FROM memory_fts WHERE rowid=?').run(row.id);
      this.db.prepare('DELETE FROM memory_versions WHERE user=? AND key=?').run(user,key);
      // Keep only non-content identifiers to remove the projected files on recovery.
      if(row)this.db.prepare("UPDATE memories SET title='',content='',sources='[]',status='forgotten',certainty='tentative' WHERE user=? AND key=?").run(user,key);
      this.db.prepare('INSERT INTO memory_tombstones(user,key,blocked_history,created) VALUES (?,?,?,?) ON CONFLICT(user,key) DO UPDATE SET blocked_history=excluded.blocked_history').run(user,key,JSON.stringify([...blocked]),Date.now());
      this.store.set('memory-export-dirty','1');
    });
    return {forgotten:true,markdown_synced:this.project(),scope:'Structured memory, its versions, search index and Markdown copies. Original history, Codex sessions, source files and host backups remain.'};
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
    return `# ${row.title}\n\nCategory: ${row.category}\nStatus: ${row.status}\nCertainty: ${row.certainty}\nRevision: ${row.revision}\nCreated: ${new Date(row.created).toISOString()}\nUpdated: ${new Date(row.updated).toISOString()}\n\n${row.content}\n\nSources:\n${JSON.parse(row.sources).map(s=>'- '+s).join('\n')}\n`;
  }
  migrate() {
    if(!this.owner||this.store.get('memory-layout')==='flat-v1')return;
    // Records, revisions, source IDs and consolidation cursors stay untouched.
    // Regenerate first; keep the old tree as a recoverable backup afterwards.
    const index=path.join(this.workspace,'memory/INDEX.md');this.directory('memory');
    if(fs.existsSync(index)&&(!fs.lstatSync(index).isFile()||fs.lstatSync(index).isSymbolicLink()||!fs.readFileSync(index,'utf8').startsWith('# Memory index\n\nGenerated from state/assistant.sqlite.')))throw new Error('Memory migration found an unrelated destination index; preserve it before retrying');
    for(const row of this.db.prepare('SELECT * FROM memories').all())for(const status of ['active','archived']) {
      this.checkKey(row.key);if(row.user!==this.owner||!categories.includes(row.category))throw new Error('Invalid projection owner or category');
      const relative=this.relativePath({...row,status});this.directory(path.dirname(relative));const file=path.join(this.workspace,relative);
      if(fs.existsSync(file)&&(row.status==='forgotten'||!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||fs.readFileSync(file,'utf8')!==this.render({...row,status})))throw new Error('Memory migration found an unrelated destination file; preserve it before retrying');
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
  project() {
    try {
      this.checkOwner();
      const entries=[];let dirty=!fs.existsSync(path.join(this.workspace,'memory/INDEX.md'));
      for(const row of this.db.prepare('SELECT * FROM memories ORDER BY category,key').all()) {
        this.checkKey(row.key);if(row.user!==this.owner||!categories.includes(row.category))throw new Error('Invalid projection owner or category');
        const base='memory';
        const exported=row.status==='forgotten'?-1:row.seq;
        if(row.exported_seq!==exported) {
          dirty=true;
          for(const archived of [false,true]) {const relative=`${base}/${archived?'archive/':''}${row.category}/${row.key}.md`;this.directory(path.dirname(relative));if(row.status==='forgotten'||(row.status==='archived')!==archived)try{fs.unlinkSync(path.join(this.workspace,relative));}catch(e){if(e.code!=='ENOENT')throw e;}}
          if(row.status!=='forgotten') {
            this.write(this.relativePath(row),this.render(row));
          }
        }
        if(row.status==='forgotten')continue;
        if(row.status==='active')entries.push(`- [${row.title.replace(/[\r\n\[\]]/g,' ')}](${row.category}/${row.key}.md) — ${row.certainty}; revision ${row.revision}`);
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
    const blocked=new Set(this.db.prepare('SELECT blocked_history FROM memory_tombstones WHERE user=?').all(user).flatMap(x=>JSON.parse(x.blocked_history)));
    const records=[];let size=0,cursor=after,truncated=0;
    for(const row of rows) {
      let record=period==='daily'?{...row,source:`history:${row.id}`}:{...this.decode(row),source:`memory:${row.key}@${row.revision}`};
      if(period==='daily'&&blocked.has(row.id)) {cursor=row.id;continue;}
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
      for(const change of result.changes) {
        if(!change.sources?.some(s=>sources.has(s)))throw new Error('Consolidation needs batch evidence');
        this.put(change,period);
      }
      if(result.summary.trim()&&batch.records.length)this.put({key:`${period}-${jobId}-${batch.cursor}`,category:'episodes',title:`${period} memory consolidation`,content:result.summary,certainty:'tentative',sources:[...sources],expected_revision:0,status:'active'},period);
      this.store.set(`memory-cursor:${user}:${period}`,batch.cursor);
    });
    return {changes:result.changes.length,processed:batch.records.length,cursor:batch.cursor,markdown_synced:this.project()};
  }
}
