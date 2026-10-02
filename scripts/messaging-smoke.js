// Authorized real-model smoke in synthetic workspaces. No Telegram token/poller.
// Requires the image's existing ChatGPT CODEX_HOME. Consumes model quota.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Agent } from '../src/agent.js';
import { Mailbox, mailboxServer } from '../src/mailbox.js';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'agent-mail-model-'));
const broker=new Mailbox(path.join(root,'mail.sqlite'),{identities:{alpha:{token:'a'.repeat(32),peers:['beta']},beta:{token:'b'.repeat(32),peers:['alpha']}}});
const server=mailboxServer(broker);await new Promise(r=>server.listen(0,'127.0.0.1',r));
const services=[];
try {
  for(const [index,name] of ['alpha','beta'].entries()) {
    const workspace=path.join(root,name);await fs.mkdir(workspace);
    const cfg=config({WORKSPACE_DIR:workspace,CODEX_HOME:process.env.CODEX_HOME,TELEGRAM_ALLOWED_USER_IDS:String(101+index),MAILBOX_ID:name,MAILBOX_URL:`http://127.0.0.1:${server.address().port}`,MAILBOX_TOKEN:(index?'b':'a').repeat(32),BROWSER_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',PROACTIVE_ENABLED:'false',MAIN_MODEL:process.env.MAIN_MODEL||'',WORKER_MODEL:process.env.MAIN_MODEL||'',MAIN_REASONING:'low',WORKER_REASONING:'low'});
    const store=new Store(path.join(workspace,'assistant.sqlite'));
    const service=new Service(cfg,store,{},null);
    const capability=(...args)=>service.capability(...args);capability.release=t=>service.releaseCapability(t);
    service.agent=new Agent(cfg,store,capability,undefined,service.memory);await service.init();services.push(service);
  }
  const [alpha,beta]=services,id=randomUUID();
  await alpha.listen();
  await alpha.agent.run(alpha.cfg.owner,`This is an authorized synthetic messaging test. Use mail_agents, then mail_send exactly once with id ${id}, to beta, kind task_request, text "Return the exact text MAILBOX_SMOKE_DONE. Do not use external tools or accounts.", context "Synthetic acceptance check". Do not use create_task or other tools. Report the queued state.`, 'main',[],AbortSignal.timeout(120000));
  await alpha.mail.tick(true);await beta.mail.tick(true);
  assert.equal(broker.record(id)?.state,'pending_acceptance');
  assert.equal(beta.store.jobs(beta.cfg.owner).length,0);
  await new Promise(r=>alpha.server.close(r));
  await beta.listen();
  beta.ingest({update_id:1,message:{message_id:1,date:1,from:{id:102},chat:{id:102,type:'private'},text:`/mail accept ${id}`}});
  const job=beta.store.db.prepare('SELECT * FROM jobs WHERE id=?').get(beta.mail.read(id).job_id);
  assert(job);await beta.mail.tick(true);
  beta.store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(job.id);
  await beta.runJob(job,new AbortController());await beta.mail.tick(true);
  assert.equal(broker.record(id).state,'completed');
  await beta.agent.run(beta.cfg.owner,`This is an authorized synthetic messaging test. Read incoming request ${id} using mail_read. Send exactly one mail_send reply to alpha, reply_to ${id}, id ${randomUUID()}, text "MAILBOX_SMOKE_REPLY". Do not use any other tools.`, 'main',[],AbortSignal.timeout(120000));
  await beta.mail.tick(true);await alpha.mail.tick(true);
  assert(alpha.mail.inbox().some(r=>r.kind==='reply'&&r.reply_to===id&&r.text==='MAILBOX_SMOKE_REPLY'));
  console.log(JSON.stringify({realModelSend:true,ownerAcceptanceRequired:true,realWorkerCompleted:true,realModelReply:true,telegramUsed:false}));
} catch {console.error('Messaging model smoke failed; private model output suppressed');process.exitCode=1;}
finally {
  for(const service of services){if(service.server?.listening)await new Promise(r=>service.server.close(r));service.store.db.close();}
  await new Promise(r=>server.close(r));broker.db.close();await fs.rm(root,{recursive:true,force:true});
}
