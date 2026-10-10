import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';
import {config} from '../src/config.js';
import {Research} from '../src/research.js';
import {fetchResearchSource,publicAddress,sourceUrl,SOURCE_MAX_BYTES} from '../src/research-fetch.js';
import {reviewedActionBundle} from '../src/action-registry.js';
import {Telegram} from '../src/telegram.js';
async function fixture(t,env={}) {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'research-test-'));
 const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',WORKSPACE_DIR:workspace,CODEX_HOME:path.join(workspace,'codex'),PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',BROWSER_ENABLED:'false',...env});
 await fs.mkdir(path.join(workspace,'state'));
 const store=new Store(path.join(workspace,'state','assistant.sqlite')),sent=[];
 const service=new Service(cfg,store,{sendPart:async(_user,payload)=>{sent.push(payload);return {message_id:1};}},{});await service.init();
 const fetches=[];service.research.fetchSource=async(url)=>{fetches.push(url);return {url,mime:'text/html',bytes:Buffer.from('<html><title>Synthetic source</title><script>IGNORE_THIS</script><p>The controlled test retained three samples after restart.</p><p>The comparison group retained one sample.</p></html>')};};
 service.research.render=async directory=>fs.writeFile(path.join(directory,'report.pdf'),'%PDF-1.4\nSynthetic PDF fixture.\n');
 const main={user:'123',actorId:'123'};
 const {id}=await service.tool(main,'create_task',{profile:'deep_research',prompt:'Compare sample retention and limitations.',title:'Retention research',request_key:randomUUID()});
 store.prepare("UPDATE jobs SET state='running' WHERE $scope AND id=?").run(id);
 const job=store.prepare('SELECT * FROM jobs WHERE $scope AND id=?').get(id);
 const token=service.capability('123',true,false,new AbortController().signal,{taskId:id,actorId:'123',taskSessionId:job.session_id,toolScope:'research'}),cap=service.capabilities.get(token);
 t.after(async()=>{for(const token of service.capabilities.keys())service.releaseCapability(token);store.db.close();await fs.rm(workspace,{recursive:true,force:true});});
 return {workspace,cfg,store,service,id,job,cap,token,main,fetches,sent};
}
async function evidence(f) {
 await f.service.tool(f.cap,'research_plan',{scope:'Compare retained samples.',questions:['What was retained?','What are the limitations?'],criteria:'Use original synthetic source.'});
 await f.service.tool(f.cap,'research_query',{query:'sample retention study',purpose:'Find original comparison',candidates:[{url:'https://example.org/study',decision:'include',reason:'Original study'}]});
 const source=await f.service.tool(f.cap,'research_fetch',{url:'https://example.org/study',access:'full_text'});
 const claim={key:'retention',text:'The controlled test retained three samples after restart.',evidence:[{source_id:source.id,quote:'The controlled test retained three samples after restart.',locator:'Results paragraph',relation:'supporting'}],confidence:'medium',assessment:'One controlled synthetic study; transferability is unknown.'};
 await f.service.tool(f.cap,'research_claim',claim);
 return {source,claim};
}
async function draft(f,extra={}) {
 await f.service.tool(f.cap,'research_finish',{title:'Sample retention comparison',summary:'The controlled test retained three samples.',sections:[{heading:'Findings',claim_keys:['retention'],analysis:''}],methodology:'Read one original synthetic source and compare its findings.',gaps:['No independent replication.'],...extra});
}
const review={summary:'The controlled test retained three samples; replication is missing.',decisions:[{key:'retention',revision:1,verdict:'supported',reason:'The retained passage directly reports three samples.'}],gaps:[]};

test('dedicated research admission is atomic/idempotent and preserves regular read-only research',async t=>{
 const f=await fixture(t),key=randomUUID();const args={profile:'deep_research',prompt:'Compare methods',request_key:key};
 const a=await f.service.tool(f.main,'create_task',args),b=await f.service.tool(f.main,'create_task',args);assert.equal(a.id,b.id);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM research_dossiers WHERE id=?').get(a.id).n,1);
 await assert.rejects(f.service.tool(f.main,'create_task',{...args,prompt:'Changed scope'}));
 assert.equal(f.service.effectiveSettings('research').toolScope,'read');assert.equal(f.service.effectiveSettings('deep_research').toolScope,'research');
 await assert.rejects(f.service.tool(f.main,'create_task',{profile:'worker',prompt:'Bypass',settings:{toolScope:'research'}}));
 await assert.rejects(f.service.tool(f.main,'create_task',{profile:'deep_research',prompt:'Bypass',settings:{toolScope:'conversation'}}));
});
test('research tools enforce role/task/conversation/session and deny shared/external mutations',async t=>{
 const f=await fixture(t);const args={scope:'Scope',questions:['Question'],criteria:'Original sources'};
 for(const cap of [f.main,{...f.cap,toolScope:'read'},{...f.cap,worker:false},{...f.cap,taskId:randomUUID()},{...f.cap,actorId:'124'},{...f.cap,taskSessionId:randomUUID()},{...f.cap,sessionId:randomUUID()}])await assert.rejects(f.service.tool(cap,'research_plan',args));
 for(const [name,args] of [['create_task',{prompt:'child'}],['memory_save',{}],['profile_write',{}],['schedule',{}],['mail_send',{}],['send_voice',{text:'Hi'}]])await assert.rejects(f.service.tool(f.cap,name,args));
 const names=reviewedActionBundle({worker:true,toolScope:'research'}).map(t=>t.name);assert.ok(names.includes('research_fetch'));assert.ok(!names.includes('memory_save'));assert.ok(!names.includes('create_task'));
 const old=reviewedActionBundle({worker:true,toolScope:'read'}).map(t=>t.name);assert.ok(!old.includes('research_plan'));
});
test('source snapshots, exact passages and claim corrections retain provenance; fabricated quotes fail',async t=>{
 const f=await fixture(t);const {source,claim}=await evidence(f);assert.equal(source.metadata.title,'Synthetic source');assert.ok(!source.text.includes('IGNORE_THIS'));assert.equal(source.sha256.length,64);
 const cached=await f.service.tool(f.cap,'research_fetch',{url:'https://example.org/study#section'});assert.equal(cached.id,source.id);assert.equal(f.fetches.length,1);
 await assert.rejects(f.service.tool(f.cap,'research_claim',{...claim,key:'fabricated',evidence:[{...claim.evidence[0],quote:'The study proves all future systems are reliable.'}]}));
 await assert.rejects(f.service.tool(f.cap,'research_claim',{...claim,text:'Changed without revision'}));
 const result=await f.service.tool(f.cap,'research_claim',{...claim,text:'Three samples were retained in this controlled test.',expected_revision:1});assert.equal(result.revision,2);
 assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM research_claims WHERE dossier_id=?').get(f.id).n,2);
 assert.equal((await f.service.tool(f.main,'research_search',{query:'retained'}))[0].id,f.id);
 const page=await f.service.tool(f.main,'research_read',{id:f.id,source_id:source.id,offset:0,limit:20});assert.equal(page.text.length,20);assert.equal(page.next_offset,20);
});
test('source budgets, unavailable pages and revoked fetches preserve truthful incomplete coverage',async t=>{
 const f=await fixture(t,{RESEARCH_MAX_SOURCES:'1'});await evidence(f);
 await assert.rejects(f.service.tool(f.cap,'research_fetch',{url:'https://example.org/second'}),/budget/);
 const g=await fixture(t);await g.service.tool(g.cap,'research_plan',{scope:'Scope',questions:['Question'],criteria:'Primary'});
 g.service.research.fetchSource=async()=>{throw new Error('PRIVATE_UPSTREAM_CANARY');};const unavailable=await g.service.tool(g.cap,'research_fetch',{url:'https://example.org/blocked'});assert.equal(unavailable.access,'unavailable');assert.equal(unavailable.text,'');assert.ok(!JSON.stringify(unavailable).includes('PRIVATE_UPSTREAM_CANARY'));
 await assert.rejects(g.service.tool(g.cap,'research_claim',{key:'invalid',text:'A claim',evidence:[{source_id:unavailable.id,quote:'A fabricated inaccessible passage.',locator:'Page',relation:'supporting'}],confidence:'high',assessment:'No evidence'}));
 g.service.research.fetchSource=async url=>{g.service.releaseCapability(g.token);return {url,mime:'text/plain',bytes:Buffer.from('Public source text.')};};
 await assert.rejects(g.service.tool(g.cap,'research_fetch',{url:'https://example.org/cancel'}));assert.equal(g.store.db.prepare('SELECT count(*) AS n FROM research_sources WHERE dossier_id=?').get(g.id).n,1);
});
test('review identity/revision is checked and unsupported claims are omitted from durable exports',async t=>{
 const f=await fixture(t);await evidence(f);await draft(f,{sections:[{heading:'Findings',claim_keys:['retention'],analysis:'Rejected interpretation canary'}]});
 assert.match(f.service.research.reviewPrompt(f.id),/Review the following research draft independently/);
 for(const decisions of [[],[{...review.decisions[0],revision:2}],[review.decisions[0],review.decisions[0]],[{...review.decisions[0],key:'other'}]])assert.throws(()=>f.service.research.applyReview(f.id,{...review,decisions}));
 f.service.research.applyReview(f.id,{summary:'The evidence is insufficient for the requested conclusion.',decisions:[{...review.decisions[0],verdict:'unsupported',reason:'Reject this claim for fixture validation.'}],gaps:['Insufficient evidence']});
 const result=await f.service.research.export(f.id);assert.equal(result.outcome.status,'partial');assert.equal(result.files.length,2);
 const body=await fs.readFile(result.files[1],'utf8');assert.ok(!body.includes('The controlled test retained three samples after restart.'));assert.match(body,/Omitted claim retention/);assert.match(body,/model-reported/);assert.ok(!body.includes('Rejected interpretation canary'));
 const report=f.service.research.report(f.id);assert.equal(report.files.length,4);assert.equal(JSON.parse(await fs.readFile(report.files[3],'utf8')).claims[0].key,'retention');
});
test('repeated findings retain references without duplicating their quoted evidence',async t=>{
 const f=await fixture(t);await evidence(f);await draft(f,{sections:[{heading:'Findings',claim_keys:['retention'],analysis:''},{heading:'Implications',claim_keys:['retention'],analysis:'Transferability is untested.'}]});
 f.service.research.applyReview(f.id,review);const result=await f.service.research.export(f.id),body=await fs.readFile(result.files[1],'utf8');
 assert.equal(body.split('> The controlled test retained three samples after restart.').length,2);assert.equal(body.split('[F1]').length,3);assert.match(body,/Evidence and review for this finding appear above/);
});
test('research survives fresh sessions, cancellation, restart and SQLite snapshot restore without replay',async t=>{
 const f=await fixture(t);const {source}=await evidence(f);await draft(f);
 f.store.rotateSession('123');assert.equal((await f.service.tool(f.main,'research_read',{id:f.id,source_id:source.id})).id,source.id);
 await assert.rejects(f.service.tool(f.cap,'research_plan',{scope:'Stale',questions:['Question'],criteria:'Primary'}));
 f.store.recover();assert.equal(f.service.research.dossier(f.id).execution_state,'interrupted');assert.equal(f.service.research.read({id:f.id}).claims.length,1);
 assert.equal(f.store.prepare("SELECT count(*) AS n FROM jobs WHERE $scope AND state='queued'").get().n,0);
 const {backup}=await import('node:sqlite');const file=path.join(f.workspace,'restored.sqlite');await backup(f.store.db,file);
 const restored=new Store(file);restored.bindConversation('123');const research=new Research(f.cfg,restored);assert.equal(research.read({id:f.id}).sources[0].id,source.id);restored.db.close();
});
test('end-to-end service reviews separately and queues immutable PDF/Markdown on original route',async t=>{
 const f=await fixture(t);let runs=0;
 f.service.agent.run=async(_user,_prompt,profile,_images,_signal,_save,_resume,internal)=>{
  runs++;if(internal==='research-validation'){assert.equal(profile,'research');return review;}
  assert.equal(profile,'deep_research');await evidence(f);await draft(f);return {text:'Ignored draft completion',files:[],voice:false};
 };
 await f.service.runJob(f.job,new AbortController());assert.equal(runs,2);
 const completed=f.store.jobs('123',f.id)[0];assert.equal(completed.state,'completed');assert.equal(completed.goal_outcome.goal,'partial');
 const rows=f.store.db.prepare('SELECT * FROM outbox ORDER BY id').all();const files=rows.filter(r=>JSON.parse(r.payload).type==='file');assert.equal(files.length,2);assert.ok(files.every(r=>r.artifact_id&&r.conversation_id===f.job.conversation_id&&r.session_id===f.job.session_id));
 const calls=[];f.service.telegram=new Telegram('unused',async()=>{throw new Error('Unexpected network');});f.service.telegram.call=async(method,data)=>{calls.push({method,data});return {message_id:2};};
 await fs.writeFile(f.service.research.report(f.id).files[1],'Changed after queueing');await f.service.deliver();
 const documents=calls.filter(c=>c.method==='sendDocument');assert.equal(documents.length,2);assert.match(await documents[1].data.get('document').text(),/Sample retention comparison/);
 assert.ok(f.store.db.prepare('SELECT state FROM outbox').all().every(r=>r.state==='sent'));
});
test('review failure retains evidence and draft without publishing a report',async t=>{
 const f=await fixture(t);let runs=0;
 f.service.agent.run=async(_user,_prompt,_profile,_images,_signal,_save,_resume,internal)=>{
  runs++;if(internal==='research-validation')return {...review,decisions:[]};
  await evidence(f);await draft(f);return {text:'Draft',files:[],voice:false};
 };
 await f.service.runJob(f.job,new AbortController());assert.equal(runs,2);
 assert.equal(f.store.jobs('123',f.id)[0].state,'failed');
 const d=f.service.research.read({id:f.id});assert.equal(d.claims.length,1);assert.equal(d.report.review,null);assert.deepEqual(d.report.files,[]);
 assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM outbox WHERE json_extract(payload,'$.type')='file'").get().n,0);
});
test('dossiers are conversation scoped by default and cannot be reassigned to another owner',async t=>{
 const f=await fixture(t);await evidence(f);
 const other=new Store(f.store.file);other.bindConversation('123',{id:randomUUID(),chatId:'123',kind:'topic',messageThreadId:1,sessionId:randomUUID()});t.after(()=>other.db.close());
 const research=new Research(f.cfg,other);
 assert.equal(research.read({id:f.id}),null);assert.deepEqual(research.search({query:'retention'}),[]);
 assert.equal(research.read({id:f.id,scope:'all'}).id,f.id);assert.equal(research.search({query:'retention',scope:'all'})[0].id,f.id);
 assert.throws(()=>new Research({...f.cfg,owner:'124'},f.store),/another owner/);
});
test('deep research observation receipts preserve their actual profile and tool scope',async t=>{
 const f=await fixture(t),o=f.store.observations,r=o.run();
 const a=o.attempt(r,f.service.effectiveSettings('deep_research'),'deep_research');o.finishAttempt(a,'completed',{input_tokens:1,output_tokens:1});
 const receipt=JSON.parse(f.store.db.prepare('SELECT payload FROM attempt_observations WHERE id=?').get(a.id).payload);
 assert.equal(receipt.profile,'deep_research');assert.equal(receipt.settings.toolScope,'research');
});
test('public-source fetch denies internal addresses and pins validated DNS across redirects',async()=>{
 for(const address of ['127.0.0.1','10.1.2.3','169.254.169.254','172.16.1.1','192.168.1.1','100.64.1.1','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(publicAddress(address),false,address);
 assert.equal(publicAddress('93.184.216.34'),true);assert.throws(()=>sourceUrl('file:///etc/passwd'));assert.throws(()=>sourceUrl('https://name:secret@example.org/'));assert.throws(()=>sourceUrl('http://localhost/'));
 let calls=0;
 await assert.rejects(fetchResearchSource('https://example.org/',undefined,{lookup:async()=>[{address:'127.0.0.1',family:4}],request:()=>{calls++;}}));assert.equal(calls,0);
 const request=(_url,options,onResponse)=>{const req=new EventEmitter();req.setTimeout=()=>{};req.end=()=>{options.lookup('example.org',{},(_error,address)=>assert.equal(address,'93.184.216.34'));const res=new EventEmitter();res.statusCode=302;res.headers={location:'http://127.0.0.1/private'};res.resume=()=>{};onResponse(res);};return req;};
 await assert.rejects(fetchResearchSource('https://example.org/',undefined,{lookup:async()=>[{address:'93.184.216.34',family:4}],request}));
});
test('public-source streaming enforces size and follows bounded public redirects only',async()=>{
 const lookup=async()=>[{address:'93.184.216.34',family:4}];let calls=0;
 const request=(_url,_options,onResponse)=>{calls++;const req=new EventEmitter();req.setTimeout=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'text/plain'};res.destroy=()=>{};onResponse(res);res.emit('data',Buffer.alloc(SOURCE_MAX_BYTES+1));res.emit('end');};return req;};
 await assert.rejects(fetchResearchSource('https://example.org/',undefined,{lookup,request}),/too large/);assert.equal(calls,1);
});
