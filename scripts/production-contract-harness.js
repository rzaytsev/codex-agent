import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {featureModes} from './memory-quality-harness.js';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const get=(value,path)=>path.split('.').reduce((v,key)=>v?.[key],value);
export async function loadContracts() {
  const read=async file=>JSON.parse(await fs.readFile(new URL(`../evals/production-contract/${file}.json`,import.meta.url),'utf8'));
  return {scenarios:await read('scenarios'),expectations:await read('expectations')};
}
export function scoreContract(observation,expected,mode) {
  return expected.checks.map(check=>{
    const canonical=mode==='on'?'both':mode==='off'?'baseline':mode;
    const value=get(observation,check.pathsByMode?.[canonical]||check.path),wanted=check.byMode?.[canonical]??check.equals;
    const passed=value!==undefined&&(check.length!==undefined?Array.isArray(value)&&value.length===check.length:JSON.stringify(value)===JSON.stringify(wanted));
    return {id:check.id,kind:check.kind,passed};
  });
}
export async function runContracts({scenarios,expectations,adapter,modes=['baseline','memory-only','learning-only','both'],repeats=1,signal}) {
  if(!Array.isArray(scenarios)||!scenarios.length||!Array.isArray(expectations)||scenarios.length!==expectations.length||new Set(scenarios.map(s=>s.id)).size!==scenarios.length||new Set(expectations.map(s=>s.id)).size!==expectations.length||!Number.isInteger(repeats)||repeats<1||repeats>10||!Array.isArray(modes)||!modes.length||new Set(modes).size!==modes.length||modes.some(m=>!Object.hasOwn(featureModes,m)))throw Error('Invalid contracts');
  for(const s of scenarios){const e=expectations.find(e=>e.id===s.id);if(!e?.checks?.length||new Set(e.checks.map(c=>c.id)).size!==e.checks.length||e.checks.some(c=>!c.path||!['end-state','forbidden-action'].includes(c.kind)||!Object.hasOwn(c,'equals')&&!Object.hasOwn(c,'length')&&!c.byMode))throw Error('Invalid contract checks');}
  const sourceFiles=[...(await fs.readdir(new URL('../src/',import.meta.url))).filter(f=>f.endsWith('.js')).map(f=>'src/'+f),...(await fs.readdir(new URL('../templates/',import.meta.url))).filter(f=>f.endsWith('.md')).map(f=>'templates/'+f),'scripts/production-contract-adapter.js','scripts/production-contract-harness.js','scripts/production-contract.js','scripts/memory-quality-harness.js'];
  const sourceSha256=Object.fromEntries(await Promise.all(sourceFiles.sort().map(async file=>[file,createHash('sha256').update(await fs.readFile(new URL('../'+file,import.meta.url))).digest('hex')])));
  const manifest={scenariosSha256:hash(scenarios),expectationsSha256:hash(expectations),sourceSha256,model:'none',effort:'none',repeats,modes:modes.map(mode=>({mode,...featureModes[mode]})),node:process.version};
  const report={version:1,lane:'production-contract',qualityEvidence:false,manifest,cases:[]};
  for(let repeat=1;repeat<=repeats;repeat++)for(const s of scenarios)for(const mode of modes){signal?.throwIfAborted();const e=expectations.find(e=>e.id===s.id);const row={id:s.id,mode,repeat,pairId:hash([s.id,repeat,manifest.scenariosSha256,manifest.model,manifest.effort])};try {
    // Only operational inputs cross into adapter; scoring definitions stay here.
    const input={id:s.id,steps:s.steps.map(({op,id,text,origin,tool,args,change,key})=>({op,id,text,origin,tool,args,change,key}))};
    row.observation=await adapter.run(input,{...featureModes[mode],signal});row.metrics=scoreContract(row.observation,e,mode);row.status=row.metrics.every(m=>m.passed)?'passed':'failed';
  } catch {row.status='error';row.metrics=e.checks.map(c=>({id:c.id,kind:c.kind,passed:null}));}
  report.cases.push(row);}
  report.summary={passed:report.cases.filter(r=>r.status==='passed').length,failed:report.cases.filter(r=>r.status==='failed').length,errors:report.cases.filter(r=>r.status==='error').length};return report;
}
