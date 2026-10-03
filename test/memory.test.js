import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Agent } from '../src/agent.js';
import { Memory, MemoryConflict } from '../src/memory.js';
async function fixture(t,env={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-memory-'));
  const cfg=config({WORKSPACE_DIR:dir,TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',BROWSER_ENABLED:'false',...env});
  const store=new Store(path.join(dir,'db'));
  const agent={run:async()=>({summary:'',changes:[]})};const service=new Service(cfg,store,{},agent);await service.init();
  t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,cfg,store,service,memory:service.memory};
}
const record=(key,content,source,extra={})=>({key,category:'facts',title:key,content,certainty:'confirmed',sources:[source],expected_revision:0,status:'active',...extra});
const update=(id=1)=>({update_id:id,message:{message_id:id,from:{id:123},chat:{id:123,type:'private'},text:'hello'}});
test('configuration accepts one owner or empty setup and rejects multiple owners',()=>{
  assert.equal(config({TELEGRAM_ALLOWED_USER_IDS:'123'}).owner,'123');
  assert.equal(config({TELEGRAM_ALLOWED_USER_IDS:''}).owner,undefined);
  assert.throws(()=>config({TELEGRAM_ALLOWED_USER_IDS:'123,456'}),/one Telegram owner/);
});
function memoryJob(store,user,period,target) {
  const id=store.job(user,`[MEMORY] ${period}`,'research');store.set(`memory-job:${id}`,JSON.stringify({period,target}));store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
  return store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
}
test('corrections preserve historical revisions, exclude old current facts and reject stale writes',async t=>{
  const {store,memory,dir,service}=await fixture(t);store.history('123','user','The project codename is cobalt.');
  memory.save(record('project-name','The codename is cobalt.','history:1',{category:'projects'}));
  store.history('123','user','Correction: the codename is amber.');
  memory.save(record('project-name','The codename is amber.','history:2',{category:'projects',expected_revision:1}));
  assert.throws(()=>memory.save(record('project-name','stale cobalt','history:1',{category:'projects',expected_revision:1})),MemoryConflict);
  assert.equal(memory.get('project-name').revision,2);assert.match(memory.get('project-name',1).content,/cobalt/);
  assert.equal(memory.search('cobalt').entries.length,0);assert.equal(memory.search('amber').entries.length,1);
  assert.match(await fs.readFile(path.join(dir,'memory/projects/project-name.md'),'utf8'),/Revision: 2/);
  await assert.rejects(service.tool({user:'456'},'memory_read',{key:'project-name'}));
});
test('retrieval handles Russian, query operators as data, unknowns, instance isolation and context budgets',async t=>{
  const {store,memory}=await fixture(t);store.history('123','user','Тема: вегетарианская еда');store.history('456','user','private orchids');
  memory.save(record('food','Предпочтение: вегетарианская еда.','history:1'));
  const other=await fixture(t,{TELEGRAM_ALLOWED_USER_IDS:'456'});other.store.history('456','user','private orchids');other.memory.save(record('private','private orchids','history:1'));
  assert.equal(memory.search('ВЕГЕТАРИАНСКАЯ').entries.length,1);
  assert.equal(memory.search('orchids').entries.length,0);
  assert.equal(memory.search('unobserved').entries.length,0);
  assert.doesNotThrow(()=>memory.search('" OR * NOT (cafe)'));
  for(let i=0;i<10;i++)memory.save(record('note-'+i,'cobalt '+('long evidence '.repeat(350)),'history:1'));
  assert(JSON.stringify(memory.context('cobalt')).length<7000);
  assert(memory.context('cobalt').every(x=>x.truncated));
  assert.throws(()=>memory.search('',{after:-1}));
});
test('memory provenance rejects cross-user IDs, secret URLs, arbitrary paths and obvious credentials',async t=>{
  const {store,memory,dir}=await fixture(t);store.history('456','user','private');
  assert.throws(()=>memory.save(record('bad','fact','history:1')));
  assert.throws(()=>memory.save(record('bad','fact','https://example.com/?token=private')));
  assert.throws(()=>memory.save(record('../bad','fact','https://example.com/')));
  assert.throws(()=>memory.save(record('bad','password=verylongcredential123456','https://example.com/')));
  await fs.writeFile(path.join(dir,'state','credential'),'private');await fs.symlink('/etc/hosts',path.join(dir,'outputs','outside'));
  assert.throws(()=>memory.save(record('bad','fact','state/credential')));
  assert.throws(()=>memory.save(record('bad','fact','outputs/outside')));
  assert.equal(memory.search().entries.length,0);
});
test('archive preserves evidence; explicit forget purges the selected record and blocks replay from its history source',async t=>{
  const {store,memory,dir}=await fixture(t);store.history('123','user','cobalt test value');
  memory.save(record('codename','cobalt test value','history:1'));
  const seq=memory.get('codename').seq;
  memory.save(record('codename','cobalt test value','history:1',{expected_revision:1,status:'archived'}));
  assert.equal(memory.search('cobalt').entries.length,0);
  assert.match(await fs.readFile(path.join(dir,'memory/archive/facts/codename.md'),'utf8'),/cobalt/);
  assert((await memory.forget('codename')).markdown_synced);
  assert.equal(memory.get('codename',1),null);assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_versions').get().n,0);
  await assert.rejects(fs.access(path.join(dir,'memory/archive/facts/codename.md')));
  assert.equal(store.search('123')[0].text,'cobalt test value');
  assert.equal(memory.batch('daily',1).records.length,0);
  assert.throws(()=>memory.save(record('codename','cobalt','history:1')));
  memory.save(record('new-note','new topic','https://example.com/'));
  assert(memory.get('new-note').seq>seq);
  memory.save(record('codename','explicitly remembered again','https://example.com/'),{restore:true});
  assert.equal(memory.get('codename').revision,1);
});
test('unsafe Markdown export does not corrupt SQLite and can be repaired without touching a symlink target',async t=>{
  const {memory,store,service,dir}=await fixture(t);const sink=path.join(dir,'sink');await fs.mkdir(sink);await fs.symlink(sink,path.join(dir,'memory','facts'));
  const result=memory.save(record('safe','verified value','https://example.com/'));assert.equal(result.markdown_synced,false);
  assert.equal(memory.get('safe').content,'verified value');assert.equal((await fs.readdir(sink)).length,0);
  await fs.unlink(path.join(dir,'memory','facts'));await service.init();
  assert.equal(store.get('memory-export-dirty'),'0');assert.match(await fs.readFile(path.join(dir,'memory/facts/safe.md'),'utf8'),/verified value/);
});
test('history pagination covers more than the latest 100 messages and retains source IDs and chronological bounds',async t=>{
  const {store}=await fixture(t);for(let i=0;i<123;i++)store.history('123','user','record '+i);store.history('456','user','private');
  const found=[];let after=0,more=true;
  while(more){const page=store.historyPage('123',{after});found.push(...page.records);after=page.next_cursor;more=page.has_more;}
  assert.equal(found.length,123);assert.deepEqual(found.map(x=>x.id),Array.from({length:123},(_,i)=>i+1));
  assert.equal(store.historyPage('123',{until:0}).records.length,0);assert.throws(()=>store.historyPage('123',{limit:0}));
});
test('failed consolidation rolls back all changes and checkpoint; successful retry applies the full batch once',async t=>{
  const {store,memory}=await fixture(t);store.history('123','user','Useful confirmed detail');
  const batch=memory.batch('daily',1),first=record('detail','Useful confirmed detail','history:1');
  assert.throws(()=>memory.consolidate('daily',batch,{summary:'derived summary',changes:[first,record('bad','invented','history:999')]},'test'));
  assert.throws(()=>memory.consolidate('daily',batch,{summary:'',changes:[first,record('Invalid.Key','detail','history:1')]},'test'));
  assert.equal(memory.get('detail'),null);assert.equal(store.get('memory-cursor:123:daily'),undefined);assert.equal(store.db.prepare('SELECT count(*) AS n FROM memory_versions').get().n,0);
  memory.consolidate('daily',batch,{summary:'derived summary',changes:[first]},'test');
  assert.equal(store.get('memory-cursor:123:daily'),'1');assert.equal(memory.get('detail').revision,1);
  assert.equal(memory.search('',{category:'episodes'}).entries[0].certainty,'tentative');
  assert.throws(()=>memory.consolidate('daily',batch,{summary:'',changes:[]},'test'));
});
test('memory schedules are idempotent, timezone-aware, independent of proactivity and preserve cancellation',async t=>{
  const {store,service,cfg}=await fixture(t,{TIMEZONE:'Europe/Madrid'});assert.equal(store.db.prepare("SELECT count(*) AS n FROM schedules WHERE kind!='learning'").get().n,0);
  service.ingest(update());service.ingest(update());await service.init();
  let rows=store.db.prepare("SELECT * FROM schedules WHERE kind='memory'").all();assert.equal(rows.length,2);
  assert.deepEqual(rows.map(x=>x.cron).sort(),['15 3 * * *','45 3 * * 0']);assert(rows.every(x=>x.timezone==='Europe/Madrid'));
  await service.tool({user:'123'},'cancel_schedule',{id:rows[0].id});await service.init();assert.equal(store.db.prepare('SELECT enabled FROM schedules WHERE id=?').get(rows[0].id).enabled,0);
  cfg.memoryEnabled=false;await service.init();assert.equal(store.db.prepare("SELECT count(*) AS n FROM schedules WHERE kind='memory' AND enabled=1").get().n,0);
  cfg.memoryEnabled=true;await service.init();assert.equal(store.db.prepare("SELECT count(*) AS n FROM schedules WHERE kind='memory' AND enabled=1").get().n,2);
  assert.throws(()=>config({MEMORY_MAX_BATCHES:'0'}));
});
test('daily backlog uses bounded batches, advances only through inspected records, stays silent and completes next run',async t=>{
  const {store,service,memory}=await fixture(t,{MEMORY_MAX_BATCHES:'1'});for(let i=0;i<61;i++)store.history('123','user','observation '+i);
  let calls=0;service.agent.run=async(u,p,profile,images,signal,save,resume,review)=>{calls++;assert(review);assert.match(p,/Source data/);return {summary:'',changes:[]};};
  const first=memoryJob(store,'123','daily',memory.target('daily'));await service.runJob(first,new AbortController());
  let outcome=JSON.parse(store.db.prepare('SELECT result FROM jobs WHERE id=?').get(first.id).result);assert.equal(outcome.cursor,50);assert(outcome.backlog);assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
  const second=memoryJob(store,'123','daily',memory.target('daily'));await service.runJob(second,new AbortController());
  outcome=JSON.parse(store.db.prepare('SELECT result FROM jobs WHERE id=?').get(second.id).result);assert.equal(outcome.cursor,61);assert.equal(outcome.backlog,false);assert.equal(calls,2);
});
test('oversized evidence is explicitly excerpted within the batch budget and remains fully retrievable',async t=>{
  const {store,memory}=await fixture(t);const text='\n'.repeat(100000);store.history('123','user',text);store.history('123','user','next record');
  const batch=memory.batch('daily',2);assert(batch.truncated>0);assert(batch.records[0].truncated);assert(JSON.stringify(batch.records).length<=60002);
  assert.equal(store.historyPage('123',{limit:1}).records[0].text.length,text.length);
});
test('service validation failure leaves memory and checkpoint intact; new evidence after the snapshot stays for another run',async t=>{
  const {store,service,memory}=await fixture(t);store.history('123','user','first fact');
  service.agent.run=async()=>({summary:'',changes:[record('bad','invented','history:999')]});
  const failed=memoryJob(store,'123','daily',1);await service.runJob(failed,new AbortController());
  assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(failed.id).state,'failed');assert.equal(store.get('memory-cursor:123:daily'),undefined);assert.equal(memory.search().entries.length,0);
  service.agent.run=async()=>{store.history('123','user','late evidence');return {summary:'',changes:[record('first','first fact','history:1')]};};
  const retry=memoryJob(store,'123','daily',1);await service.runJob(retry,new AbortController());
  assert.equal(store.get('memory-cursor:123:daily'),'1');assert.equal(memory.batch('daily',2).records[0].text,'late evidence');
});
test('consolidation scheduling deduplicates each period without dropping a weekly run queued behind daily',async t=>{
  const {service,store,memory}=await fixture(t);service.ingest(update());store.history('123','user','remember this');memory.save(record('seed','remember this','history:1'));
  store.db.prepare("UPDATE schedules SET due=0 WHERE kind='memory'").run();service.schedules();
  assert.equal(store.jobs('123').length,2);
  store.db.prepare("UPDATE schedules SET due=0 WHERE kind='memory'").run();service.schedules();assert.equal(store.jobs('123').length,2);
});
test('memory maintenance yields to user input and restart recovery never sends a spurious completion or advances a checkpoint',async t=>{
  const {service,store}=await fixture(t);store.history('123','user','observation');const job=memoryJob(store,'123','daily',1);
  const ctrl=new AbortController();service.controllers.set(job.id,ctrl);store.ingest(1,'123',{text:'urgent'});await service.conversation();assert(ctrl.signal.aborted);
  store.recover();assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(job.id).state,'interrupted');assert.equal(store.get('memory-cursor:123:daily'),undefined);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,0);
});
test('workers may record sourced lessons but cannot forget or restore; review capabilities are read-only',async t=>{
  const {service,store}=await fixture(t);store.history('123','user','verified');
  const saved=await service.tool({user:'123',worker:true},'memory_save',record('lesson','verified','history:1'));assert(saved.saved);
  const conflict=await service.tool({user:'123',worker:true},'memory_save',record('lesson','stale','history:1'));assert(conflict.conflict);assert.equal(conflict.current.revision,1);
  await assert.rejects(service.tool({user:'123',worker:true},'memory_forget',{key:'lesson'}));
  await assert.rejects(service.tool({user:'123',worker:true},'memory_save',{...record('lesson','restored','history:1'),restore:true}));
  await assert.rejects(service.tool({user:'123',worker:true,memoryReview:true},'memory_save',record('other','verified','history:1')));
});
test('weekly input ignores its own summaries and retains tentative certainty when the evidence is tentative',async t=>{
  const {store,memory}=await fixture(t);store.history('123','user','maybe an issue');memory.save(record('hypothesis','Suspected cause, unverified.','history:1',{certainty:'tentative'}));
  const target=memory.target('weekly'),batch=memory.batch('weekly',target);
  assert.throws(()=>memory.save(record('false-confirmation','Definitely the cause.','memory:hypothesis@1')));
  memory.consolidate('weekly',batch,{summary:'Unverified cause needs evidence.',changes:[]},'weekly-test');
  assert.equal(memory.target('weekly'),target);assert.equal(memory.get('hypothesis').certainty,'tentative');assert.equal(memory.batch('weekly',target).records.length,0);
});
test('SDK turn retrieves relevant memory across fresh conversations, and consolidation uses read-only schema/tools',async t=>{
  const {cfg,store,memory}=await fixture(t);store.history('123','user','Codename amber.');memory.save(record('project-name','The codename is amber.','history:1'));
  const starts=[],contexts=[],options=[],caps=[];const capability=(u,w,m)=>{caps.push(m);return 'test';};capability.release=()=>{};
  const agent=new Agent(cfg,store,capability,opt=>{options.push(opt);return {startThread:opts=>{starts.push(opts);return {runStreamed:async(input,run)=>{contexts.push({text:input[0].text,schema:run.outputSchema});return {events:(async function*(){yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(caps.at(-1)?{summary:'',changes:[]}:{text:'amber',voice:false,files:[]})}};yield {type:'turn.completed'};})()};}};}};},memory);
  await agent.run('123','What is the codename?');assert.match(contexts[0].text,/The codename is amber/);
  await agent.run('123','memory review','research',[],undefined,()=>{},undefined,true);
  assert.equal(starts[1].sandboxMode,'read-only');assert.equal(starts[1].webSearchMode,'disabled');assert.deepEqual(contexts[1].schema.required,['summary','changes']);
  assert(options[1].configOverrides.includes('features.apps=false'));assert(options[1].configOverrides[0].includes('ASSISTANT_MEMORY_REVIEW="true"'));
});
test('nested-to-flat migration preserves revisions, sources, tombstones, checkpoints, schedules and custom instructions',async t=>{
  const {dir,cfg,store,service,memory}=await fixture(t);
  store.history('123','user','Codename cobalt.');store.history('123','user','Correction: codename amber.');
  memory.save(record('codename','Codename cobalt.','history:1',{category:'projects'}));
  memory.save(record('codename','Codename amber.','history:2',{category:'projects',expected_revision:1}));
  memory.save(record('retired','Retired fact.','history:1',{status:'archived'}));
  memory.save(record('forgotten','Forget this.','history:1'));memory.forget('forgotten');
  store.set('memory-cursor:123:daily','2');store.set('memory-cursor:123:weekly',memory.target('weekly'));
  service.ingest(update());const schedules=store.db.prepare("SELECT * FROM schedules WHERE kind='memory'").all();
  const versions=store.db.prepare('SELECT * FROM memory_versions ORDER BY id').all(),tombstones=store.db.prepare('SELECT * FROM memory_tombstones').all();
  const legacy=path.join(dir,'memory/users/123');await fs.mkdir(legacy,{recursive:true});
  for(const name of ['facts','projects','archive','INDEX.md'])await fs.rename(path.join(dir,'memory',name),path.join(legacy,name));
  await fs.writeFile(path.join(legacy,'custom-note.txt'),'Preserve this unrelated note.');
  await fs.writeFile(path.join(dir,'AGENTS.md'),'# Custom instructions\nKeep this prefix.\n\n## Durable memory v1\nOld generated routing.\n\n## Custom rules\nKeep this tail.\n');
  await fs.writeFile(path.join(dir,'USER.md'),'Keep this profile.');
  store.db.exec("DELETE FROM meta WHERE key IN ('memory-layout','memory-owner')");
  const migrated=new Service(cfg,store,{},service.agent);await migrated.init();
  assert.match(await fs.readFile(path.join(dir,'memory/projects/codename.md'),'utf8'),/Revision: 2/);
  assert.match(await fs.readFile(path.join(dir,'memory/archive/facts/retired.md'),'utf8'),/Retired fact/);
  assert.equal(migrated.memory.get('codename',1).content,'Codename cobalt.');assert.equal(migrated.memory.search('amber').entries.length,1);
  assert.equal(migrated.memory.get('forgotten'),null);
  assert.deepEqual(store.db.prepare('SELECT * FROM memory_versions ORDER BY id').all(),versions);
  assert.deepEqual(store.db.prepare('SELECT * FROM memory_tombstones').all(),tombstones);
  assert.equal(store.get('memory-cursor:123:daily'),'2');assert.equal(store.get('memory-cursor:123:weekly'),String(memory.target('weekly')));
  assert.deepEqual(store.db.prepare("SELECT * FROM schedules WHERE kind='memory'").all(),schedules);
  await assert.rejects(fs.access(path.join(dir,'memory/users')));
  const backup=store.get('memory-layout-backup');assert.equal(await fs.readFile(path.join(dir,backup,'custom-note.txt'),'utf8'),'Preserve this unrelated note.');
  const instructions=await fs.readFile(path.join(dir,'AGENTS.md'),'utf8');assert.match(instructions,/Keep this prefix/);assert.match(instructions,/Keep this tail/);assert(!instructions.includes('## Durable memory v1'));assert.equal(instructions.split('## Durable memory v2').length,2);
  assert.equal(await fs.readFile(path.join(dir,'USER.md'),'utf8'),'Keep this profile.');
  await migrated.init();assert.equal(store.get('memory-layout-backup'),backup);assert.equal((await fs.readFile(path.join(dir,'AGENTS.md'),'utf8')).split('## Durable memory v2').length,2);
});
test('single-owner memory refuses owner changes and mixed legacy ownership instead of merging',async t=>{
  const {dir,store}=await fixture(t);
  assert.throws(()=>new Memory(dir,store,'456'),/another owner/);
  store.db.prepare('INSERT INTO memory_tombstones VALUES (?,?,?,?)').run('456','foreign','[]',Date.now());
  assert.throws(()=>new Memory(dir,store,'123'),/another owner/);
});
test('migration keeps an unrelated destination file and retries safely after it is preserved elsewhere',async t=>{
  const {dir,store,memory}=await fixture(t);memory.save(record('detail','Confirmed detail.','https://example.com/'));
  store.db.exec("DELETE FROM meta WHERE key='memory-layout'");
  const destination=path.join(dir,'memory/facts/detail.md');await fs.writeFile(destination,'Unrelated existing content.');
  assert.throws(()=>memory.migrate(),/unrelated destination/);assert.equal(await fs.readFile(destination,'utf8'),'Unrelated existing content.');
  assert.equal(memory.get('detail').revision,1);
  await fs.rename(destination,path.join(dir,'outputs','preserved-note.md'));memory.migrate();
  assert.match(await fs.readFile(destination,'utf8'),/Confirmed detail/);assert.equal(store.get('memory-layout'),'flat-v1');
  store.db.exec("DELETE FROM meta WHERE key='memory-layout'");const index=path.join(dir,'memory/INDEX.md');await fs.writeFile(index,'Custom legacy index.');
  assert.throws(()=>memory.migrate(),/unrelated destination index/);assert.equal(await fs.readFile(index,'utf8'),'Custom legacy index.');
});
