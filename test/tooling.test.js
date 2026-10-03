import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Telegram } from '../src/telegram.js';
import { pythonEnvironment } from '../src/python.js';
const exec=promisify(execFile);
async function fixture(t,env={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-tooling-'));
  const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',WORKSPACE_DIR:dir,PROACTIVE_ENABLED:'false',...env});
  const store=new Store(path.join(dir,'db'));
  const service=new Service(cfg,store,{}, {run:async()=>({text:'Done',voice:false,files:[]})});await service.init();
  t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});return {dir,cfg,store,service};
}
test('daily cleanup persists once per instance, respects cancellation/configuration, and avoids overlap',async t=>{
  const {service,cfg,store}=await fixture(t,{TELEGRAM_ALLOWED_USER_IDS:'123'});
  await service.init();
  let rows=store.db.prepare("SELECT * FROM schedules WHERE kind='cleanup'").all();assert.equal(rows.length,1);assert.equal(rows[0].user,'123');assert.equal(rows[0].cron,'0 3 * * *');
  const due=rows[0].due;service.schedules(due+1);service.schedules(due+86400001);
  let jobs=store.jobs('123');assert.equal(jobs.length,1);assert.match(jobs[0].state,/queued/);
  const prompt=store.db.prepare('SELECT prompt FROM jobs WHERE id=?').get(jobs[0].id).prompt;
  assert.match(prompt,/uv cache prune/);assert.match(prompt,/Always preserve state\/python/);
  await service.tool({user:'123'},'cancel_schedule',{id:rows[0].id});await service.init();assert.equal(store.db.prepare('SELECT enabled FROM schedules').get().enabled,0);
  cfg.cleanupCron='0 3 * * 0';await service.init();assert.equal(store.db.prepare('SELECT enabled FROM schedules').get().enabled,1);
  cfg.cleanupEnabled=false;await service.init();assert.equal(store.db.prepare('SELECT enabled FROM schedules').get().enabled,0);
  cfg.cleanupEnabled=true;await service.init();assert.equal(store.db.prepare('SELECT enabled FROM schedules').get().enabled,1);
});
test('cleanup starts only when idle, never overlaps workers, and yields to a user message',async t=>{
  const {service,store}=await fixture(t);const id=store.job('123',service.cleanupPrompt);
  let finish;service.agent.run=()=>new Promise(resolve=>{finish=resolve;});
  service.mainBusy=true;service.workers();assert.equal(store.jobs('123')[0].state,'queued');service.mainBusy=false;
  service.workers();store.job('123','ordinary work');service.workers();assert.equal(store.db.prepare("SELECT count(*) AS n FROM jobs WHERE state='running'").get().n,1);
  await service.conversation();assert.equal(service.controllers.get(id).signal.aborted,false);
  store.ingest(1,'123',{text:'hello'});await service.conversation();assert.equal(service.controllers.get(id).signal.aborted,true);
  for(let i=0;i<50&&!finish;i++)await new Promise(r=>setTimeout(r,10));
  finish({text:'',voice:false,files:[]});
  for(let i=0;i<50&&service.controllers.has(id);i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(id).state,'interrupted');assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
});
test('worker artifacts are uploaded without waiting for another model turn, with MIME types and exact bytes',async t=>{
  const {dir,service,store}=await fixture(t);const expected={'.png':'image/png','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
  const files=[];for(const extension of Object.keys(expected)){const file=path.join(dir,'outputs','artifact'+extension);await fs.writeFile(file,'bytes'+extension);files.push(file);}
  service.agent.run=async()=>({text:'Artifacts ready',voice:false,files:[...files,files[0]]});
  const id=store.job('123','create artifacts');store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);await service.runJob(store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id),new AbortController());
  const rows=store.db.prepare('SELECT * FROM outbox').all();assert.equal(rows.length,files.length);
  const telegram=new Telegram('unused');const uploads=[];telegram.call=async(method,data)=>{uploads.push({method,data});return true;};
  for(const row of rows)await telegram.sendPart(row.user,JSON.parse(row.payload));
  for(let i=0;i<files.length;i++){
    const {method,data}=uploads[i];const photo=path.extname(files[i])==='.png';assert.equal(method,photo?'sendPhoto':'sendDocument');assert.equal(data.get('chat_id'),'123');
    const file=data.get(photo?'photo':'document');assert.equal(file.name,path.basename(files[i]));assert.equal(file.type,expected[path.extname(files[i])]);assert.equal(await file.text(),'bytes'+path.extname(files[i]));
  }
  const event=JSON.parse(store.db.prepare('SELECT payload FROM inputs WHERE id<0').get().payload);assert.match(event.text,/already been queued/);assert.match(event.text,/"files":\[\]/);
});
test('existing custom AGENTS.md preserves content and gains tool and shared-skill guidance exactly once',async t=>{
  const {dir,service}=await fixture(t);await fs.writeFile(path.join(dir,'AGENTS.md'),'Custom personality instructions\n');await service.init();await service.init();
  const text=await fs.readFile(path.join(dir,'AGENTS.md'),'utf8');assert.match(text,/Custom personality instructions/);assert.equal(text.split('## Python, documents, and artifacts').length,2);assert.match(text,/\.agents\/skills\/project-manager\/SKILL.md/);
  assert.equal(text.split('## Shared assistant workflows').length,2);
  assert.equal(text.split('## Telegram account reading').length,2);
  assert.match(text,/\.agents\/skills\/telegram-read\/SKILL.md/);
  assert.equal(text.split('## Durable memory v2').length,2);
});
test('uv creates a writable environment, installs an offline wheel, and preserves it on restart',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-python-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const base=(await exec('python3',['-c','import sys; print(sys.executable)'])).stdout.trim();
  const env=await pythonEnvironment(dir,base);const wheel=path.join(dir,'assistant_probe-1.0-py3-none-any.whl');
  await exec(base,['-c',`import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('assistant_probe.py','VALUE = 42\\n')\n z.writestr('assistant_probe-1.0.dist-info/METADATA','Metadata-Version: 2.1\\nName: assistant-probe\\nVersion: 1.0\\n')\n z.writestr('assistant_probe-1.0.dist-info/WHEEL','Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')\n z.writestr('assistant_probe-1.0.dist-info/RECORD','')`,wheel]);
  await exec('uv',['pip','install','--offline','--python',path.join(env.VIRTUAL_ENV,'bin','python'),wheel],{env:{...process.env,...env,UV_PYTHON_DOWNLOADS:'never'}});
  const restarted=await pythonEnvironment(dir,base);assert.equal(restarted.VIRTUAL_ENV,env.VIRTUAL_ENV);
  const result=await exec('python',['-c','import assistant_probe; print(assistant_probe.VALUE)'],{env:{...process.env,...restarted}});assert.equal(result.stdout.trim(),'42');
});
