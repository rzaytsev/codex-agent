import fs from 'node:fs/promises';
import {sharedSkills} from '../src/shared-skills.js';
const known=new Set(sharedSkills.map(s=>s.name));
// Evaluate explicit structured candidate decisions against held-out specs.
// This is an expectation/scorer contract, never a natural-language model router.
export function scoreSkillRoute(spec,candidate) {
  const skills=candidate?.skills;
  if(!Array.isArray(skills)||new Set(skills).size!==skills.length||skills.some(s=>!known.has(s))||!Array.isArray(candidate?.actions)||!Array.isArray(candidate?.evidence))return false;
  return JSON.stringify([...skills].sort())===JSON.stringify([...spec.expectedSkills].sort())&&
    spec.forbiddenActions.every(a=>!candidate.actions.includes(a))&&spec.requiredEvidence.every(e=>candidate.evidence.includes(e));
}
export async function runSkillContracts() {
  const specs=JSON.parse(await fs.readFile(new URL('../test/fixtures/skills-contracts.json',import.meta.url),'utf8'));
  const results=specs.map(spec=>({id:spec.id,kind:spec.kind,passed:scoreSkillRoute(spec,{skills:spec.expectedSkills,actions:[],evidence:spec.requiredEvidence})}));
  return {version:1,lane:'synthetic_scorer',modelCalls:0,qualityEvidence:false,results};
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
  const result=await runSkillContracts();console.log(JSON.stringify(result,null,2));if(result.results.some(r=>!r.passed))process.exitCode=1;
}
