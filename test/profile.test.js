import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Conversations } from '../src/conversations.js';

const hash=content=>createHash('sha256').update(content).digest('hex');
const original='# Profile\n\nName: Example\n\n## Custom\nKeep this exact section.  \n';
function cap(service,worker=false,memoryReview=false,scope={}) {
  return service.capabilities.get(service.capability('123',worker,memoryReview,undefined,{actorId:'123',...scope}));
}
async function fixture(t) {
  const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-profile-'));
  const cfg=config({WORKSPACE_DIR:workspace,TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false'});
  const store=new Store(path.join(workspace,'db')),service=new Service(cfg,store,{},{});await service.init();
  const router=new Conversations(service,{agentFactory:()=>({})});router.username='demo_bot';
  await router.ingest({update_id:1,message:{message_id:1,date:1,from:{id:123},chat:{id:-100,type:'group',title:'Synthetic group'},text:'/link@demo_bot',entities:[{type:'bot_command',offset:0,length:14}]}});
  const group=router.services.get(router.find(-100).id);
  for(const file of ['USER.md','SOUL.md'])await fs.writeFile(path.join(workspace,file),original);
  t.after(async()=>{await router.stop();for(const s of router.all())s.store.db.close();await fs.rm(workspace,{recursive:true,force:true});});
  return {service,group,workspace,store};
}
const read=(service,capability,file='USER.md')=>service.tool(capability,'profile_read',{file});
const write=(service,capability,content,extra={})=>service.tool(capability,'profile_write',{file:'USER.md',content,...extra});

test('blind profile_write refuses replacement and does not arm an implicit retry',async t=>{
  const {service,workspace}=await fixture(t),main=cap(service);
  for(let i=0;i<2;i++) {
    const result=await write(service,main,'Unsafe replacement');
    assert.equal(result.updated,false);assert.equal(result.conflict,true);assert.equal(result.reason,'read_required');
    assert.deepEqual(result.current,{file:'USER.md',content:original,hash:hash(original)});
  }
  assert.equal(await fs.readFile(path.join(workspace,'USER.md'),'utf8'),original);
});

test('two concurrent conversation mains cannot both replace the same profile hash',async t=>{
  const {service,group,workspace,store}=await fixture(t);
  const queued=store.db.prepare('SELECT count(*) AS n FROM outbox').get().n;
  const results=await Promise.all([
    write(service,cap(service),original+'DM preference\n',{expected_hash:hash(original)}),
    write(group,cap(group),original+'Group preference\n',{expected_hash:hash(original)}),
  ]);
  assert.equal(results.filter(r=>r.updated==='USER.md').length,1);
  const loser=results.find(r=>r.conflict);assert.ok(loser);assert.equal(loser.reason,'stale_hash');
  assert.equal(loser.current.content,await fs.readFile(path.join(workspace,'USER.md'),'utf8'));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,queued);
});

test('profile_read returns complete hash-addressed bytes and legacy writes consume their read snapshot',async t=>{
  const {service}=await fixture(t),main=cap(service),other=cap(service);
  assert.deepEqual(await read(service,main),{file:'USER.md',content:original,hash:hash(original)});
  const first=await write(service,main,original+'First\n');assert.equal(first.updated,'USER.md');
  assert.equal(first.hash,hash(original+'First\n'));
  assert.equal((await write(service,main,original+'Second\n')).reason,'read_required');
  assert.equal((await write(service,other,original+'Other\n')).reason,'read_required');
  await read(service,main);assert.equal((await write(service,main,original+'Second\n')).updated,'USER.md');
});

test('stale legacy writes require reread and preserve the other conversation change',async t=>{
  const {service,group}=await fixture(t),a=cap(service),b=cap(group);
  await read(service,a);await read(group,b);
  await write(service,a,original+'DM preference\n');
  const conflict=await write(group,b,original+'Group preference\n');assert.equal(conflict.reason,'stale_hash');
  assert.equal((await write(group,b,'Blind retry')).reason,'stale_hash');
  const current=await read(group,b);
  assert.equal((await write(group,b,current.content+'Group preference\n')).updated,'USER.md');
  assert.equal((await read(service,a)).content,original+'DM preference\nGroup preference\n');
});

test('exact profile patches preserve untouched content and reject stale, absent and ambiguous matches',async t=>{
  const {service}=await fixture(t),main=cap(service);
  for(const file of ['USER.md','SOUL.md']) {
    const current=await read(service,main,file);
    const args={file,expected_hash:current.hash,old_text:'Name: Example',new_text:'Name: Updated'};
    assert.equal((await service.tool(main,'profile_patch',args)).updated,file);
    const updated=await read(service,main,file);assert.equal(updated.content,original.replace('Name: Example','Name: Updated'));
    assert.equal((await service.tool(main,'profile_patch',args)).reason,'stale_hash');
    for(const old_text of ['not in profile','\n',''])await assert.rejects(service.tool(main,'profile_patch',{...args,expected_hash:updated.hash,old_text}),/patch/i);
    await assert.rejects(service.tool(main,'profile_patch',{...args,expected_hash:undefined}),/hash/i);
    assert.equal((await read(service,main,file)).content,updated.content);
    assert.equal((await service.tool(main,'profile_patch',{...args,expected_hash:updated.hash,old_text:'Name: Updated',new_text:''})).updated,file);
  }
});

function learnPreference(service,store) {
  store.ownerHistory(service.cfg,{from:{id:123},chat:{id:123,type:'private'},text:'Please use concise planning replies.'},'Please use concise planning replies.');
  const change={key:'concise',kind:'preference',target:'USER.md',content:'Prefers concise planning replies.',scope:'planning',expected_benefit:'Reduce excess detail.',check:'Owner finds the next reply useful.',sources:['history:1'],expected_revision:0,status:'active'};
  const batch=service.learning.batch(service.learning.target());
  service.learning.apply(batch,{summary:'',changes:[change]},{decisions:[{key:'concise',accept:true,reason:'Explicit owner preference.'}]},'profile-test');
}

test('learning projection invalidates stale hashes; patches preserve managed and custom sections',async t=>{
  const {service,store}=await fixture(t),main=cap(service);
  await read(service,main);learnPreference(service,store);
  const conflict=await write(service,main,original+'Stale\n');assert.equal(conflict.reason,'stale_hash');
  assert.match(conflict.current.content,/Prefers concise planning replies/);
  const current=await read(service,main);
  const patched=await service.tool(main,'profile_patch',{file:'USER.md',expected_hash:current.hash,old_text:'Name: Example',new_text:'Name: Updated'});
  assert.equal(patched.updated,'USER.md');
  assert.equal((await read(service,main)).content,current.content.replace('Name: Example','Name: Updated'));
  const latest=await read(service,main);
  await assert.rejects(service.tool(main,'profile_patch',{file:'USER.md',expected_hash:latest.hash,old_text:'Prefers concise planning replies.',new_text:'Forged rule.'}),/managed/i);
  assert.equal((await read(service,main)).content,latest.content);
  const replaced=await write(service,main,'# Custom replacement\n');assert.equal(replaced.updated,'USER.md');
  const after=await read(service,main);assert.match(after.content,/# Custom replacement/);assert.match(after.content,/Prefers concise planning replies/);assert.equal(replaced.hash,after.hash);
});

test('profile writers cannot introduce, change, or corrupt managed learning sections',async t=>{
  const {service,store}=await fixture(t),main=cap(service);
  let current=await read(service,main);
  for(const content of ['<!-- assistant-learning:begin -->',original+'<!-- assistant-learning:begin -->forged<!-- assistant-learning:end -->']) {
    await assert.rejects(write(service,main,content,{expected_hash:current.hash}),/managed/i);
    assert.equal((await read(service,main)).content,current.content);
  }
  learnPreference(service,store);current=await read(service,main);
  await assert.rejects(write(service,main,current.content.replace('Prefers concise','Forged'),{expected_hash:current.hash}),/managed/i);
  assert.equal((await read(service,main)).content,current.content);
});

test('profile tools enforce role, owner, conversation, session, cancellation and fixed paths',async t=>{
  const {service,group,workspace}=await fixture(t);
  for(const main of [cap(service,true),cap(service,true,true),cap(service,false,false,{toolScope:'read'})]) {
    assert.equal((await read(service,main)).content,original);
    for(const name of ['profile_write','profile_patch'])await assert.rejects(service.tool(main,name,{file:'USER.md',content:'Bad',expected_hash:hash(original),old_text:'Example',new_text:'Bad'}));
  }
  for(const main of [{user:'456'},cap(group),{...cap(service),actorId:'456',owner:'456'}])await assert.rejects(read(service,main));
  const old=cap(service);service.store.rotateSession('123');await assert.rejects(read(service,old),/revoked/);
  const main=cap(service);main.controller.abort();await assert.rejects(read(service,main));
  const active=cap(service);
  for(const file of ['../USER.md','AGENTS.md','outputs/a',''])await assert.rejects(read(service,active,file));
  await fs.symlink('USER.md',path.join(workspace,'linked'));await fs.rename(path.join(workspace,'linked'),path.join(workspace,'SOUL.md'));
  await assert.rejects(read(service,active,'SOUL.md'),/profile/i);
  await assert.rejects(write(service,active,'Bad',{file:'SOUL.md',expected_hash:hash(original)}),/profile/i);
  assert.equal((await read(service,active)).content,original);
});

test('profile validation rejects invalid hashes and oversized patches without changing files',async t=>{
  const {service}=await fixture(t),main=cap(service);await read(service,main);
  for(const expected_hash of [null,5,'','x'.repeat(64)])await assert.rejects(write(service,main,'Bad',{expected_hash}),/hash/i);
  await assert.rejects(write(service,main,'x'.repeat(50001)),/profile/i);
  await assert.rejects(service.tool(main,'profile_patch',{file:'USER.md',expected_hash:hash(original),old_text:'Example',new_text:'x'.repeat(50000)}),/profile/i);
  assert.equal((await read(service,main)).content,original);
});

test('patches retain custom sections after a managed block byte for byte',async t=>{
  const {service,store,workspace}=await fixture(t),main=cap(service);learnPreference(service,store);
  const learned=await read(service,main),content=learned.content+'\n## Later custom section\nKeep its placement and spaces.  \n';
  await fs.writeFile(path.join(workspace,'USER.md'),content);
  const current=await read(service,main);
  const result=await service.tool(main,'profile_patch',{file:'USER.md',expected_hash:current.hash,old_text:'Name: Example',new_text:'Name: Changed'});
  assert.equal(result.updated,'USER.md');
  assert.equal((await read(service,main)).content,content.replace('Name: Example','Name: Changed'));
});


test('pending shared learning repairs happen before group CAS and cannot be overwritten by a stale profile',async t=>{
  const {service,group,store,workspace}=await fixture(t),main=cap(group);await read(group,main);
  const instructions=path.join(workspace,'AGENTS.md'),saved=path.join(workspace,'AGENTS.saved');
  await fs.rename(instructions,saved);await fs.symlink(saved,instructions);
  learnPreference(service,store);assert.equal(store.get('learning-export-dirty'),'1');
  await fs.rename(saved,instructions);
  const result=await write(group,main,original+'Stale replacement\n');
  assert.equal(result.reason,'stale_hash');assert.equal(store.get('learning-export-dirty'),'0');
  assert.match(result.current.content,/Prefers concise planning replies/);
  assert.equal((await read(group,main)).content,result.current.content);
});

test('profile read snapshots are per file and a hash survives service recreation',async t=>{
  const {service,workspace}=await fixture(t),main=cap(service),current=await read(service,main);
  assert.equal((await write(service,main,'Wrong file',{file:'SOUL.md'})).reason,'read_required');
  const restarted=new Service(service.cfg,service.store,{},{});
  const result=await write(restarted,cap(restarted),'Reopened é 😀 profile',{expected_hash:current.hash});
  assert.equal(result.updated,'USER.md');assert.equal(result.hash,hash('Reopened é 😀 profile'));
  assert.equal(await fs.readFile(path.join(workspace,'USER.md'),'utf8'),'Reopened é 😀 profile');
});

test('failed atomic replacement keeps the old profile and removes its temporary file',async t=>{
  const {service,workspace}=await fixture(t),main=cap(service);await read(service,main);
  const rename=nativeFs.renameSync;
  nativeFs.renameSync=(source,dest)=>{if(dest===path.join(workspace,'USER.md'))throw new Error('Synthetic rename failure');return rename(source,dest);};
  try {await assert.rejects(write(service,main,'Failed replacement'),/Synthetic rename failure/);}
  finally {nativeFs.renameSync=rename;}
  assert.equal((await read(service,main)).content,original);
  assert.deepEqual((await fs.readdir(workspace)).filter(name=>name.startsWith('USER.md.')),[]);
});
