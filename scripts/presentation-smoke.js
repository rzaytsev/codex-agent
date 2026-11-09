// Explicit opt-ins: --model consumes subscription quota; --send delivers two
// examples to this instance's configured owner. Never starts a Telegram poller.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Codex} from '@openai/codex-sdk';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';
import {Agent} from '../src/agent.js';
import {Telegram} from '../src/telegram.js';
import {responsePayloads} from '../src/presentation.js';

const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
assert.ok(args.includes('--output'),'Supply --output DIRECTORY for private receipts');
const output=path.resolve(value('--output')),input=args.includes('--input')?path.resolve(value('--input')):null;
assert.ok(!args.includes('--model')||!input,'Choose saved input or fresh model generation');
const live=config(),send=args.includes('--send');
assert.ok(!send||live.token&&live.owner,'Sending requires this instance token and owner');
await fs.mkdir(output,{recursive:true,mode:0o700});
const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'presentation-smoke-'));
const cfg=config({...process.env,WORKSPACE_DIR:workspace,TELEGRAM_BOT_TOKEN:'',TELEGRAM_ALLOWED_USER_IDS:'123',SEED_DIR:'',MAILBOX_URL:'',MAILBOX_TOKEN:'',MAILBOX_ID:'',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',BROWSER_ENABLED:'false',WORKSPACE_PYTHON_BASE:''});
const store=new Store(path.join(workspace,'synthetic.sqlite')),receipts=[];
let active;
const telegram=new Telegram(live.token);
const originalCall=telegram.call.bind(telegram);
telegram.call=async(method,body,...rest)=>{active.methods.push(method);return originalCall(method,body,...rest);};
const service=new Service(cfg,store,{sendPart:async(_user,payload)=>{
  if(!send)return {message_id:0};
  const result=await telegram.sendPart(live.owner,payload);active.message_id=result.message_id;
  active.has_widget=Boolean(result.widget);active.has_rich_message=Boolean(result.rich_message);
  return result;
}},null);
try {
  await service.init();let results;
  if(input)results=JSON.parse(await fs.readFile(input,'utf8'));
  else if(args.includes('--model')) {
    await service.listen(0);const port=service.server.address().port;
    const capability=(...args)=>service.capability(...args);capability.release=t=>service.releaseCapability(t);
    const sdkFactory=options=>new Codex({...options,configOverrides:options.configOverrides.map(s=>s.startsWith('mcp_servers.assistant=')?s.replace('ASSISTANT_PORT="8765"',`ASSISTANT_PORT="${port}"`):s)});
    service.agent=new Agent(cfg,store,capability,sdkFactory,service.memory,service.learning);
    results=[];
    for(const kind of ['widget','rich']) {
      const prompt=kind==='widget'
        ?'Create a polished, small interactive explanation of exponential backoff in English as presentation kind widget. Include real local buttons to step through attempts (1, 2, 4, 8 seconds) and reset, updating a tiny SVG/bar diagram and text. Use only inline CSS/JS supported by Telegram, theme variables, no external resources, inputs, network or bot queries. Keep it under 500px high at 320px width and under 4KiB zlib. Important points and demo label belong in a concise caption. This is a synthetic presentation test: return the complete HTML in presentation.content; do not use any tools, files, services or delegate.'
        :'Create an attractive concise explanation comparing retry policies as presentation kind rich. Use native Telegram rich Markdown with a 3-column table comparing fixed delay, exponential backoff and backoff with jitter, a formula $d_n=min(2^n,60)$, a source link to https://core.telegram.org/bots/api and a collapsible details block with a practical caveat about idempotent operations. Include a short self-contained plain text fallback and a demo label. This is a synthetic presentation test: return content inline; do not use tools, files, services or delegate.';
      const result=await service.agent.run('123',prompt,'main',[],AbortSignal.timeout(180000),()=>{},undefined,false,{toolScope:'read',settings:cfg.profiles.main});
      assert.equal(result.presentation?.kind,kind,'Model did not select requested presentation');
      assert.equal(responsePayloads(result)[0]?.type,kind,'Model presentation exceeded service limits');
      results.push(result);store.rotateSession('123');
    }
  } else throw new Error('Supply --model or --input FILE');
  assert.equal(results.length,2);
  await fs.writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n',{mode:0o600});
  for(const result of results) {
    const payloads=responsePayloads(result);assert.equal(payloads.length,1);assert.equal(payloads[0].type,result.presentation.kind);
    if(result.presentation.kind==='widget')await fs.writeFile(path.join(output,'widget.html'),result.presentation.content,{mode:0o600});
    active={kind:result.presentation.kind,state:send?'sending':'generated',methods:[]};receipts.push(active);
    await fs.writeFile(path.join(output,'receipts.json'),JSON.stringify(receipts,null,2)+'\n',{mode:0o600});
    await service.output('123',{...result,voice:false,files:[]});await service.deliver();
    const row=store.prepare('SELECT state FROM outbox WHERE $scope ORDER BY id DESC LIMIT 1').get();active.state=send?row.state:'generated';
    await fs.writeFile(path.join(output,'receipts.json'),JSON.stringify(receipts,null,2)+'\n',{mode:0o600});
    assert.equal(row.state,'sent');
    if(send)assert.deepEqual(active.methods,[result.presentation.kind==='widget'?'sendWidget':'sendRichMessage'],'API used fallback rather than requested presentation');
  }
  console.log(JSON.stringify({model:args.includes('--model'),sent:send,receipts}));
} catch {
  console.error('Presentation smoke failed; inspect private receipts. Error details suppressed.');process.exitCode=1;
} finally {
  if(service.server)await new Promise(resolve=>service.server.close(resolve));
  store.db.close();await fs.rm(workspace,{recursive:true,force:true});
}
