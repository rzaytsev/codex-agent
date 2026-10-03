import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Memory } from '../src/memory.js';
import { Learning } from '../src/learning.js';
import { migrateConversation } from '../src/conversation-migration.js';

async function fixture(t) {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'owner-migration-')),codex=path.join(workspace,'codex');
  const root=new Store(path.join(workspace,'root.sqlite'));root.bindConversation('123');
  const memory=new Memory(workspace,root,'123'),learning=new Learning(workspace,root,'123');
  const row={id:randomUUID(),owner:'123',chat_id:'-100',kind:'group',session_id:randomUUID(),title:'Test'};
  root.db.prepare('INSERT INTO conversations(id,owner,chat_id,kind,title,session_id) VALUES (?,?,?,?,?,?)').run(row.id,row.owner,row.chat_id,row.kind,row.title,row.session_id);
  const groupDir=path.join(workspace,'conversations',row.id),base=path.join(workspace,'state','conversations',row.id);await fs.mkdir(base,{recursive:true});await fs.mkdir(groupDir,{recursive:true});
  const old=new Store(path.join(base,'assistant.sqlite'));old.bindConversation('123',{id:row.id,chatId:row.chat_id,kind:'group',sessionId:row.session_id});
  new Learning(groupDir,old,'123');const oldMemory=new Memory(groupDir,old,'123');
  // Model the legacy unnamespaced metadata without using private runtime data.
  const legacyMeta=(key,value)=>old.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));
  legacyMeta('conversation-owner','123');legacyMeta('thread:123','saved-group-thread');
  t.after(async()=>{root.db.close();old.db.close();await fs.rm(workspace,{recursive:true,force:true});});
  return {workspace,codex,root,memory,learning,row,old,oldMemory,base,groupDir,legacyMeta};
}

test('legacy migration preserves evidence, revisions, tombstones, tasks, routing and saved rollouts exactly once',async t=>{
  const f=await fixture(t),{root,old,memory,oldMemory,row,workspace,codex,base,groupDir,learning}=f;
  root.history('123','user','Root evidence');old.history('123','user','Group evidence');const hid=old.search('123')[0].id;
  const record={key:'legacy',category:'facts',title:'Legacy',content:'Version one',certainty:'confirmed',sources:[`history:${hid}`],expected_revision:0};oldMemory.save(record);oldMemory.save({...record,content:'Version two',expected_revision:1});
  old.history('123','user','Forgotten source');const forgottenId=old.search('123').at(-1).id;
  oldMemory.save({...record,key:'forgotten',sources:[`history:${forgottenId}`]});oldMemory.forget('forgotten');
  old.ingest(-1,'123',{event:true,text:'Legacy event'});root.ingest(-1,'123',{event:true,text:'Root event'});
  const task=old.job('123','Saved ordinary task');const global=old.job('123','[MEMORY] Legacy scheduled consolidation');
  old.schedule(randomUUID(),'123','reminder','Group reminder',null,'UTC',Date.now()+60000,'123:key');
  old.schedule(randomUUID(),'123','memory','daily','0 1 * * *','UTC',Date.now()+60000,'memory:123:daily');
  old.enqueue('123',{path:'outputs/file.txt',type:'document'});
  await fs.mkdir(path.join(groupDir,'outputs'));await fs.writeFile(path.join(groupDir,'outputs/file.txt'),'Synthetic file');
  const session=path.join(base,'codex/sessions/2026/10');await fs.mkdir(session,{recursive:true});await fs.writeFile(path.join(session,'rollout.jsonl'),'Synthetic saved session');
  await migrateConversation(root,workspace,codex,row);
  const imported=root.search('123','Group evidence',0,{all:true})[0];assert.notEqual(imported.id,hid);assert.equal(imported.conversation_id,row.id);
  assert.equal(memory.get('legacy').content,'Version two');assert.deepEqual(memory.get('legacy').sources,[`history:${imported.id}`]);assert.equal(memory.get('legacy',1).content,'Version one');
  assert.equal(memory.get('forgotten'),null);assert.deepEqual(JSON.parse(root.db.prepare("SELECT blocked_history FROM memory_tombstones WHERE key='forgotten'").get().blocked_history),[root.search('123','Forgotten source',0,{all:true})[0].id]);
  assert.equal(learning.evidence(`history:${imported.id}`).original_owner_statement,true);
  assert.equal(root.db.prepare('SELECT conversation_id FROM jobs WHERE id=?').get(task).conversation_id,row.id);assert.equal(root.db.prepare('SELECT state FROM jobs WHERE id=?').get(global).state,'cancelled');
  assert.equal(root.db.prepare("SELECT enabled FROM schedules WHERE kind='memory'").get().enabled,0);
  assert.equal(JSON.parse(root.db.prepare('SELECT payload FROM outbox').get().payload).path,`conversations/${row.id}/outputs/file.txt`);
  assert.equal(await fs.readFile(path.join(codex,'sessions/2026/10/rollout.jsonl'),'utf8'),'Synthetic saved session');
  assert.equal(root.db.prepare('SELECT value FROM meta WHERE key=?').get(`conversation:${row.id}:thread:123`).value,'saved-group-thread');
  const count=root.db.prepare('SELECT count(*) AS n FROM history').get().n;await migrateConversation(root,workspace,codex,row);assert.equal(root.db.prepare('SELECT count(*) AS n FROM history').get().n,count);assert.equal(old.search('123')[0].text,'Group evidence');
});

test('conflicting facts are archived rather than overwriting root knowledge; legacy forgetting cannot revive root tombstones',async t=>{
  const {root,old,memory,oldMemory,row,workspace,codex}=await fixture(t);
  for(const s of [root,old])s.history('123','user','Source');
  const value={key:'same',category:'facts',title:'Same',content:'Root fact',certainty:'confirmed',sources:['history:1'],expected_revision:0};memory.save(value);oldMemory.save({...value,content:'Group conflict'});
  memory.save({...value,key:'blocked'});memory.forget('blocked');oldMemory.save({...value,key:'blocked',content:'Must not revive'});
  await migrateConversation(root,workspace,codex,row);
  assert.equal(memory.get('same').content,'Root fact');assert.equal(memory.get('blocked'),null);
  assert.equal(root.db.prepare("SELECT count(*) AS n FROM memories WHERE origin='migration-conflict' AND status='archived'").get().n,2);
  assert.ok(memory.search('').entries.every(r=>r.content!=='Group conflict'&&r.content!=='Must not revive'));
});

test('migration rejects foreign owners atomically and preserves the legacy database',async t=>{
  const {root,old,row,workspace,codex}=await fixture(t);old.history('456','user','Foreign input');
  await assert.rejects(migrateConversation(root,workspace,codex,row),/Foreign owner/);
  assert.equal(root.db.prepare('SELECT count(*) AS n FROM history').get().n,0);assert.equal(root.get(`shared-owner-migration:${row.id}`),undefined);
  assert.equal(old.db.prepare('SELECT count(*) AS n FROM history').get().n,1);
});

test('migration rejects a foreign conversation owner before importing data',async t=>{
  const {root,row,workspace,codex}=await fixture(t);
  await assert.rejects(migrateConversation(root,workspace,codex,{...row,owner:'456'}),/Conversation owner mismatch/);
  assert.equal(root.get(`shared-owner-migration:${row.id}`),undefined);
});

test('migration rejects foreign memory records atomically',async t=>{
  const {root,old,oldMemory,row,workspace,codex}=await fixture(t);
  old.history('123','user','Synthetic evidence');
  oldMemory.save({key:'foreign',category:'facts',title:'Foreign',content:'Synthetic fact',certainty:'confirmed',sources:['history:1'],expected_revision:0});
  old.db.prepare("UPDATE memories SET user='456'").run();
  await assert.rejects(migrateConversation(root,workspace,codex,row),/Foreign owner/);
  assert.equal(root.db.prepare('SELECT count(*) AS n FROM history').get().n,0);
  assert.equal(root.db.prepare('SELECT count(*) AS n FROM memories').get().n,0);
  assert.equal(root.get(`shared-owner-migration:${row.id}`),undefined);
});
