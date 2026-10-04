import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const maintenance=/^\[(MEMORY|LEARNING|REFLECTION|CLEANUP)\]/;

// Preserve saved SDK rollouts, without copying credentials or group rules over
// the owner's configuration. Codex can rediscover rollouts by their thread ID.
async function copySessions(source,destination) {
  let entries;try {entries=await fs.readdir(source,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
  await fs.mkdir(destination,{recursive:true,mode:0o700});
  for(const entry of entries) {
    const from=path.join(source,entry.name),to=path.join(destination,entry.name);
    if(entry.isSymbolicLink())throw new Error('Unsafe legacy session path');
    if(entry.isDirectory())await copySessions(from,to);
    else if(entry.isFile()) {
      try {await fs.copyFile(from,to,fs.constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;if(!(await fs.readFile(from)).equals(await fs.readFile(to)))throw new Error('Conflicting saved session file');}
    }
  }
}

export async function migrateConversation(root,workspace,codexHome,row) {
  if(!uuid.test(row.id))throw new Error('Invalid conversation identity');
  if(row.owner!==root.get('conversation-owner'))throw new Error('Conversation owner mismatch');
  workspace=await fs.realpath(workspace);
  const marker=`shared-owner-migration:${row.id}`;
  if(root.get(marker))return;
  const base=path.join(workspace,'state','conversations',row.id);
  let legacy;try {legacy=await fs.realpath(path.join(base,'assistant.sqlite'));}catch(e){if(e.code==='ENOENT')return;throw e;}
  if(legacy!==path.join(base,'assistant.sqlite'))throw new Error('Unsafe legacy conversation database');
  for(const directory of ['sessions','archived_sessions'])await copySessions(path.join(base,'codex',directory),path.join(codexHome,directory));
  const old=new DatabaseSync(legacy,{readOnly:true}),db=root.db;
  try {
    const owner=old.prepare("SELECT value FROM meta WHERE key='conversation-owner'").get()?.value;
    if(owner!==row.owner||old.prepare('SELECT owner FROM conversations WHERE id=?').get(row.id)?.owner!==row.owner)throw new Error('Legacy conversation owner mismatch');
    root.transaction(()=>{
      const historyMap=new Map(),memoryMap=new Map(),learningMap=new Map();
      const tables=new Set(old.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
      const rows=table=>tables.has(table)?old.prepare(`SELECT * FROM ${table}`).all():[];
      const insert=(table,value)=>{const keys=Object.keys(value);return db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>value[k]));};
      for(const table of ['inputs','history','jobs','schedules','outbox','memories','memory_versions','memory_tombstones','learning_records','learning_versions','learning_reviews'])for(const record of rows(table))if(record.user!==row.owner)throw new Error('Foreign owner in legacy data');
      for(const record of rows('main_sessions')) {
        if(record.conversation_id!==row.id)throw new Error('Foreign session in legacy data');
        if(db.prepare('SELECT id FROM main_sessions WHERE id=?').get(record.id))throw new Error('Conflicting legacy session');
        insert('main_sessions',record);
      }
      for(const record of rows('history')) {
        const {id,...value}=record;
        historyMap.set(id,Number(insert('history',{...value,conversation_id:row.id}).lastInsertRowid));
      }
      const mappedKey=(table,key)=>{
        if(!db.prepare(`SELECT key FROM ${table} WHERE user=? AND key=?`).get(row.owner,key)&&!db.prepare('SELECT key FROM memory_tombstones WHERE user=? AND key=?').get(row.owner,key))return key;
        const suffix=createHash('sha256').update(row.id+':'+key).digest('hex').slice(0,12);
        return `${key.slice(0,65)}-g-${suffix}`;
      };
      for(const record of [...rows('memories'),...rows('memory_tombstones'),...rows('memory_versions')])if(!memoryMap.has(record.key))memoryMap.set(record.key,mappedKey('memories',record.key));
      for(const record of rows('learning_records'))learningMap.set(record.key,mappedKey('learning_records',record.key));
      const source=value=>{
        if(typeof value!=='string')return value;
        if(/^history:\d+$/.test(value)){const id=historyMap.get(Number(value.slice(8)));if(!id)throw new Error('Missing legacy evidence');return `history:${id}`;}
        const memory=value.match(/^memory:([a-z0-9-]+)@(\d+)$/);if(memory)return `memory:${memoryMap.get(memory[1])||memory[1]}@${memory[2]}`;
        if(/^(inbox|projects|tasks|outputs|memory)\//.test(value)||value==='USER.md')return `conversations/${row.id}/${value}`;
        return value;
      };
      const rewrite=value=>{
        if(Array.isArray(value))return value.map(rewrite);
        if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,key==='key'&&typeof v==='string'?(memoryMap.get(v)||v):rewrite(v)]));
        return source(value);
      };
      for(const table of ['inputs','jobs','schedules','outbox'])for(const record of rows(table)) {
        const value={...record,conversation_id:row.id};
        if(table==='jobs'&&maintenance.test(value.prompt)&&['queued','running'].includes(value.state))value.state='cancelled';
        if(table==='schedules') {
          value.unique_key=value.kind==='reminder'||value.kind==='task'?`${row.id}:${value.unique_key}`:`legacy:${row.id}:${value.unique_key||value.id}`;
          if(!['reminder','task'].includes(value.kind))value.enabled=0;
        }
        if(table==='outbox') {
          const payload=JSON.parse(value.payload);if(payload.path&&!path.isAbsolute(payload.path))payload.path=`conversations/${row.id}/${payload.path}`;
          value.payload=JSON.stringify(payload);delete value.id;
        }
        if(table==='inputs'&&db.prepare('SELECT id FROM inputs WHERE id=?').get(value.id)) {
          if(value.id>0)throw new Error('Conflicting Telegram update');
          value.id=db.prepare('SELECT min(coalesce(min(id),0),0)-1 AS id FROM inputs').get().id;
        }
        insert(table,value);
        if(table==='jobs'&&!maintenance.test(value.prompt)&&['completed','failed','cancelled','interrupted'].includes(value.state))db.prepare('INSERT OR IGNORE INTO learning_events(user,source,created) VALUES (?,?,?)').run(row.owner,`job:${value.id}`,value.created);
      }
      for(const record of rows('memories')) {
        const {id,...value}=record;value.key=memoryMap.get(record.key);value.sources=JSON.stringify(JSON.parse(value.sources).map(source));value.exported_seq=0;
        if(value.key!==record.key){value.status='archived';value.origin='migration-conflict';}
        value.seq=db.prepare('SELECT coalesce(max(seq),0)+1 AS n FROM memories').get().n;
        const result=insert('memories',value);db.prepare('INSERT INTO memory_fts(rowid,title,content) VALUES (?,?,?)').run(result.lastInsertRowid,value.title,value.content);
      }
      for(const record of rows('memory_versions')) {
        const {id,...value}=record;value.key=memoryMap.get(value.key);
        const original=JSON.parse(value.payload),{entity,project,...evidence}=original;
        // Exact retrieval tags are literals, even when they look like source IDs/paths.
        const payload=rewrite(evidence);
        for(const field of ['entity','project'])if(Object.hasOwn(original,field))payload[field]=original[field];
        value.payload=JSON.stringify(payload);insert('memory_versions',value);
      }
      for(const record of rows('memory_tombstones')) {
        const value={...record,key:memoryMap.get(record.key),blocked_history:JSON.stringify(JSON.parse(record.blocked_history).map(id=>{if(!historyMap.has(id))throw new Error('Missing forgotten source');return historyMap.get(id);} ))};insert('memory_tombstones',value);
      }
      for(const table of ['learning_records','learning_versions'])for(const record of rows(table)) {
        const value={...record,key:learningMap.get(record.key)||record.key};
        const payload=rewrite(JSON.parse(record.payload));payload.key=value.key;
        if(value.key!==record.key)payload.status='retired';
        value.payload=JSON.stringify(payload);if(table==='learning_records'){value.offered=null;value.outbox_id=null;}
        insert(table,value);
      }
      for(const record of rows('learning_reviews'))insert('learning_reviews',{...record,id:`${row.id}:${record.id}`,payload:JSON.stringify(rewrite(JSON.parse(record.payload)))});
      for(const record of old.prepare('SELECT * FROM meta').all()) {
        if(/^(memory-|learning-|cleanup-|proactive-|coverage:|review:)/.test(record.key))continue;
        let value=record.value;
        if(record.key.startsWith('thread-history:')&&historyMap.has(Number(value)))value=String(historyMap.get(Number(value)));
        db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`conversation:${row.id}:${record.key}`,value);
      }
      root.set(marker,JSON.stringify({version:1,history:historyMap.size,conflicts:[...memoryMap].filter(([a,b])=>a!==b).length}));
      root.set('memory-export-dirty','1');root.set('learning-export-dirty','1');
    });
  } finally {old.close();}
}
