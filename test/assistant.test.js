import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, authorized, quiet } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service, dueTime, nextCron } from '../src/service.js';
import { Telegram, TelegramError, chunks, format } from '../src/telegram.js';
import { workspaceFile } from '../src/media.js';
async function fixture(t,override={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-test-'));
 const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',WORKSPACE_DIR:dir,CODEX_HOME:path.join(dir,'codex'),CLEANUP_ENABLED:'false',...override});
 const store=new Store(path.join(dir,'test.sqlite'));
 const delivered=[];const telegram={sendPart:async(u,p)=>delivered.push({u,p})};
 const agent={run:async()=>({text:'Done',voice:false,files:[]})};
 const service=new Service(cfg,store,telegram,agent);await service.init();
 t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,cfg,store,service,delivered};
}
const update=(id=1,user=123,text='hello')=>({update_id:id,message:{message_id:id,date:1,from:{id:user},chat:{id:user,type:'private'},text}});
test('allowlist fails closed before persisting input; groups and bot senders rejected',async t=>{
 const {service,store,cfg}=await fixture(t);
 for(const user of [124,0]) assert.equal(service.ingest(update(1,user)),false);
 assert.equal(authorized({...update().message,chat:{id:-123,type:'group'}},cfg),false);
 assert.equal(authorized({...update().message,from:{id:123,is_bot:true}},cfg),false);
 assert.equal(authorized(update().message,config({})),false);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM inputs').get().n,0);
 assert.throws(()=>config({TELEGRAM_ALLOWED_USER_IDS:'@name'}));
});
test('duplicate update creates one input and one set of reflection schedules',async t=>{
 const {service,store}=await fixture(t);
 assert.equal(service.ingest(update()),true);assert.equal(service.ingest(update()),false);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM inputs').get().n,1);
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM schedules WHERE kind='review'").get().n,3);
 assert.equal(store.db.prepare("SELECT count(*) AS n FROM schedules WHERE kind='memory'").get().n,2);
});
test('one-shot schedule persists, deduplicates and fires only once',async t=>{
 const {service,store}=await fixture(t);const args={kind:'reminder',prompt:'remember',due:new Date(Date.now()+60000).toISOString(),key:'a'};
 const a=await service.tool({user:'123'},'schedule',args);const b=await service.tool({user:'123'},'schedule',args);assert.equal(a.id,b.id);
 service.schedules(a.due+1);service.schedules(a.due+2);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,1);
 assert.equal(store.db.prepare('SELECT enabled FROM schedules').get().enabled,0);
});
test('invalid scheduling times rejected and cron respects timezone',()=>{
 assert.throws(()=>dueTime({due:'2027-01-01T09:00:00'},'Europe/Madrid'));
 assert.throws(()=>dueTime({due:'2027-01-01T09:00:00Z',cron:'0 9 * * *'},'Europe/Madrid'));
 assert.equal(new Date(nextCron('0 9 * * *','Europe/Madrid',Date.parse('2026-09-30T00:00:00Z'))).toISOString(),'2026-09-30T07:00:00.000Z');
});
test('restart does not replay uncertain external execution or delivery',async t=>{
 const {store}=await fixture(t);store.ingest(1,'123',{});store.db.exec("UPDATE inputs SET state='processing'");
 const id=store.job('123','write external','worker');store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
 store.enqueue('123',{text:'sent maybe'});store.db.exec("UPDATE outbox SET state='sending'");store.recover();
 assert.equal(store.db.prepare('SELECT state FROM inputs').get().state,'interrupted');
 assert.equal(store.db.prepare('SELECT state FROM jobs WHERE id=?').get(id).state,'interrupted');
 assert.equal(store.db.prepare('SELECT state FROM outbox WHERE id=1').get().state,'uncertain');
});
test('worker restrictions and cross-account task cancellation enforced',async t=>{
 const {service,store}=await fixture(t,{TELEGRAM_ALLOWED_USER_IDS:'123'});
 await assert.rejects(service.tool({user:'123',worker:true},'create_task',{prompt:'x'}));
 const id=store.job('456','x');let aborted=false;service.controllers.set(id,{abort:()=>aborted=true});
 const result=await service.tool({user:'123'},'cancel_task',{id});assert.equal(result.cancelled,false);assert.equal(aborted,false);
});
test('conversation records successful output; failure remains failed and not replayed',async t=>{
 const {service,store}=await fixture(t,{PROACTIVE_ENABLED:'false'});
 service.ingest(update());await service.conversation();assert.equal(store.db.prepare('SELECT state FROM inputs').get().state,'done');
 assert.equal(store.search('123').at(-1).text,'Done');
 service.agent.run=async()=>{throw new Error('secret-value-not-logged');};service.ingest(update(2));await service.conversation();
 assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=2').get().state,'failed');
});
test('delivery rejects revoked users; uncertain network outcome is not blindly retried',async t=>{
 const {service,store,delivered}=await fixture(t);store.enqueue('456',{text:'private'});store.enqueue('123',{text:'hello'});await service.deliver();
 assert.equal(delivered.length,1);assert.equal(delivered[0].u,'123');
 service.telegram.sendPart=async()=>{throw new TelegramError('network');};store.enqueue('123',{text:'maybe'});await service.deliver();
 assert.equal(store.db.prepare('SELECT state FROM outbox ORDER BY id DESC LIMIT 1').get().state,'uncertain');
});
test('profile update is atomic and disallows arbitrary target paths',async t=>{
 const {service,dir}=await fixture(t);await service.tool({user:'123'},'profile_write',{file:'USER.md',content:'Name: Test'});
 assert.equal(await fs.readFile(path.join(dir,'USER.md'),'utf8'),'Name: Test');
 await assert.rejects(service.tool({user:'123'},'profile_write',{file:'../x',content:'bad'}));
});
test('output file confinement rejects symlinks and traversal',async t=>{
 const {dir}=await fixture(t);await fs.writeFile(path.join(dir,'outputs','a.txt'),'a');
 assert.equal(await workspaceFile(dir,'outputs/a.txt'),await fs.realpath(path.join(dir,'outputs','a.txt')));
 await fs.symlink('/etc/hosts',path.join(dir,'outputs','link'));
 await assert.rejects(workspaceFile(dir,'outputs/link'));await assert.rejects(workspaceFile(dir,'../../etc/hosts'));
});
test('formatter escapes malicious markup and splits long Unicode safely',()=>{
 assert.equal(format('**Hi** <x> & `code`'),'<b>Hi</b> &lt;x&gt; &amp; <code>code</code>');
 const text='😀'.repeat(6001);assert.equal(chunks(text).join(''),text);assert.equal(chunks(text).length,5);
 const cfg=config({});assert.equal(quiet(cfg,new Date('2026-09-30T22:00:00Z')),true);
});
test('Telegram errors never contain token or upstream response body',async()=>{
 const tg=new Telegram('SECRET',async()=>({json:async()=>({ok:false,error_code:401,description:'SECRET'})}));
 await assert.rejects(tg.call('getMe',{}),e=>!e.message.includes('SECRET')&&e.code===401);
});
test('image/forward intake preserves original provenance for later lookup',async t=>{
 const {dir,cfg}=await fixture(t);const {prepare}=await import('../src/media.js');
 const message={...update().message,text:undefined,caption:'Compare this later',photo:[{file_id:'small'},{file_id:'large'}],forward_origin:{type:'hidden_user',sender_user_name:'Original source'}};
 const tg={download:async(id,dest)=>{assert.equal(id,'large');await fs.writeFile(dest,'image fixture');}};
 const result=await prepare(message,11,cfg,tg);
 assert.equal(result.images.length,1);assert.match(result.text,/Forward provenance/);assert.match(result.text,/Compare this later/);
 assert.equal(JSON.parse(await fs.readFile(path.join(dir,'inbox/11/message.json'),'utf8')).forward_origin.sender_user_name,'Original source');
});
test('quiet hours delay reflections, not requested reminders',async t=>{
 const {service,store,delivered}=await fixture(t,{QUIET_START_HOUR:0,QUIET_END_HOUR:23});
 // Pin quiet policy to cover current local hour except an explicit hour outside the fixture.
 const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:service.cfg.timezone,hour:'2-digit',hourCycle:'h23'}).format(new Date()));
 service.cfg.quietStart=hour;service.cfg.quietEnd=(hour+1)%24;
 store.enqueue('123',{text:'reflection'},true);store.enqueue('123',{text:'reminder'},false);await service.deliver();
 assert.deepEqual(delivered.map(x=>x.p.text),['reminder']);
});

test('Telegram command menu replaces old commands in default, private and allowed-user scopes',async()=>{
 const calls=[];const telegram=new Telegram('unused');
 telegram.call=async(method,body)=>{calls.push({method,body});return true;};
 await telegram.registerCommands(new Set(['123','456']));
 assert.deepEqual(calls.map(c=>c.body.scope),[{type:'default'},{type:'all_private_chats'},{type:'chat',chat_id:'123'},{type:'chat',chat_id:'456'}]);
 for(const call of calls) {
  assert.equal(call.method,'setMyCommands');
  assert.deepEqual(call.body.commands.map(c=>c.command),['help','auth','tdl_auth','usage','status','new','cancel','stop','location']);
 }
 telegram.call=async()=>{throw new TelegramError(429);};
 await assert.rejects(telegram.registerCommands(new Set()),TelegramError);
});

test('screenshots enter the photo queue and Telegram falls back to document for rejected dimensions',async t=>{
 const {dir,service,store}=await fixture(t);
 const screenshot=path.join(dir,'outputs','shot.png');await fs.writeFile(screenshot,Buffer.from([137,80,78,71]));
 await service.output('123',{text:'',files:[screenshot]});
 const payload=JSON.parse(store.db.prepare('SELECT payload FROM outbox').get().payload);assert.equal(payload.type,'photo');
 const telegram=new Telegram('unused');const calls=[];
 telegram.call=async(method,body)=>{calls.push({method,body});if(method==='sendPhoto')throw new TelegramError(400);return true;};
 await telegram.sendPart('123',payload);
 assert.deepEqual(calls.map(c=>c.method),['sendPhoto','sendDocument']);assert.equal(calls[0].body.get('chat_id'),'123');assert.equal(calls[0].body.get('photo').name,'shot.png');assert.equal(calls[1].body.get('document').name,'shot.png');
 telegram.call=async()=>{throw new TelegramError('network');};
 await assert.rejects(telegram.sendPart('123',payload),TelegramError);
});
