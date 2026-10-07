import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {sharedSkills} from '../src/shared-skills.js';
import {reviewedActionBundle} from '../src/action-registry.js';
import {responseSchema} from '../src/agent.js';
import {memorySchema} from '../src/memory.js';
import {learningSchema,validationSchema} from '../src/learning.js';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const digest=v=>crypto.createHash('sha256').update(typeof v==='string'?v:JSON.stringify(canonical(v))).digest('hex');
export function effectiveTools() {
  return ['main','worker','curator'].flatMap(role=>['conversation','read'].flatMap(toolScope=>[false,true].map(group=>({role,toolScope,group,actions:reviewedActionBundle({worker:role==='worker',memoryReview:role==='curator',toolScope,group})}))));
}
export async function runtimeContract() {
  const pkg=JSON.parse(await fs.readFile('package.json','utf8'));
  const installed={};for(const name of ['@openai/codex-sdk','@openai/codex','@playwright/mcp']) {
    installed[name]=JSON.parse(await fs.readFile(`node_modules/${name}/package.json`,'utf8')).version;
    if(installed[name]!==pkg.dependencies[name])throw new Error('Installed runtime contract pin mismatch');
  }
  const sources=['src/agent.js','src/supervised-exec.js','src/owned-process.js','src/action-registry.js','src/restricted-read.js','src/restricted-config.js','src/owner-evidence.js','src/store.js','src/memory.js','src/learning.js','src/outcomes.js','src/shared-skills.js','scripts/runtime-contract.js','scripts/skills-contract.js','scripts/shared-skills-smoke.js','test/runtime-contract.test.js','test/context-contract.test.js','test/fixtures/skills-contracts.json','test/action-policy.test.js','test/task-outcomes.test.js','test/restricted-read.test.js','test/observations.test.js','package.json','package-lock.json','Dockerfile','compose.yaml',...sharedSkills.map(s=>s.source)];
  const templates=(await fs.readdir('templates')).filter(n=>n.endsWith('.md')).sort();
  sources.push(...templates.map(n=>`templates/${n}`));
  const sourceHashes={};for(const source of sources)sourceHashes[source]=digest(await fs.readFile(source,'utf8'));
  // Source definitions include actual schemas, roles, scopes, side-effect category,
  // retry, timeout and DM metadata. Never hash or serialize SDK options/capabilities.
  const compatibility={version:1,dependencies:pkg.dependencies,installed,imageDeclarations:(await fs.readFile('Dockerfile','utf8')).split('\n').filter(s=>s.startsWith('FROM ')||s.startsWith('COPY --from=')),promptAssemblyHash:sourceHashes['src/agent.js'],schemaHash:digest({responseSchema,memorySchema,learningSchema,validationSchema}),toolsHash:digest(effectiveTools()),promptTemplatesHash:digest(Object.fromEntries(templates.map(n=>[n,sourceHashes[`templates/${n}`]]))),sdkParserHash:digest(await fs.readFile('node_modules/@openai/codex-sdk/dist/index.js','utf8')),supervisorHash:sourceHashes['src/supervised-exec.js'],skills:sharedSkills};
  return {compatibility,runtimeHash:digest(compatibility),sourceHashes,modelCalls:0,qualityEvidence:false,liveAcceptance:false,targetImageAcceptance:false};
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
  const result=await runtimeContract();
  if(process.argv.includes('--write-golden'))await fs.writeFile('test/fixtures/runtime-golden.json',JSON.stringify(result.compatibility,null,2)+'\n');
  else {
    const golden=JSON.parse(await fs.readFile('test/fixtures/runtime-golden.json','utf8'));
    if(digest(golden)!==digest(result.compatibility))throw new Error('Runtime compatibility golden mismatch; review pins/contracts and target image gate before refresh');
  }
  const index=process.argv.indexOf('--output');if(index>=0)await fs.writeFile(process.argv[index+1],JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({runtimeHash:result.runtimeHash,toolsHash:result.compatibility.toolsHash,sources:Object.keys(result.sourceHashes).length,modelCalls:0,liveAcceptance:false,targetImageAcceptance:false}));
}
