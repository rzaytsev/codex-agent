// Opt-in subscription-backed synthetic research. No Telegram polling or sending.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';
import {Agent} from '../src/agent.js';

const index=process.argv.indexOf('--output');
if(index<0||!process.argv[index+1])throw new Error('Supply --output PRIVATE_DIRECTORY for the synthetic report and receipt');
  const output=path.resolve(process.argv[index+1]),workspace=await fs.mkdtemp(path.join(os.tmpdir(),'deep-research-smoke-'));
const cfg=config({...process.env,WORKSPACE_DIR:workspace,TELEGRAM_BOT_TOKEN:'',TELEGRAM_ALLOWED_USER_IDS:'123',SEED_DIR:'',PLUGINS_FILE:'',MAILBOX_URL:'',MAILBOX_TOKEN:'',MAILBOX_ID:'',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',BROWSER_ENABLED:'false',WORKSPACE_PYTHON_BASE:'',MAIN_TIMEOUT_SECONDS:'180',WORKER_TIMEOUT_SECONDS:'600'});
const store=new Store(path.join(workspace,'assistant.sqlite')),sent=[];
const service=new Service(cfg,store,{sendPart:async(_chat,payload)=>{sent.push(payload);return {message_id:sent.length};}},null);
const capability=(...args)=>service.capability(...args);capability.release=token=>service.releaseCapability(token);
service.agent=new Agent(cfg,store,capability,undefined,service.memory,service.learning);
if(process.argv.includes('--diagnostic')) {
  const run=service.agent.run.bind(service.agent);
  service.agent.run=async(...args)=>{const result=await run(...args);if(args[2]==='deep_research')await fs.writeFile(path.join(output,'synthetic-worker-result.json'),JSON.stringify(result),{mode:0o600});return result;};
}
let stage='setup';
try {
  await fs.mkdir(output,{recursive:true,mode:0o700});await service.init();await service.listen();
  const skill=path.join(workspace,'.agents/skills/deep-research');await fs.mkdir(skill,{recursive:true});
  const mountedSkill=path.join(process.env.WORKSPACE_DIR||'/workspace','.agents/skills/deep-research/SKILL.md');
  let skillSource=mountedSkill;try{await fs.access(skillSource);}catch{skillSource=path.resolve('shared-skill/deep-research/SKILL.md');}
  await fs.copyFile(skillSource,path.join(skill,'SKILL.md'));
  stage='natural_admission';console.log(JSON.stringify({stage}));
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),180000);
  try {
    const result=await service.agent.run('123','Deep research a small comparison of STORM and MindSearch for a Telegram research assistant. Keep this synthetic runtime test bounded: use only the original abstract pages https://aclanthology.org/2024.naacl-long.347/ and https://arxiv.org/abs/2407.20183 as two sources, label abstract-only access, save exact evidence passages, compare question decomposition and source grounding, and disclose that abstracts cannot prove implementation details or comparative performance. Record searches only if actually performed; reading the supplied pages directly is sufficient. Deliver a concise English PDF and Markdown report. Do not access personal files, credentials, connectors or send anything directly. Start deep research in the background.','main',[],controller.signal,undefined,undefined,false,{actorId:'123',settings:service.effectiveSettings('main')});
    await service.output('123',result);
  } finally {clearTimeout(timer);}
  const jobs=store.jobs('123');assert.equal(jobs.length,1);assert.equal(jobs[0].profile,'deep_research');
  stage='collection_review_export';console.log(JSON.stringify({stage}));
  service.workers(1,false);await Promise.all([...service.workerRuns.values()]);
  const job=store.jobs('123',jobs[0].id)[0];assert.equal(job.state,'completed');
  const dossier=service.research.read({id:job.id});assert.equal(dossier.sources.filter(s=>s.access!=='unavailable').length,2);assert.ok(dossier.claims.length>=2);
  assert.ok(dossier.report.review.decisions.length>=2);assert.equal(dossier.report.files.length,4);
  const attempts=store.db.prepare('SELECT payload FROM attempt_observations').all().map(r=>JSON.parse(r.payload));
  assert.ok(attempts.some(a=>a.profile==='deep_research'));assert.ok(attempts.some(a=>a.profile==='research'&&a.settings.toolScope==='read'));
  stage='intercepted_delivery';await service.deliver();
  assert.equal(sent.filter(p=>p.type==='file').length,2);
  assert.ok(store.db.prepare('SELECT state FROM outbox').all().every(r=>r.state==='sent'));
  for(const file of dossier.report.files)await fs.copyFile(file,path.join(output,path.basename(file)));
  const receipt={naturalDeepAdmission:true,sources:dossier.sources.length,claims:dossier.claims.length,independentReview:true,pdfExport:true,interceptedDocuments:2,telegramSent:false,ownerAcceptance:false};
  await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(receipt));
} catch {
  const job=store.jobs('123')[0],dossier=job&&service.research.read({id:job.id});
  const attempts=store.db.prepare('SELECT payload FROM attempt_observations').all().map(r=>JSON.parse(r.payload));
  console.error(JSON.stringify({researchSmokeFailed:true,stage,jobState:job?.state,sources:dossier?.sources.length,claims:dossier?.claims.length,draft:Boolean(dossier?.report),review:Boolean(dossier?.report?.review),attempts:attempts.map(a=>({profile:a.profile,reason:a.reason,tools:a.toolCount})),privateDetailsSuppressed:true}));process.exitCode=1;
}
finally {await new Promise(resolve=>service.server?service.server.close(resolve):resolve());for(const token of service.capabilities.keys())service.releaseCapability(token);store.db.close();await fs.rm(workspace,{recursive:true,force:true});}
