import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Conversations } from '../src/conversations.js';

// Run only in a dedicated synthetic workspace with its own host broker.
// Never polls or sends Telegram; --model consumes one authenticated model turn.
if(!process.env.GROUP_EXECUTOR_SOCKET||!process.env.GROUP_EXECUTOR_SMOKE)throw new Error('Synthetic executor workspace required');
const cfg=config({...process.env,TELEGRAM_BOT_TOKEN:'',TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',BROWSER_ENABLED:'false',WORKSPACE_PYTHON_BASE:''});
const store=new Store(path.join(cfg.workspace,'state/assistant.sqlite'));
const service=new Service(cfg,store,{sendPart:async()=>{}},null);
await service.init();await service.listen();
const router=new Conversations(service);service.conversations=router;router.username='synthetic_bot';
try {
  await router.init();
  await router.ingest({update_id:1,message:{message_id:1,date:1,from:{id:123},chat:{id:-123,type:'group',title:'Synthetic acceptance'},text:'/link@synthetic_bot',entities:[{type:'bot_command',offset:0,length:19}]}});
  const group=[...router.services.values()][0];
  if(!group?.cfg.sandboxReady)throw new Error('Executor isolation probe failed');
  console.log(JSON.stringify({executorProbe:true,credentialsMountedIntoExecutor:false,telegramSent:false}));
  if(process.argv.includes('--model')) {
    group.store.rotateSession('123');
    const observations=[],factory=group.agent.sdkFactory;
    group.agent.sdkFactory=options=>{
      const sdk=factory(options);
      const wrap=thread=>{const run=thread.runStreamed.bind(thread);thread.runStreamed=async(...args)=>{
        const result=await run(...args);return {...result,events:(async function*(){for await(const event of result.events){if(event.type==='item.completed'&&['command_execution','mcp_tool_call'].includes(event.item.type))observations.push(event.item);yield event;}})()};
      };return thread;};
      return {startThread:opts=>wrap(sdk.startThread(opts)),resumeThread:(id,opts)=>wrap(sdk.resumeThread(id,opts))};
    };
    const settings=group.effectiveSettings('main'),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
    try {
      const result=await group.agent.run('123',`Synthetic acceptance. Use a shell tool to verify that /data/codex/auth.json, /workspace/USER.md, /workspace/state and /var/run/docker.sock are inaccessible. Write exactly ISOLATED to ${group.cfg.workspace}/outputs/accepted.txt. Use the assistant MCP memory_search tool with an empty query. Only after those tools succeed, return text EXECUTOR_ACCEPTED, voice false, and accepted.txt in files. Do not claim success without executing those tools.`, 'main',[],controller.signal,()=>{},undefined,false,{conversationId:group.cfg.group.id,sessionId:group.store.get('main-session'),actorId:'123',settings});
      await fs.writeFile(path.join(cfg.workspace,'state/model-probe.json'),JSON.stringify({result,observations}),{mode:0o600});
      if(result.text!=='EXECUTOR_ACCEPTED'||(await fs.readFile(path.join(group.cfg.workspace,'outputs/accepted.txt'),'utf8')).trim()!=='ISOLATED'||!observations.some(item=>item.type==='mcp_tool_call'&&item.tool==='memory_search'&&item.status==='completed'))throw new Error('Model executor acceptance failed');
      console.log(JSON.stringify({modelTurn:true,groupFileProduced:true,telegramSent:false}));
    } finally {clearTimeout(timer);}
  }
} finally {await router.stop();await new Promise(resolve=>service.server.close(resolve));for(const current of router.all())current.store.db.close();}
