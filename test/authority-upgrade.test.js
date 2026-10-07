import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';

const owner='123',message=text=>({from:{id:123},chat:{id:123,type:'private'},text});
const metadata=JSON.parse(await fs.readFile(new URL('./fixtures/pre-quote-upgrade.json',import.meta.url),'utf8'));
const apply=(learning,change)=>{
  const batch=learning.batch(learning.target());
  // Cite current review context alongside the retained source; never rewind the cursor.
  change={...change,sources:[...new Set([...change.sources,...batch.records.slice(-1).map(r=>r.source)])]};
  return learning.apply(batch,{summary:'',changes:[change]},{decisions:[{key:change.key,accept:true,reason:'Synthetic acceptance.'}]},randomUUID());
};
const preference=(source,key='new-preference')=>({key,kind:'preference',target:'USER.md',content:'Use short answers.',scope:'general',expected_benefit:'Concise replies.',check:'Owner prefers concise replies.',sources:[source],expected_revision:0,status:'active'});
const confirmed=(service,source,key='new-fact')=>service.memory.save({key,category:'facts',title:'Synthetic fact',content:'Use short answers.',certainty:'confirmed',sources:[source],expected_revision:0});
const audit=db=>Object.fromEntries(['history','learning_records','learning_versions','learning_outcomes','learning_reviews','memories','memory_versions'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
async function fixture(t,{historical=true}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'authority-upgrade-')),file=path.join(dir,'db');
  const cfg=config({WORKSPACE_DIR:dir,CODEX_HOME:path.join(dir,'empty-codex'),TELEGRAM_ALLOWED_USER_IDS:owner,PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',BROWSER_ENABLED:'false'});
  let before;
  if(historical) {
    const sql=await fs.readFile(new URL('./fixtures/pre-quote-upgrade.sql',import.meta.url),'utf8');
    assert.equal(createHash('sha256').update(sql).digest('hex'),metadata.fixtureSha256);
    const old=new DatabaseSync(file);old.exec(sql);before=audit(old);
    assert.equal(old.prepare('PRAGMA table_info(history_origins)').all().length,3);
    assert.equal(old.prepare('SELECT origin FROM history_origins WHERE history_id=?').get(Number(metadata.quoted.slice(8))).origin,'direct_owner');
    assert.ok(old.prepare('SELECT payload FROM inputs').all().some(r=>JSON.parse(r.payload).entities?.[0]?.type==='blockquote'));
    old.close();
  }
  const store=new Store(file),service=new Service(cfg,store,{},{});await service.init();
  t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,file,cfg,store,service,learning:service.learning,before};
}
function promotion(learning,key,source) {
  const r=learning.get(key);return Object.fromEntries(Object.keys(preference(source)).map(k=>[k,k==='sources'?[source]:k==='expected_revision'?r.revision:k==='status'?'active':r[k]]));
}
function record(learning,key,source,authority='explicit_owner',outcome='improved') {
  const r=learning.get(key);return learning.recordOutcome({key,candidate_revision:r.revision,candidate_hash:r.candidate_hash,check_hash:r.check_hash,outcome,observed_at:Math.max(Date.now(),r.updated+1),evidence_ids:[source]},{kind:authority});
}

test('actual pre-quote database retains active records and audit but cannot mint new owner authority',async t=>{
  const f=await fixture(t);
  assert.deepEqual(audit(f.store.db),f.before);
  assert.equal(f.service.memory.get('retained-fact').certainty,'confirmed');
  assert.equal(f.learning.get('retained-preference').status,'active');
  assert.equal(f.learning.get('retained-active-rule').status,'active');
  assert.ok(f.learning.context('planning').some(r=>r.key==='retained-active-rule'));
  for(const source of [metadata.quoted,metadata.direct]) {
    assert.equal(f.learning.evidence(source).original_owner_statement,false);
    assert.equal(f.service.memory.historyEvidence(source).original_owner_statement,false);
    assert.equal(f.store.historySource(Number(source.slice(8)),owner),'legacy_unknown');
    assert.equal(f.store.db.prepare('SELECT provenance_version FROM history_origins WHERE history_id=?').get(Number(source.slice(8))).provenance_version,0);
    assert.throws(()=>apply(f.learning,preference(source)),/owner evidence/i);
    assert.throws(()=>confirmed(f.service,source),/evidence|confirmed/i);
  }
  assert.deepEqual(audit(f.store.db),f.before);
  // The separately documented generic legacy factual-evidence path is retained.
  confirmed(f.service,metadata.generic,'generic-legacy-fact');
  assert.throws(()=>apply(f.learning,preference(metadata.generic)),/owner evidence/i);
  const source='history:'+f.store.ownerHistory(f.cfg,message('Use short answers.'),'Use short answers.');
  apply(f.learning,preference(source));confirmed(f.service,source);
  assert.equal(f.learning.get('new-preference').status,'active');
  assert.equal(f.service.memory.get('new-fact').certainty,'confirmed');
});

test('retained Task-8 attribution without a version also requires fresh owner evidence',async t=>{
  const f=await fixture(t,{historical:false});
  const source='history:'+f.store.ownerHistory(f.cfg,message('Use short answers.'),'Use short answers.');
  if(f.store.db.prepare('PRAGMA table_info(history_origins)').all().some(c=>c.name==='provenance_version'))f.store.db.exec('ALTER TABLE history_origins DROP COLUMN provenance_version');
  const reopened=new Store(f.file);t.after(()=>reopened.db.close());
  assert.equal(f.learning.evidence(source).original_owner_statement,false);
  assert.equal(f.service.memory.historyEvidence(source).original_owner_statement,false);
  assert.throws(()=>apply(f.learning,preference(source)),/owner evidence/i);
  assert.throws(()=>confirmed(f.service,source),/evidence|confirmed/i);
});

test('a corrected quote flag overrides retained direct-owner origin in both shared consumers',async t=>{
  const f=await fixture(t,{historical:false});
  const id=f.store.ownerHistory(f.cfg,message('Use short answers.'),'Use short answers.'),source='history:'+id;
  assert.equal(f.learning.evidence(source).original_owner_statement,true);
  f.store.db.prepare('UPDATE history_origins SET known_quote=1 WHERE history_id=?').run(id);
  assert.equal(f.learning.evidence(source).original_owner_statement,false);
  assert.equal(f.service.memory.historyEvidence(source).original_owner_statement,false);
  assert.throws(()=>apply(f.learning,preference(source)),/owner evidence/i);
  assert.throws(()=>confirmed(f.service,source),/evidence|confirmed/i);
});

for(const corrected of [false,true])test(`actual retained quoted explicit-owner receipt cannot authorize a new promotion (correction=${corrected})`,async t=>{
  const f=await fixture(t),{receiptSource,receiptId}=metadata.rules['quoted-trial'];
  if(corrected)f.store.db.prepare("UPDATE history_origins SET origin='other',known_quote=1 WHERE history_id=?").run(Number(receiptSource.slice(8)));
  assert.equal(f.learning.evidence(receiptSource).original_owner_statement,false);
  assert.equal(f.learning.outcomes('quoted-trial')[0].id,receiptId);
  assert.throws(()=>apply(f.learning,promotion(f.learning,'quoted-trial',receiptSource)),/receipt/i);
  assert.equal(f.learning.get('quoted-trial').status,'trial');
  assert.deepEqual(audit(f.store.db),f.before);
});

test('fresh direct-owner evidence promotes an upgraded trial without removing the old receipt',async t=>{
  const f=await fixture(t),source='history:'+f.store.ownerHistory(f.cfg,message('The later plan helped.'),'The later plan helped.');
  record(f.learning,'quoted-trial',source);
  apply(f.learning,promotion(f.learning,'quoted-trial',source));
  assert.equal(f.learning.get('quoted-trial').status,'active');
  assert.equal(f.learning.outcomes('quoted-trial').length,2);
});

test('a deterministic host check keeps its distinct authority for later non-owner evidence',async t=>{
  const f=await fixture(t),{receiptSource}=metadata.rules['quoted-trial'];
  assert.equal(f.learning.evidence(receiptSource).original_owner_statement,false);
  record(f.learning,'quoted-trial',receiptSource,'deterministic_check');
  apply(f.learning,promotion(f.learning,'quoted-trial',receiptSource));
  assert.equal(f.learning.get('quoted-trial').status,'active');
});

test('correcting current explicit-owner receipt authority blocks improvement but retains regression veto',async t=>{
  const f=await fixture(t),id=f.store.ownerHistory(f.cfg,message('The later plan helped.'),'The later plan helped.'),source='history:'+id;
  record(f.learning,'quoted-trial',source);
  f.store.db.prepare('UPDATE history_origins SET known_quote=1 WHERE history_id=?').run(id);
  assert.throws(()=>apply(f.learning,promotion(f.learning,'quoted-trial',source)),/receipt/i);
  const regressionId=f.store.ownerHistory(f.cfg,message('The plan regressed.'),'The plan regressed.'),regressionSource='history:'+regressionId;
  record(f.learning,'quoted-trial',regressionSource,'explicit_owner','regressed');
  f.store.db.prepare('UPDATE history_origins SET known_quote=1 WHERE history_id=?').run(regressionId);
  record(f.learning,'quoted-trial',source,'deterministic_check');
  assert.throws(()=>apply(f.learning,promotion(f.learning,'quoted-trial',source)),/regression/i);
  assert.equal(f.learning.outcomes('quoted-trial').length,4);
});
