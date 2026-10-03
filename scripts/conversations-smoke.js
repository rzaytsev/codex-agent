// Subscription-backed synthetic evaluation. No Telegram polling or sending.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Codex } from '@openai/codex-sdk';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Agent } from '../src/agent.js';
import { Conversations } from '../src/conversations.js';
import { Memory } from '../src/memory.js';
import { Learning } from '../src/learning.js';

const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'owner-conversation-smoke-'));
const cfg=config({...process.env,WORKSPACE_DIR:workspace,TELEGRAM_BOT_TOKEN:'',TELEGRAM_ALLOWED_USER_IDS:'123',SEED_DIR:'',MAILBOX_URL:'',MAILBOX_TOKEN:'',MAILBOX_ID:'',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',BROWSER_ENABLED:'false',WORKSPACE_PYTHON_BASE:''});
const store=new Store(path.join(workspace,'state.sqlite')),sent=[];
const dm=new Service(cfg,store,{sendPart:async(chat,payload)=>sent.push({chat,payload})},null);
let router;
try {
  await dm.init();await dm.listen();router=new Conversations(dm);dm.conversations=router;router.username='synthetic_bot';await router.init();
  const token='fixture-'+randomUUID();await fs.writeFile(path.join(workspace,'outputs/shared.txt'),'ROOT_FILE');
  await fs.appendFile(path.join(workspace,'AGENTS.md'),'\nSynthetic evaluation: use only this fixture workspace and assistant tools. Never access credentials or connected services, send messages, schedule or delegate. Begin final text with SHARED_RULE.\n');
  await fs.writeFile(path.join(workspace,'USER.md'),'Synthetic owner. This profile is shared across all chats.\n');
  store.history('123','user',`Synthetic memory token: ${token}`);
  dm.memory.save({key:'synthetic-token',category:'facts',title:'Synthetic token',content:token,certainty:'confirmed',sources:[`history:${store.search('123')[0].id}`],expected_revision:0});
  const groups=[];
  for(const [index,chat] of [-100,-200].entries()) {
    const text='/link@synthetic_bot';await router.ingest({update_id:index+1,message:{message_id:index+1,from:{id:123},chat:{id:chat,type:'group',title:'Synthetic'},text,entities:[{type:'bot_command',offset:0,length:text.length}]}});
    const service=router.services.get(router.find(chat).id);groups.push(service);
    const result=await service.agent.run('123',`Read synthetic-token using assistant memory_read and read ${workspace}/outputs/shared.txt using a native file/command tool. Return only the shared rule prefix, memory token and file contents.`,'main',[],undefined,undefined,undefined,false,{actorId:'123',settings:service.effectiveSettings('main')});
    assert.ok(result.text.startsWith('SHARED_RULE'));assert.ok(result.text.includes(token)&&result.text.includes('ROOT_FILE'));await service.output('123',result);await service.deliver();
  }
  assert.notEqual(groups[0].store.get('thread:123'),groups[1].store.get('thread:123'));
  assert.ok(sent.some(r=>r.chat==='-100'&&r.payload.text?.includes(token)));assert.ok(sent.some(r=>r.chat==='-200'&&r.payload.text?.includes(token)));
  // Create a real saved rollout in a legacy home, then test its migrated resume.
  const id=randomUUID(),sessionId=randomUUID(),base=path.join(workspace,'state/conversations',id),legacyHome=path.join(base,'codex');
  await fs.mkdir(legacyHome,{recursive:true});await fs.symlink(path.join(cfg.codexHome,'auth.json'),path.join(legacyHome,'auth.json'));
  const old=new Store(path.join(base,'assistant.sqlite'));old.bindConversation('123',{id,chatId:'-300',kind:'group',sessionId});new Memory(workspace,old,'123');new Learning(workspace,old,'123');
  const sdk=new Codex({env:{PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:legacyHome,LANG:'C.UTF-8'}}),thread=sdk.startThread({workingDirectory:workspace,skipGitRepoCheck:true,sandboxMode:'danger-full-access',approvalPolicy:'never',modelReasoningEffort:'low',...(cfg.profiles.main.model?{model:cfg.profiles.main.model}:{})});
  const resumeToken='resume-'+randomUUID();await thread.run(`Synthetic evaluation only. Remember this restart marker: ${resumeToken}. Reply OK. Do not use tools.`);
  old.db.prepare('INSERT INTO meta VALUES (?,?)').run('conversation-owner','123');old.db.prepare('INSERT INTO meta VALUES (?,?)').run('thread:123',thread.id);old.db.prepare('UPDATE main_sessions SET thread=?').run(thread.id);old.db.close();
  store.db.prepare('INSERT INTO conversations(id,owner,chat_id,kind,title,session_id) VALUES (?,?,?,?,?,?)').run(id,'123','-300','group','Synthetic legacy',sessionId);
  const resumed=await router.open(router.find(-300));
  const result=await resumed.agent.run('123','Return the shared rule prefix and the restart marker from our previous conversation. Do not use tools.','main',[],undefined,undefined,undefined,false,{actorId:'123',settings:resumed.effectiveSettings('main')});
  assert.ok(result.text.startsWith('SHARED_RULE')&&result.text.includes(resumeToken));assert.equal(resumed.store.get('thread:123'),thread.id);
  console.log(JSON.stringify({sharedMemory:true,sharedRules:true,sharedNativeFiles:true,separateThreads:true,sourceDelivery:true,migratedResume:true}));
} catch {console.error('Shared conversation smoke failed; private details suppressed');process.exitCode=1;}
finally {await router?.stop();await new Promise(resolve=>dm.server?dm.server.close(resolve):resolve());for(const service of router?.all()||[dm])service.store.db.close();await fs.rm(workspace,{recursive:true,force:true});}
