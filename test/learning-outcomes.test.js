import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';
const owner='123';
const rule=(source,extra={})=>({key:'next-step',kind:'rule',target:'PLAYBOOK.md',content:'Start planning with a practical next step.',scope:'planning',expected_benefit:'Reduce corrections.',check:'The later plan includes a next step.',sources:[source],expected_revision:0,status:'trial',...extra});
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'learning-outcomes-'));const cfg=config({WORKSPACE_DIR:dir,TELEGRAM_ALLOWED_USER_IDS:owner,PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',BROWSER_ENABLED:'false'});const store=new Store(path.join(dir,'db'));const service=new Service(cfg,store,{},{});await service.init();t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});return {dir,cfg,store,service,learning:service.learning};}
const message=text=>({from:{id:123},chat:{id:123,type:'private'},text});
function apply(l,change){const b=l.batch(l.target());return l.apply(b,{summary:'',changes:[change]},{decisions:[{key:change.key,accept:true,reason:'Supported.'}]},'review-'+b.cursor);}
function later(store,cfg,text='The later plan helped.'){const id=store.ownerHistory(cfg,message(text),text);return 'history:'+id;}
function receipt(l,source,outcome='improved',extra={}){const r=l.get('next-step');return {key:r.key,candidate_revision:r.revision,candidate_hash:r.candidate_hash,check_hash:r.check_hash,outcome,observed_at:Math.max(Date.now(),r.updated+1),evidence_ids:[source],...extra};}

test('a model accept and new history cannot promote without a host receipt',async t=>{const {store,learning}=await fixture(t);store.history(owner,'user','Original planning request.');apply(learning,rule('history:1'));store.history(owner,'assistant','It improved.');assert.throws(()=>apply(learning,rule('history:2',{expected_revision:1,status:'active'})),/receipt/i);assert.equal(learning.get('next-step').status,'trial');});
test('outcomes bind revision, content hash, preselected check and genuinely later evidence',async t=>{const {cfg,store,learning}=await fixture(t);later(store,cfg,'Original request.');apply(learning,rule('history:1'));const source=later(store,cfg);const good=receipt(learning,source);for(const bad of [{candidate_revision:2},{candidate_hash:'0'.repeat(64)},{check_hash:'0'.repeat(64)},{evidence_ids:['history:1']},{observed_at:learning.get('next-step').updated}])assert.throws(()=>learning.recordOutcome({...good,...bad},{kind:'deterministic_check'}));learning.recordOutcome(good,{kind:'deterministic_check'});apply(learning,rule(source,{expected_revision:1,status:'active'}));assert.equal(learning.get('next-step').status,'active');assert.equal(learning.outcomes('next-step').length,1);});
test('inconclusive stays trial and regression blocks promotion while preserving receipts after rollback',async t=>{const {cfg,store,learning}=await fixture(t);later(store,cfg,'Original request.');apply(learning,rule('history:1'));const s=later(store,cfg);learning.recordOutcome(receipt(learning,s,'inconclusive'),{kind:'deterministic_check'});assert.throws(()=>apply(learning,rule(s,{expected_revision:1,status:'active'})),/receipt/i);learning.recordOutcome(receipt(learning,s,'regressed'),{kind:'deterministic_check'});learning.recordOutcome(receipt(learning,s),{kind:'deterministic_check'});assert.throws(()=>apply(learning,rule(s,{expected_revision:1,status:'active'})),/regression/i);learning.feedback({key:'next-step',expected_revision:1,action:'rollback',sources:[s]});assert.equal(learning.context('planning').length,0);assert.equal(learning.outcomes('next-step').length,3);assert.equal(learning.get('next-step',1).status,'trial');});
test('profile adoption requires host-attributed direct owner evidence, never row kind or model origin',async t=>{const {cfg,store,learning}=await fixture(t);const change=s=>rule(s,{kind:'preference',target:'USER.md',status:'active'});store.history(owner,'user','I like next steps.');assert.throws(()=>apply(learning,change('history:1')),/owner evidence/i);for(const extra of [{forward_sender_name:'Hidden'},{forward_from:{id:123}},{via_bot:{id:7}},{document:{file_id:'synthetic'}},{chat:{id:123,type:'group'}}]){const id=store.ownerHistory(cfg,{...message('I like next steps.'),...extra},'I like next steps.');assert.throws(()=>apply(learning,change('history:'+id)),/owner evidence/i);}const s=later(store,cfg,'I prefer next steps.');apply(learning,change(s));assert.equal(learning.get('next-step').status,'active');});
test('model-facing registry has no receipt minting tool and direct owner outcomes use exact command',async t=>{const {cfg,store,learning,service}=await fixture(t);later(store,cfg,'Original request.');apply(learning,rule('history:1'));const r=learning.get('next-step');const command=`/learning_outcome next-step 1 ${r.candidate_hash} improved`;assert.equal(service.ingest({update_id:41,message:message(command)}),true);assert.equal(learning.outcomes('next-step')[0].authority,'explicit_owner');for(const name of ['learning_outcome','learning_receipt'])await assert.rejects(service.tool({user:owner},name,{}));assert.equal(service.ingest({update_id:42,message:{...message(command),forward_date:1}}),true);assert.equal(learning.outcomes('next-step').length,1);});

test('host receipts reject unknown, foreign and mismatched run or attempt evidence',async t=>{
  const {cfg,store,learning}=await fixture(t);later(store,cfg,'Original request.');apply(learning,rule('history:1'));const source=later(store,cfg);const good=receipt(learning,source);
  assert.throws(()=>learning.recordOutcome({...good,run_id:'00000000-0000-0000-0000-000000000000'},{kind:'deterministic_check'}),/run evidence/);
  const run=store.observations.run({},undefined),attempt=store.observations.attempt(run,{effort:'low'},'main');store.observations.finishAttempt(attempt,'completed',{});store.observations.finishRun(run,'completed');
  learning.recordOutcome({...good,run_id:run.id,attempt_id:attempt.id},{kind:'deterministic_check'});
  assert.throws(()=>learning.recordOutcome({...good,run_id:run.id,attempt_id:'00000000-0000-0000-0000-000000000000'},{kind:'deterministic_check'}),/attempt evidence/);
  store.db.prepare('UPDATE conversations SET owner=?').run('456');assert.throws(()=>learning.recordOutcome({...good,run_id:run.id},{kind:'deterministic_check'}),/run evidence/);
});
test('additive receipt migration preserves legacy active preferences without granting new authority',async t=>{
  const {dir,cfg,store,learning}=await fixture(t);store.history(owner,'user','Legacy statement.');learning.put(rule('history:1',{kind:'preference',target:'USER.md',status:'active'}));
  const before=store.db.prepare('SELECT payload,revision FROM learning_records').get();const {Learning}=await import('../src/learning.js');const reopened=new Learning(dir,store,owner);
  assert.deepEqual(store.db.prepare('SELECT payload,revision FROM learning_records').get(),before);assert.equal(reopened.context('planning')[0].status,'active');
  const s=later(store,cfg,'Stop this preference.');reopened.feedback({key:'next-step',expected_revision:1,action:'dismiss',sources:[s]});assert.equal(reopened.context('planning').length,0);assert.equal(reopened.get('next-step',1).status,'active');
});

test('authenticated owner group facts stay usable while group preference and outcome authority are denied',async t=>{
  const {cfg,store,learning,service}=await fixture(t);const groupCfg={...cfg,group:{chat_id:'-100',state:'active'}};const m={from:{id:123},chat:{id:-100,type:'group'},text:'Cedar has a blue header.'};const s='history:'+store.ownerHistory(groupCfg,m,m.text);
  assert.equal(learning.evidence(s).origin,'owner_group');assert.equal(learning.evidence(s).original_owner_statement,false);
  service.memory.save({key:'group-fact',category:'facts',title:'Cedar',content:m.text,certainty:'confirmed',sources:[s],expected_revision:0});assert.equal(service.memory.get('group-fact').certainty,'confirmed');
  assert.throws(()=>apply(learning,rule(s,{kind:'preference',target:'USER.md',status:'active'})),/owner evidence/);
});

test('pre-trial uncited evidence and receipts for an earlier trial revision cannot promote a new trial',async t=>{
  const {cfg,store,learning}=await fixture(t);later(store,cfg,'Initial request.');store.history(owner,'assistant','Earlier observation, not cited by trial.');apply(learning,rule('history:1'));
  const source=later(store,cfg,'A later observation.');const old=receipt(learning,source);
  assert.throws(()=>learning.recordOutcome({...old,evidence_ids:['history:2']},{kind:'deterministic_check'}),/later authorized evidence/);
  learning.recordOutcome(old,{kind:'deterministic_check'});apply(learning,rule(source,{expected_revision:1,status:'trial'}));
  const laterSource=later(store,cfg,'New-revision observation.');assert.throws(()=>learning.recordOutcome(old,{kind:'deterministic_check'}),/binding/);
  assert.throws(()=>apply(learning,rule(laterSource,{expected_revision:2,status:'active'})),/host outcome receipt/);assert.equal(learning.get('next-step').status,'trial');assert.equal(learning.outcomes('next-step').length,1);
});
