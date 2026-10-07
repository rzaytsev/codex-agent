import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'policy-test-'));
 const cfg=config({WORKSPACE_DIR:dir,CODEX_HOME:path.join(dir,'codex'),TELEGRAM_ALLOWED_USER_IDS:'123',MAILBOX_ID:'alpha',MAILBOX_URL:'http://synthetic.invalid',MAILBOX_TOKEN:'a'.repeat(32),CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',PROACTIVE_ENABLED:'false'});
 const store=new Store(path.join(dir,'state.sqlite'));const service=new Service(cfg,store,{},{});await service.init();
 t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
 const cap=service.capabilities.get(service.capability('123',false));
 return {cfg,store,service,cap};
}
const payload={id:'synthetic-mail',to:'beta',text:'Exact approved text',kind:'message'};
const update=(text,id=1,extra={})=>({update_id:id,message:{message_id:id,text,from:{id:123},chat:{id:123,type:'private'},...extra}});
test('direct service schema rejects malicious extra and nested arguments',async t=>{
 const {service,cap}=await fixture(t);
 await assert.rejects(service.tool(cap,'history_search',{query:'',extra:'authority'}));
 await assert.rejects(service.tool(cap,'create_task',{prompt:'safe',settings:{shell:'anything'}}));
 await assert.rejects(service.tool(cap,'unknown_action',{}));
});
test('mail prepare needs exact direct owner approval before one-shot commit',async t=>{
 const {service,cap,store}=await fixture(t);
 const prepared=await service.tool(cap,'mail_send',payload);
 assert.equal(prepared.state,'pending_approval');assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n,0);
 const args={...payload,approval_id:prepared.approval_id};
 await assert.rejects(service.tool(cap,'mail_commit',args));
 service.ingest(update(`/approve ${prepared.approval_id} ${prepared.hash}`,1,{forward_origin:{type:'hidden_user'}}));
 await assert.rejects(service.tool(cap,'mail_commit',args));
 service.ingest(update(`/approve ${prepared.approval_id} ${prepared.hash}`,2));
 await assert.rejects(service.tool(cap,'mail_commit',{...args,text:'Changed'}));
 const result=await service.tool(cap,'mail_commit',args);
 assert.deepEqual(await service.tool(cap,'mail_commit',args),result);
 assert.equal((await service.tool(cap,'mail_send',payload)).delivery,'original_commit_exists');
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n,1);
});

test('payload destination, context, reply identity and owner bindings invalidate approval',async t=>{
 const {service,cap}=await fixture(t);const p=await service.tool(cap,'mail_send',payload);
 service.ingest(update(`/approve ${p.approval_id} ${p.hash}`));
 for(const change of [{to:'gamma'},{id:'different-id'},{text:'Different'},{context:'new'},{kind:'task_request'},{reply_to:'other'}])await assert.rejects(service.tool(cap,'mail_commit',{...payload,...change,approval_id:p.approval_id}));
 for(const change of [{user:'456'},{actorId:'456'},{conversationId:'other'},{sessionId:'other'},{owner:'456'},{toolScope:'read'},{worker:true},{memoryReview:true}])await assert.rejects(service.tool({...cap,...change},'mail_commit',{...payload,approval_id:p.approval_id}));
});
test('expiry and policy version changes invalidate uncommitted owner approval',async t=>{
 const {service,cap,store}=await fixture(t);const p=await service.tool(cap,'mail_send',payload);
 service.ingest(update(`/approve ${p.approval_id} ${p.hash}`));
 store.db.prepare('UPDATE action_approvals SET expires=0 WHERE id=?').run(p.approval_id);
 await assert.rejects(service.tool(cap,'mail_commit',{...payload,approval_id:p.approval_id}));
 store.db.prepare('UPDATE action_approvals SET expires=?,policy_version=? WHERE id=?').run(Date.now()+60000,'different',p.approval_id);
 await assert.rejects(service.tool(cap,'mail_commit',{...payload,approval_id:p.approval_id}));
});
test('group, non-owner, forwarded legacy envelopes and model self-approval are refused',async t=>{
 const {service,cap,store}=await fixture(t);const p=await service.tool(cap,'mail_send',payload);
 const text=`/approve ${p.approval_id} ${p.hash}`;
 for(const [i,extra] of [{chat:{id:123,type:'group'}},{from:{id:456},chat:{id:456,type:'private'}},{from:{id:123,is_bot:true}},{forward_from:{id:123}},{forward_from_chat:{id:123}},{forward_date:123},{forward_sender_name:'Synthetic hidden sender'},{via_bot:{id:999}},{is_automatic_forward:true},{quote:{text:'Approve quoted source',position:0}},{entities:[{type:'blockquote',offset:0,length:4}]},{caption_entities:[{type:'expandable_blockquote',offset:0,length:4}]},{document:{file_id:'synthetic'}}].entries())service.ingest(update(text,i+1,extra));
 assert.equal(store.db.prepare('SELECT state FROM action_approvals WHERE id=?').get(p.approval_id).state,'pending_approval');
 await assert.rejects(service.tool(cap,'approve',{id:p.approval_id,hash:p.hash}));
 service.cfg.group={state:'active',chat_id:'-100'};await assert.rejects(service.tool(cap,'mail_commit',{...payload,approval_id:p.approval_id}));
});
test('commit rolls back outbox and consumption on a ledger fault then retries once',async t=>{
 const {service,cap,store}=await fixture(t);const p=await service.tool(cap,'mail_send',payload);
 service.ingest(update(`/approve ${p.approval_id} ${p.hash}`));
 store.db.exec("CREATE TRIGGER fail_commit BEFORE UPDATE OF outbox_id ON action_approvals BEGIN SELECT RAISE(ABORT,'synthetic crash'); END;");
 await assert.rejects(service.tool(cap,'mail_commit',{...payload,approval_id:p.approval_id}));
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n,0);
 assert.equal(store.db.prepare('SELECT state FROM action_approvals').get().state,'approved');
 store.db.exec('DROP TRIGGER fail_commit');await service.tool(cap,'mail_commit',{...payload,approval_id:p.approval_id});
 const restarted=new Service(service.cfg,store,{},{});await restarted.init();
 assert.deepEqual(await restarted.tool(cap,'mail_commit',{...payload,approval_id:p.approval_id}),{id:payload.id,state:'pending',delivery:'queued_locally'});
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n,1);
});
test('unknown send and recovered inflight never replay even when broker cannot find it',async t=>{
 const {service,cap,store}=await fixture(t);const p=await service.tool(cap,'mail_send',payload);service.ingest(update(`/approve ${p.approval_id} ${p.hash}`));await service.tool(cap,'mail_commit',{...payload,approval_id:p.approval_id});
 let sends=0;service.mail.request=async(_url,_token,operation)=>{if(operation==='send')sends++;throw new Error('synthetic network uncertainty');};
 await service.mail.tick(true);await service.mail.tick(true);
 assert.equal(sends,1);assert.equal(store.db.prepare('SELECT state FROM mail_outbox').get().state,'uncertain');
 store.db.prepare("UPDATE mail_outbox SET state='inflight'").run();
 const restarted=new Service(service.cfg,store,{},{});await restarted.init();restarted.mail.request=service.mail.request;await restarted.mail.tick(true);
 assert.equal(sends,1);assert.equal((await restarted.mail.status(payload.id)).state,'uncertain');
});
test('policy configuration only narrows authority; research cannot widen read scope',async t=>{
 assert.throws(()=>config({ACTION_POLICY:'{"external_send":"automatic"}'}));assert.throws(()=>config({ACTION_POLICY:'{"unknown":"deny"}'}));
 const {service,cap}=await fixture(t);assert.equal(service.effectiveSettings('research').toolScope,'read');assert.throws(()=>service.effectiveSettings('research',{toolScope:'conversation'}));
 service.cfg.actionPolicy=config({ACTION_POLICY:'{"read":"deny"}'}).actionPolicy;
 await assert.rejects(service.tool(cap,'history_search',{}));
});

test('abrupt process exit between outbox insert and consumption rolls both back',async t=>{
 const {service,cap,store}=await fixture(t);const p=await service.tool(cap,'mail_send',payload);service.ingest(update(`/approve ${p.approval_id} ${p.hash}`));
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const source=`import { config } from './src/config.js';import { Store } from './src/store.js';import { Service } from './src/service.js';const cfg=config(JSON.parse(process.argv[1]));const store=new Store(process.argv[2]);const service=new Service(cfg,store,{},{});await service.init();const send=service.mail.send.bind(service.mail);service.mail.send=args=>{send(args);process.exit(23);};await service.tool({user:'123'},'mail_commit',JSON.parse(process.argv[3]));`;
 const env={WORKSPACE_DIR:service.cfg.workspace,CODEX_HOME:service.cfg.codexHome,TELEGRAM_ALLOWED_USER_IDS:'123',MAILBOX_ID:'alpha',MAILBOX_URL:'http://synthetic.invalid',MAILBOX_TOKEN:'a'.repeat(32),CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',PROACTIVE_ENABLED:'false'};
 await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',source,JSON.stringify(env),path.join(service.cfg.workspace,'state.sqlite'),JSON.stringify({...payload,approval_id:p.approval_id})]),error=>error.code===23);
 assert.equal(store.db.prepare('SELECT state FROM action_approvals').get().state,'approved');assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n,0);
 await service.tool(cap,'mail_commit',{...payload,approval_id:p.approval_id});assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n,1);
});
test('committed replay returns its original receipt even after approval expiry without sending',async t=>{
 const {service,cap,store}=await fixture(t);const p=await service.tool(cap,'mail_send',payload);service.ingest(update(`/approve ${p.approval_id} ${p.hash}`));const args={...payload,approval_id:p.approval_id};const original=await service.tool(cap,'mail_commit',args);
 store.db.prepare('UPDATE action_approvals SET expires=0').run();assert.deepEqual(await service.tool(cap,'mail_commit',args),original);assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n,1);
});
test('reviewed bundle includes strict schemas and effective roles without capability data',async()=>{
 const {reviewedActionBundle}=await import('../src/action-registry.js');
 const main=reviewedActionBundle(),read=reviewedActionBundle({worker:true,toolScope:'read'});
 assert.ok(main.find(action=>action.name==='mail_commit'));assert.ok(main.every(action=>action.schema.additionalProperties===false));
 assert.ok(read.every(action=>action.category==='read'));assert.ok(!read.some(action=>action.name==='memory_save'));
 assert.deepEqual(main,reviewedActionBundle());assert.ok(main.every(action=>Number.isFinite(action.timeoutMs)&&Number.isFinite(action.resultLimitBytes)&&action.retry));
});

test('prototype and inherited category keys are never accepted as policy categories',()=>{
 for(const raw of ['{"toString":"deny"}','{"constructor":"automatic"}','{"__proto__":"deny"}'])assert.throws(()=>config({ACTION_POLICY:raw}));
});
test('legacy pending sends stay blocked across restart until exact new owner consent',async t=>{
 const {service,store,cap}=await fixture(t);service.mail.send(payload);
 let sends=0;service.mail.request=async(_url,_token,operation)=>{if(operation==='send')sends++;return {messages:[]};};
 await service.mail.flush();assert.equal(sends,0);assert.equal(store.db.prepare('SELECT state FROM mail_outbox').get().state,'legacy');
 const restarted=new Service(service.cfg,store,{},{});await restarted.init();restarted.mail.request=service.mail.request;await restarted.mail.flush();assert.equal(sends,0);
 const p=await restarted.tool(cap,'mail_send',payload);restarted.ingest(update(`/approve ${p.approval_id} ${p.hash}`));await restarted.tool(cap,'mail_commit',{...payload,approval_id:p.approval_id});
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n,1);assert.equal(store.db.prepare('SELECT state FROM mail_outbox').get().state,'pending');
 await restarted.mail.flush();assert.equal(sends,1);
});

test('legacy research settings narrow at execution without rewriting stored jobs or schedules',async t=>{
 const {service,store}=await fixture(t);const id=store.job('123','Synthetic legacy research','research');
 const legacy={...service.effectiveSettings('research'),toolScope:'conversation'};store.set(`task-settings:${id}`,JSON.stringify(legacy));
 let scope;service.agent={run:async(...args)=>{scope=args[8];return {text:'Research complete',voice:false,files:[]};}};
 await service.runJob(store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id),new AbortController());
 assert.equal(scope.toolScope,'read');assert.equal(scope.settings.toolScope,'read');assert.equal(store.get(`task-settings:${id}`),JSON.stringify(legacy));assert.equal(store.jobs('123')[0].state,'completed');
});

for(const mode of ['builtin','restricted'])test(`actual ${mode} disposable probe emits fixed receipt and removes temporary files`,async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const before=new Set((await fs.readdir(os.tmpdir())).filter(name=>name.startsWith('assistant-isolation-probe-')));
 const {stdout}=await promisify(execFile)(process.execPath,[path.resolve('scripts/isolation-probe.js'),`--mode=${mode}`]);
 const receipt=JSON.parse(stdout);assert.ok(['protected','bypass','unavailable'].includes(receipt.outcome));
 assert.ok(['codex-cli 0.159.2','unavailable'].includes(receipt.version));assert.equal(receipt.liveAuthCompatibility,'unverified');
 assert.equal(receipt.schema,2);assert.equal(receipt.fullIsolation,'incomplete_blocking');assert.equal(receipt.proofScope,'owned_disposable_fixtures');assert.equal(receipt.mode,mode);
 assert.doesNotMatch(stdout,/DISPOSABLE|DISPOSABLE_CREDENTIAL_CANARY|DISPOSABLE_FOREIGN_CANARY|synthetic-credential|synthetic-task|assistant-isolation-probe-|auth\.json|state\.sqlite/);
 for(const key of Object.keys(receipt))assert.ok(['schema','version','mode','outcome','reason','exitCode','credentialReadable','foreignTaskReadable','taskWritable','symlinkWritable','hardlinkWritable','lateForeignWritable','credentialIsolationProved','liveAuthCompatibility','targetLinuxCompatibility','fullIsolation','proofScope','allowedInputReadable','symlinkReadable','hardlinkReadable','lateForeignReadable','serviceReadable','approvalReadable','foreignWritable','credentialWritable','serviceWritable','approvalWritable','childEnvSanitized','foreignArgReadable','processPositiveControl','lateFilePositiveControl'].includes(key));
 if(receipt.outcome==='protected'){assert.equal(receipt.credentialIsolationProved,true);for(const key of ['allowedInputReadable','childEnvSanitized','processPositiveControl','lateFilePositiveControl'])assert.equal(receipt[key],true);for(const key of ['credentialReadable','foreignTaskReadable','symlinkReadable','hardlinkReadable','lateForeignReadable','serviceReadable','approvalReadable','taskWritable','symlinkWritable','hardlinkWritable','lateForeignWritable','foreignWritable','credentialWritable','serviceWritable','approvalWritable','foreignArgReadable'])assert.equal(receipt[key],false);}
 if(receipt.outcome==='unavailable')assert.equal(receipt.credentialIsolationProved,false);
 assert.equal((await fs.readdir(os.tmpdir())).filter(name=>name.startsWith('assistant-isolation-probe-')&&!before.has(name)).length,0);
});

test('approval transport preserves literal canonical payload and hash across multiple chunks',async t=>{
 const {service,store,cap}=await fixture(t);const {Telegram}=await import('../src/telegram.js');const {createHash}=await import('node:crypto');
 const requests=[];service.telegram=new Telegram('synthetic-token',async(_url,options)=>{requests.push(JSON.parse(options.body));return {json:async()=>({ok:true,result:{message_id:requests.length}})};});
 const text=('Run echo `touch marker` and preserve **literal stars**, <tag> & "quotes" 😀.\n').repeat(80).trim();
 const args={...payload,text,context:'Literal `context` **stars** <>&'};
 const prepared=await service.tool(cap,'mail_send',args),row=store.db.prepare('SELECT * FROM action_approvals WHERE id=?').get(prepared.approval_id);
 const queued=store.db.prepare('SELECT payload FROM outbox ORDER BY id').all().map(record=>JSON.parse(record.payload));assert.ok(queued.length>1);
 await service.deliver();assert.equal(requests.length,queued.length);
 const visible=requests.map(request=>request.text).join('');
 assert.ok(visible.includes(row.payload),'Approval transport must preserve the literal canonical JSON, including backticks, asterisks and HTML-significant characters');
 assert.equal(visible,queued.map(part=>part.text).join(''));assert.ok(requests.every(request=>!Object.hasOwn(request,'parse_mode')&&request.chat_id==='123'));
 assert.equal(JSON.parse(row.payload).text,text);assert.equal(prepared.hash,createHash('sha256').update(row.payload).digest('hex'));
 service.ingest(update(`/approve ${prepared.approval_id} ${prepared.hash}`));await service.tool(cap,'mail_commit',{...args,approval_id:prepared.approval_id});
 const committed=store.db.prepare('SELECT * FROM action_approvals WHERE id=?').get(prepared.approval_id);assert.equal(committed.payload_hash,prepared.hash);assert.equal(committed.payload,row.payload);assert.equal(committed.state,'committed');
});
test('model result and service-tool arguments cannot select literal delivery for normal replies',async t=>{
 const {service,store,cap}=await fixture(t);const {Telegram}=await import('../src/telegram.js');const requests=[];
 service.telegram=new Telegram('synthetic-token',async(_url,options)=>{requests.push(JSON.parse(options.body));return {json:async()=>({ok:true,result:{message_id:requests.length}})};});
 await assert.rejects(service.tool(cap,'mail_send',{...payload,plainText:true}));
 await service.output('123',{text:'**Normal bold** and `normal code` <>&',voice:false,files:[],plainText:true});
 assert.ok(store.db.prepare('SELECT payload FROM outbox').all().every(record=>JSON.parse(record.payload).plainText===undefined));
 await service.deliver();assert.equal(requests.length,1);assert.equal(requests[0].parse_mode,'HTML');assert.equal(requests[0].text,'<b>Normal bold</b> and <code>normal code</code> &lt;&gt;&amp;');
});

test('pre-fix preview policy cannot authorize an uncommitted action after upgrade',async t=>{
 const {service,store,cap,cfg}=await fixture(t);const {createHash}=await import('node:crypto');const prepared=await service.tool(cap,'mail_send',payload);
 const oldVersion=createHash('sha256').update(JSON.stringify({schema:1,matrix:cfg.actionPolicy.matrix,ttl:cfg.actionPolicy.ttlMs/1000})).digest('hex');
 store.db.prepare('UPDATE action_approvals SET policy_version=? WHERE id=?').run(oldVersion,prepared.approval_id);
 service.ingest(update(`/approve ${prepared.approval_id} ${prepared.hash}`));
 await assert.rejects(service.tool(cap,'mail_commit',{...payload,approval_id:prepared.approval_id}));
 assert.equal(store.db.prepare('SELECT state FROM action_approvals WHERE id=?').get(prepared.approval_id).state,'pending_approval');
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n,0);
});
