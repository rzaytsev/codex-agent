import test from 'node:test';
import assert from 'node:assert/strict';
import {loadContracts,runContracts,scoreContract} from '../scripts/production-contract-harness.js';
import {createContractAdapter} from '../scripts/production-contract-adapter.js';
import {featureModes,runSuite} from '../scripts/memory-quality-harness.js';

test('real production service contracts run in four independent modes with paired exact manifests',async()=>{
  const suite=await loadContracts();const report=await runContracts({...suite,adapter:createContractAdapter(),repeats:2});
  assert.deepEqual(report.summary,{passed:40,failed:0,errors:0});assert.equal(report.qualityEvidence,false);
  assert.equal(report.manifest.model,'none');assert.match(report.manifest.expectationsSha256,/^[a-f0-9]{64}$/);
  for(const s of suite.scenarios)for(const repeat of [1,2]){const rows=report.cases.filter(r=>r.id===s.id&&r.repeat===repeat);assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>r.pairId)).size,1);}
  const promoted=report.cases.find(r=>r.id==='outcome-gated-trial-rollback'&&r.mode==='both');
  assert.equal(promoted.observation.results.unreceipted.status,'denied');assert.equal(promoted.observation.results.promote.applied,1);assert.equal(promoted.observation.results.rollback.record.status,'retired');
});
test('held-out final-state and forbidden-action checks fail meaningful BAD service responses',async()=>{
  const suite=await loadContracts();const adapter=createContractAdapter();const scenario=suite.scenarios.find(s=>s.id==='restart-correction-cas'),expected=suite.expectations.find(e=>e.id===scenario.id);
  const good=await adapter.run(scenario,featureModes.both);assert(scoreContract(good,expected,'both').every(m=>m.passed));
  const bad=structuredClone(good);bad.memory[0].content='Семь заметок в рассылке Лиственница.';bad.results.stale.conflict=false;
  assert.equal(scoreContract(bad,expected,'both').find(m=>m.id==='latest-correction').passed,false);assert.equal(scoreContract(bad,expected,'both').find(m=>m.id==='stale-conflict').passed,false);
  assert(scoreContract({},expected,'both').every(m=>!m.passed));
});
test('contract expectations are excluded from adapter input and errors remain unscored',async()=>{
  const suite=await loadContracts();const received=[];const report=await runContracts({...suite,adapter:{run:async input=>{received.push(input);throw Error('PRIVATE-RUNTIME-CANARY');}}});
  assert.equal(report.summary.errors,20);assert(report.cases.every(r=>r.metrics.every(m=>m.passed===null)));
  assert(!JSON.stringify(received).includes('byMode'));assert(!JSON.stringify(received).includes('forbidden-action'));assert(!JSON.stringify(report).includes('PRIVATE-RUNTIME-CANARY'));
});
test('quality adapter controls memory and learning independently and preserves on/off aliases',async()=>{
  const received=[];const s={id:'pair',stages:[{messages:[],maintenance:[],probes:[{id:'q',conversation:'fresh',fresh:true,prompt:'Later task.'}]}]};const e={id:'pair',checks:[{id:'answer',at:'q',target:'answer',all:['synthetic']}]};
  const report=await runSuite({scenarios:[s],expectations:[e],adapter:{name:'fake',runtime:{model:'synthetic-model',effort:'low'},run:async(input,options)=>{received.push(options);return {probes:[{id:'q',answer:'synthetic'}]};}}});
  assert.deepEqual(received.map(({memoryEnabled,learningEnabled})=>[memoryEnabled,learningEnabled]),[[false,false],[true,false],[false,true],[true,true]]);assert.equal(report.comparisons.length,3);assert.equal(new Set(report.cases.map(c=>c.pairId)).size,1);
  assert.deepEqual(featureModes.on,featureModes.both);assert.deepEqual(featureModes.off,featureModes.baseline);
});
