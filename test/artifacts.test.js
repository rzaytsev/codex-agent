import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Telegram, TelegramError } from '../src/telegram.js';
import { Service } from '../src/service.js';
async function setup(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'artifacts-'));await fs.mkdir(path.join(dir,'state'));
  const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',WORKSPACE_DIR:dir,PROACTIVE_ENABLED:'false'});
  const store=new Store(path.join(dir,'state','assistant.sqlite')),sent=[];
  const telegram={sendPart:async(_,payload)=>sent.push(payload)};
  const service=new Service(cfg,store,telegram,{});await service.init();
  const f={dir,cfg,store,sent,telegram,service};
  t.after(async()=>{f.store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  const file=path.join(dir,'outputs','report.txt');await fs.writeFile(file,'original');f.file=file;return f;
}
test('queued snapshots preserve bytes after source changes and deletion; restart delivers pending',async t=>{
  const f=await setup(t);await f.service.output('123',{text:'',files:[f.file]});
  const payload=JSON.parse(f.store.db.prepare('SELECT payload FROM outbox').get().payload);
  assert.match(payload.artifactId,/^[a-f0-9-]{36}$/);
  await fs.writeFile(f.file,'changed');await fs.unlink(f.file);
  f.store.db.close();f.store=new Store(path.join(f.dir,'state','assistant.sqlite'));
  const restarted=new Service(f.cfg,f.store,f.telegram,{});f.store.recover();await restarted.deliver();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].bytes.toString(),'original');assert.equal(f.sent[0].filename,'report.txt');
});
test('tampered snapshot fails before network send and is never uncertain',async t=>{
  const f=await setup(t);await f.service.output('123',{text:'',files:[f.file]});
  const payload=JSON.parse(f.store.db.prepare('SELECT payload FROM outbox').get().payload);await fs.writeFile(payload.path,'tampered');
  await f.service.deliver();assert.equal(f.sent.length,0);assert.equal(f.store.db.prepare('SELECT state FROM outbox').get().state,'failed');
});
test('symlinks and sensitive state, credentials and profiles cannot be ordinary exports',async t=>{
  const f=await setup(t);await fs.symlink(f.file,path.join(f.dir,'outputs','link.txt'));
  for(const name of ['outputs/link.txt','state/assistant.sqlite','USER.md','outputs/auth.json','outputs/.env','private/key.pem']) {
    if(name==='outputs/auth.json'||name==='outputs/.env')await fs.writeFile(path.join(f.dir,name),'synthetic');
    await f.service.output('123',{text:'',files:[name]});
  }
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM outbox WHERE json_extract(payload,'$.artifactId') IS NOT NULL").get().n,0);
  assert(f.store.db.prepare('SELECT payload FROM outbox').all().every(r=>!JSON.parse(r.payload).path));
});
test('failed final transaction publishes no subset and retains orphan inventory',async t=>{
  const f=await setup(t);const enqueue=f.store.enqueue.bind(f.store);let count=0;f.store.enqueue=(...args)=>{if(++count===2)throw new Error('Synthetic commit failure');return enqueue(...args);};
  await assert.rejects(f.service.output('123',{text:'Reply',files:[f.file]}),/Synthetic commit failure/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get().n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM artifacts').get().n,1);
});
test('owner and conversation metadata mismatch is rejected before send',async t=>{
  for(const column of ['owner','conversation_id']) {
    const f=await setup(t);await f.service.output('123',{text:'',files:[f.file]});
    f.store.db.prepare(`UPDATE artifacts SET ${column}=?`).run('mismatch');await f.service.deliver();
    assert.equal(f.sent.length,0);assert.equal(f.store.db.prepare('SELECT state FROM outbox').get().state,'failed');
  }
});

test('source swapped to symlink between validation and descriptor open is rejected',async t=>{
  const f=await setup(t),original=fs.open;let swapped=false;
  const real=await fs.realpath(f.file);
  t.mock.method(fs,'open',async function(file,...args){
    if(file===real&&!swapped){swapped=true;await fs.rename(f.file,f.file+'.saved');await fs.symlink(f.file+'.saved',f.file);}
    return original.call(this,file,...args);
  });
  await f.service.output('123',{text:'',files:[f.file]});assert(swapped);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM artifacts').get().n,0);
  assert(!JSON.parse(f.store.db.prepare('SELECT payload FROM outbox').get().payload).artifactId);
});
test('hardlink aliases of state and profile files are rejected',async t=>{
  const f=await setup(t);
  for(const [source,name] of [[f.store.file,'db-copy.txt'],[path.join(f.dir,'USER.md'),'profile-copy.txt']]) {
    const dest=path.join(f.dir,'outputs',name);await fs.link(source,dest);
    await f.service.output('123',{text:'',files:[dest]});
  }
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM artifacts').get().n,0);
});
test('actual final COMMIT failure rolls back all output while keeping prepared inventory',async t=>{
  const f=await setup(t),exec=f.store.db.exec.bind(f.store.db);let fail=true;
  t.mock.method(f.store.db,'exec',sql=>{if(sql==='COMMIT'&&fail){fail=false;throw new Error('Synthetic COMMIT failure');}return exec(sql);});
  await assert.rejects(f.service.output('123',{text:'Reply',files:[f.file]}),/Synthetic COMMIT failure/);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get().n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM history').get().n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM artifacts').get().n,1);
});
test('worker result keeps original session after /new rotates main session',async t=>{
  const f=await setup(t),id=f.store.job('123','Produce a report');
  f.store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
  const job=f.store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
  f.service.agent={run:async()=>{f.store.rotateSession('123');return {text:'Ready',files:[f.file]};}};
  await f.service.runJob(job,new AbortController());await f.service.deliver();
  assert.equal(f.sent.find(p=>p.artifactId).bytes.toString(),'original');
  const artifact=f.store.db.prepare('SELECT * FROM artifacts').get();assert.equal(artifact.session_id,job.session_id);assert.notEqual(artifact.session_id,f.store.get('main-session'));
});
test('verified buffered bytes, original filename and MIME survive photo fallback without reopening',async t=>{
  const f=await setup(t),photo=path.join(f.dir,'outputs','preview.png');await fs.writeFile(photo,'original photo');
  await f.service.output('123',{text:'',files:[photo]});const p=JSON.parse(f.store.db.prepare('SELECT payload FROM outbox').get().payload);
  const uploads=[],telegram=new Telegram('unused');telegram.action=async()=>{};
  telegram.call=async(method,data)=>{uploads.push({method,data});if(method==='sendPhoto'){await fs.writeFile(p.path,'mutated after verification');throw new TelegramError(400);}return true;};
  f.service.telegram=telegram;await f.service.deliver();assert.equal(uploads.length,2);
  for(const {method,data} of uploads){const file=data.get(method==='sendPhoto'?'photo':'document');assert.equal(file.name,'preview.png');assert.equal(file.type,'image/png');assert.equal(await file.text(),'original photo');}
  assert.equal((await fs.stat(path.dirname(p.path))).mode&0o777,0o700);assert.equal((await fs.stat(p.path)).mode&0o777,0o600);
});
test('path-only legacy rows are retained behind operator gate without invented immutability',async t=>{
  const f=await setup(t);f.store.enqueue('123',{type:'file',path:f.file});f.store.db.prepare("UPDATE outbox SET state='uncertain'").run();f.store.db.close();
  f.store=new Store(path.join(f.dir,'state','assistant.sqlite'));const s=new Service(f.cfg,f.store,f.telegram,{});await s.deliver();
  assert.equal(f.sent.length,0);assert.equal(f.store.db.prepare('SELECT state,legacy_state FROM outbox').get().legacy_state,'uncertain');assert.equal(f.store.db.prepare('SELECT state FROM outbox').get().state,'legacy');assert.equal(f.store.db.prepare('SELECT count(*) n FROM artifacts').get().n,0);
});

test('restart retains uncertain snapshot references without replaying or legacy downgrade',async t=>{
  const f=await setup(t);await f.service.output('123',{text:'',files:[f.file]});
  const before=f.store.db.prepare('SELECT artifact_id,payload FROM outbox').get();f.store.db.prepare("UPDATE outbox SET state='sending'").run();f.store.db.close();
  f.store=new Store(path.join(f.dir,'state','assistant.sqlite'));const s=new Service(f.cfg,f.store,f.telegram,{});f.store.recover();await s.deliver();
  const after=f.store.db.prepare('SELECT * FROM outbox').get();assert.equal(after.state,'uncertain');assert.equal(after.artifact_id,before.artifact_id);assert.equal(after.payload,before.payload);assert.equal(f.sent.length,0);
  assert.equal(await fs.readFile(JSON.parse(after.payload).path,'utf8'),'original');
});
