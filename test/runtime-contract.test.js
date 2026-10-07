import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {runtimeContract,digest,effectiveTools} from '../scripts/runtime-contract.js';
import {sharedSkills,skillDiscoveryStatus} from '../src/shared-skills.js';
import {scoreSkillRoute,runSkillContracts} from '../scripts/skills-contract.js';
import {actionRegistry} from '../src/action-registry.js';
test('declared installed pins, effective registry metadata, schemas and prompt templates match compatibility golden',async()=>{
  const actual=await runtimeContract(),golden=JSON.parse(await fs.readFile('test/fixtures/runtime-golden.json','utf8'));
  assert.deepEqual(actual.compatibility,golden);assert.equal(actual.liveAcceptance,false);assert.equal(actual.qualityEvidence,false);
  const before=digest(effectiveTools()),original=actionRegistry.get('history_read');
  try {actionRegistry.set('history_read',{...original,retry:'never'});assert.notEqual(digest(effectiveTools()),before);}finally{actionRegistry.set('history_read',original);}
});
test('exact eight owned skill sources, Compose read-only mounts and native discovery paths agree',async()=>{
  assert.equal(sharedSkills.length,8);assert.equal(sharedSkills.some(s=>s.name==='agent-messaging'),false);
  const compose=await fs.readFile('compose.yaml','utf8');const discovered=[];
  for(const skill of sharedSkills){const source=await fs.readFile(skill.source,'utf8');assert.match(source,new RegExp(`name: ${skill.name}(?:\\s|$)`));assert.ok(compose.includes(`./shared-skill/${skill.name}:/workspace/.agents/skills/${skill.name}:ro`));discovered.push({name:skill.name,enabled:true,path:'/workspace/'+skill.nativePath});}
  assert.equal((compose.match(/\.\/shared-skill\//g)||[]).length,8);
  assert.ok(skillDiscoveryStatus(discovered,'/workspace').every(s=>s.enabled));
  discovered[0].path='/foreign/SKILL.md';assert.equal(skillDiscoveryStatus(discovered,'/workspace')[0].enabled,false);
});
test('routing expectation harness rejects missing evidence, near misses, plan-only effects and unknown skills',async()=>{
  const specs=JSON.parse(await fs.readFile('test/fixtures/skills-contracts.json','utf8'));assert.equal(specs.length,24);
  const result=await runSkillContracts();assert.ok(result.results.every(r=>r.passed));assert.equal(result.qualityEvidence,false);
  for(const spec of specs){assert.equal(scoreSkillRoute(spec,{skills:['unknown'],actions:[],evidence:spec.requiredEvidence}),false);if(spec.kind==='near_miss')assert.equal(scoreSkillRoute(spec,{skills:[spec.id.split('-near')[0]],actions:[],evidence:[]}),false);if(spec.requiredEvidence.length)assert.equal(scoreSkillRoute(spec,{skills:spec.expectedSkills,actions:[],evidence:[]}),false);}
  const plan=specs.find(s=>s.id==='planning-quality');assert.equal(scoreSkillRoute(plan,{skills:['planning'],actions:['file_write'],evidence:plan.requiredEvidence}),false);
});
