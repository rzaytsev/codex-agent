import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Memory, MemoryConflict, memorySchema } from '../src/memory.js';

async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'memory-temporal-'));
  const cfg=config({WORKSPACE_DIR:dir,TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',BROWSER_ENABLED:'false'});
  const store=new Store(path.join(dir,'db')),service=new Service(cfg,store,{},{});await service.init();
  store.history('123','user','Synthetic project evidence');
  t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,store,service,memory:service.memory};
}
const record=(key,extra={})=>({key,category:'facts',title:key,content:'cobalt project evidence',certainty:'confirmed',sources:['history:1'],expected_revision:0,status:'active',...extra});
const iso=value=>new Date(value).toISOString();
const fields=['observed_at','valid_from','valid_to','review_after','entity','project'];

test('metadata is normalized, preserved by omitted corrections, cleared explicitly, and revisioned with CAS',async t=>{
  const {memory,dir}=await fixture(t);
  const first=memory.save(record('travel',{observed_at:'2026-05-01T12:00:00+02:00',valid_from:'2026-06-01T00:00:00Z',valid_to:'2026-07-01T00:00:00Z',review_after:'2026-06-15T00:00:00Z',entity:' Traveler ',project:' Launch '})).entry;
  assert.equal(first.observed_at,'2026-05-01T10:00:00.000Z');assert.equal(first.entity,'Traveler');assert.equal(first.project,'Launch');
  memory.save(record('travel',{content:'updated evidence',expected_revision:1}));
  for(const name of fields)assert.equal(memory.get('travel')[name],first[name]);
  memory.save(record('travel',{expected_revision:2,valid_from:null,valid_to:null,entity:null}));
  assert.equal(memory.get('travel').valid_to,null);assert.equal(memory.get('travel').entity,null);
  assert.equal(memory.get('travel',1).valid_to,first.valid_to);assert.equal(memory.get('travel',2).entity,'Traveler');
  assert.throws(()=>memory.save(record('travel',{expected_revision:1})),error=>error instanceof MemoryConflict&&error.current.revision===3&&error.current.project==='Launch');
  const markdown=await fs.readFile(path.join(dir,'memory/facts/travel.md'),'utf8');
  assert.match(markdown,/Observed at: 2026-05-01T10:00:00.000Z/);assert.match(markdown,/Project: Launch/);assert.doesNotMatch(markdown,/Valid to:/);
});

test('current recall excludes only explicit outside-validity records and marks review due without deleting evidence',async t=>{
  const {memory,store}=await fixture(t),now=Date.now();
  memory.save(record('expired',{valid_to:iso(now-10000)}));
  memory.save(record('future',{valid_from:iso(now+60000)}));
  memory.save(record('review-due',{review_after:iso(now-10000)}));
  memory.save(record('unbounded'));
  const current=memory.search('cobalt').entries;
  assert.deepEqual(current.map(row=>row.key).sort(),['review-due','unbounded']);
  assert.equal(current.find(row=>row.key==='review-due').review_due,true);assert.equal(current.find(row=>row.key==='unbounded').review_due,false);
  const context=memory.context('cobalt');assert.deepEqual(context.map(row=>row.key).sort(),['review-due','unbounded']);
  const unbounded=context.find(row=>row.key==='unbounded');for(const name of [...fields,'review_due'])assert.equal(Object.hasOwn(unbounded,name),false);
  assert.equal(context.find(row=>row.key==='review-due').review_due,true);
  assert.equal(memory.get('expired').key,'expired');assert.equal(memory.get('future',1).key,'future');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_versions').get().n,4);
});

test('valid-time queries use inclusive starts and exclusive ends and do not reconstruct old revisions',async t=>{
  const {memory}=await fixture(t),start='2026-06-01T00:00:00Z',end='2026-07-01T00:00:00Z';
  memory.save(record('travel',{valid_from:start,valid_to:end,review_after:'2026-06-15T00:00:00Z',entity:'Traveler',project:'Launch'}));
  assert.equal(memory.search('cobalt',{as_of:start}).entries.length,1);
  assert.equal(memory.search('cobalt',{as_of:'2026-06-01T02:00:00+02:00'}).entries.length,1);
  assert.equal(memory.search('cobalt',{as_of:end}).entries.length,0);
  assert.equal(memory.search('cobalt',{as_of:'2026-05-31T23:59:59.999Z'}).entries.length,0);
  assert.equal(memory.search('',{as_of:start}).entries[0].review_due,false);
  assert.equal(memory.search('',{as_of:'2026-06-15T00:00:00Z'}).entries[0].review_due,true);
  memory.save(record('travel',{expected_revision:1,valid_from:end,valid_to:'2026-08-01T00:00:00Z',content:'amber project evidence'}));
  assert.equal(memory.search('cobalt',{as_of:start}).entries.length,0);
  assert.equal(memory.get('travel',1,{as_of:start,entity:'Traveler',project:'Launch'}).revision,1);
  assert.equal(memory.get('travel',1,{as_of:end}),null);assert.equal(memory.get('travel',undefined,{as_of:start}),null);
  assert.equal(memory.get('travel',1,{as_of:start,entity:'Other'}),null);
  assert.equal(memory.get('travel',1,{as_of:start,project:'Other'}),null);
  assert.equal(memory.get('travel',1).valid_from,iso(start));
});

test('SQL applies entity, project and validity filters before limits and keeps keyword relevance and listing cursors',async t=>{
  const {memory}=await fixture(t),as_of='2026-06-01T00:00:00Z';
  for(let i=0;i<35;i++)memory.save(record('expired-'+i,{title:'cobalt',valid_to:as_of,entity:'Traveler',project:'Launch'}));
  for(let i=0;i<35;i++)memory.save(record('other-'+i,{title:'cobalt',entity:'Other',project:'Launch'}));
  memory.save(record('other-project',{title:'cobalt',entity:'Traveler',project:'Other'}));
  const one=memory.save(record('eligible-one',{title:'cobalt',entity:'Traveler',project:'Launch'})).entry;
  const two=memory.save(record('eligible-two',{title:'another title',content:'cobalt '+('other words '.repeat(50)),entity:'Traveler',project:'Launch'})).entry;
  const filters={entity:'Traveler',project:'Launch',as_of,limit:1};
  assert.equal(memory.search('cobalt',filters).entries[0].key,one.key);
  assert.deepEqual(memory.search('cobalt',{...filters,limit:30}).entries.map(row=>row.key),[one.key,two.key]);
  const page=memory.search('',filters);assert.equal(page.entries[0].key,one.key);
  assert.equal(memory.search('',{...filters,after:page.next_cursor}).entries[0].key,two.key);
  assert.equal(memory.search('',{...filters,after:two.id}).entries.length,0);
  assert.equal(memory.search('cobalt',{...filters,entity:'traveler'}).entries.length,0);
  assert.deepEqual(memory.context('cobalt',filters).map(row=>row.key),[one.key,two.key]);
});

test('invalid timestamps, ranges and tags cannot change records, and validation also covers retrieval',async t=>{
  const {memory,store}=await fixture(t);memory.save(record('stable',{valid_from:'2026-06-01T00:00:00Z',valid_to:'2026-07-01T00:00:00Z'}));
  const invalid=['not-a-date','2026-06-01','2026-06-01T00:00:00','2026-02-30T00:00:00Z','2026-06-01T00:00:00+24:00','0000-01-01T00:00:00+01:00','9999-12-31T23:59:59-01:00',123,''];
  for(const name of fields.slice(0,4))for(const value of invalid)assert.throws(()=>memory.save(record('bad',{[name]:value})),/Invalid memory/);
  for(const value of ['', ' ', 'x'.repeat(161),123,'line\nbreak','password=verylongcredential123456'])for(const name of ['entity','project'])assert.throws(()=>memory.save(record('bad',{[name]:value})),/Invalid memory/);
  for(const valid_to of ['2026-06-01T00:00:00Z','2026-05-01T00:00:00Z'])assert.throws(()=>memory.save(record('stable',{expected_revision:1,valid_to})),/Invalid memory/);
  for(const as_of of [...invalid,null]) {
    assert.throws(()=>memory.search('',{as_of}),/Invalid memory/);
    assert.throws(()=>memory.get('missing',undefined,{as_of}),/Invalid memory/);
    assert.throws(()=>memory.context('cobalt',{as_of}),/Invalid memory/);
  }
  for(const name of ['entity','project'])for(const value of ['',null,123])assert.throws(()=>memory.search('',{[name]:value}),/Invalid memory/);
  assert.equal(memory.get('stable').revision,1);assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_versions').get().n,1);
});

test('consolidation validates temporal metadata in the atomic batch and exposes nullable proposal fields',async t=>{
  const {memory,store}=await fixture(t),batch=memory.batch('daily',1);
  const first=record('first',{entity:'Traveler',observed_at:'2026-06-01T00:00:00Z'});
  assert.throws(()=>memory.consolidate('daily',batch,{summary:'',changes:[first,record('bad',{valid_from:'2026-07-01T00:00:00Z',valid_to:'2026-06-01T00:00:00Z'})]},'temporal'));
  assert.equal(memory.get('first'),null);assert.equal(store.get('memory-cursor:123:daily'),undefined);
  memory.consolidate('daily',batch,{summary:'',changes:[first]},'temporal');
  assert.equal(memory.get('first').observed_at,'2026-06-01T00:00:00.000Z');assert.equal(store.get('memory-cursor:123:daily'),'1');
  for(const name of fields)assert.deepEqual(memorySchema.properties.changes.items.properties[name].type,['string','null']);
});

test('tool routing passes temporal filters and metadata through existing owner and role boundaries',async t=>{
  const {service,memory}=await fixture(t),at='2026-06-01T00:00:00Z';
  await service.tool({user:'123',worker:true},'memory_save',record('shared',{entity:'Traveler',project:'Launch',valid_from:at,valid_to:'2026-07-01T00:00:00Z'}));
  assert.equal((await service.tool({user:'123',worker:true,memoryReview:true},'memory_search',{entity:'Traveler',project:'Launch',as_of:at})).entries[0].key,'shared');
  assert.equal(await service.tool({user:'123'},'memory_read',{key:'shared',entity:'Other',as_of:at}),null);
  assert.equal((await service.tool({user:'123'},'memory_read',{key:'shared',revision:1,as_of:at})).valid_from,iso(at));
  await assert.rejects(service.tool({user:'456'},'memory_read',{key:'shared',as_of:at}));
  await assert.rejects(service.tool({user:'123',worker:true,memoryReview:true},'memory_save',record('forbidden')));
  assert.equal(memory.get('shared').revision,1);
});

test('additive schema migration preserves legacy versions and export, then survives repeated startup',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'memory-legacy-')),store=new Store(path.join(dir,'db'));
  t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  store.db.exec('CREATE TABLE memories(id INTEGER PRIMARY KEY AUTOINCREMENT,user TEXT NOT NULL,key TEXT NOT NULL,category TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,certainty TEXT NOT NULL,sources TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,seq INTEGER NOT NULL,origin TEXT NOT NULL,exported_seq INTEGER NOT NULL DEFAULT 0,UNIQUE(user,key))');
  store.db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(1,'123','legacy','facts','Legacy','cobalt legacy','confirmed','["https://example.com/"]','active',1,1,1,1,'conversation',0);
  await fs.mkdir(path.join(dir,'memory/facts'),{recursive:true});
  await fs.writeFile(path.join(dir,'memory/facts/legacy.md'),'# Legacy\n\nCategory: facts\nStatus: active\nCertainty: confirmed\nRevision: 1\nCreated: 1970-01-01T00:00:00.001Z\nUpdated: 1970-01-01T00:00:00.001Z\n\ncobalt legacy\n\nSources:\n- https://example.com/\n');
  const memory=new Memory(dir,store,'123');assert.doesNotThrow(()=>memory.migrate());
  const payload=JSON.stringify({user:'123',key:'legacy',category:'facts',title:'Legacy',content:'old cobalt',certainty:'confirmed',sources:['https://example.com/'],status:'active',revision:1,created:1,updated:1});
  store.db.prepare('INSERT INTO memory_versions(user,key,revision,payload,created) VALUES (?,?,?,?,?)').run('123','legacy',1,payload,1);
  store.db.prepare('INSERT INTO memory_fts(rowid,title,content) VALUES (?,?,?)').run(1,'Legacy','cobalt legacy');
  assert.equal(memory.search('cobalt').entries[0].key,'legacy');for(const name of fields)assert.equal(memory.get('legacy')[name],null);
  assert(memory.project());const markdown=await fs.readFile(path.join(dir,'memory/facts/legacy.md'),'utf8');assert.doesNotMatch(markdown,/Valid from:|Entity:/);
  memory.save({...record('legacy'),sources:['https://example.com/'],expected_revision:1,valid_to:'2026-01-01T00:00:00Z'});
  const restarted=new Memory(dir,store,'123');assert.equal(restarted.search('cobalt').entries.length,0);assert.equal(restarted.get('legacy',1).content,'old cobalt');
  for(const name of fields)assert.equal(restarted.get('legacy',1)[name],null);
  assert.equal(store.db.prepare('SELECT payload FROM memory_versions WHERE revision=1').get().payload,payload);
  assert.equal(store.db.prepare('PRAGMA table_info(memories)').all().filter(row=>fields.includes(row.name)).length,6);
});


test('forget clears added content-bearing tags and dates along with the existing record data',async t=>{
  const {memory,store,dir}=await fixture(t);
  memory.save(record('temporary',{entity:'Traveler',project:'Launch',observed_at:'2026-05-01T00:00:00Z',valid_from:'2026-06-01T00:00:00Z',valid_to:'2026-07-01T00:00:00Z',review_after:'2026-06-15T00:00:00Z'}));
  memory.forget('temporary');
  const row=store.db.prepare("SELECT * FROM memories WHERE key='temporary'").get();for(const name of fields)assert.equal(row[name],null);
  assert.equal(memory.get('temporary',1,{as_of:'2026-06-01T00:00:00Z'}),null);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_versions').get().n,0);
  await assert.rejects(fs.access(path.join(dir,'memory/facts/temporary.md')));
});
