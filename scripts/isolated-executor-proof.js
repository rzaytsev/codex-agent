import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountClient } from '../src/codex-account.js';

const [binary, launcherMode, destination] = process.argv.slice(2);
const viaSocket = launcherMode === '--socket';
if (process.argv.length !== 5 || !path.isAbsolute(binary || '') || !path.isAbsolute(destination || '') ||
    (!viaSocket && !/^sha256:[a-f0-9]{64}$/.test(launcherMode || ''))) {
  throw new Error('Expected an absolute Codex path followed by IMAGE_ID LAUNCHER or --socket SOCKET');
}
// The harness is anonymous. The caller must start it with a clean environment.
const root = await mkdtemp('/tmp/runner-proof-');
const quoted = JSON.stringify;
const hostFixture = path.join(root, 'local-control');
const program = viaSocket ? process.execPath : '/usr/bin/sudo';
const args = viaSocket
  ? [fileURLToPath(new URL('./isolated-executor-stdio.js', import.meta.url)), destination]
  : ['-n', destination, launcherMode];
const config = [
  'default = "isolated-worker"', 'include_local = false', '[[environments]]', 'id = "isolated-worker"',
  `program = ${quoted(program)}`, `args = ${quoted(args)}`,
].join('\n');
let client;
let requests=0;
let sawRunnerOutput=false;
const server=createServer(async (req,res)=>{
  try {
    if(req.method!=='POST'||req.url!=='/v1/responses'){res.writeHead(404).end();return;}
    let body='';
    for await(const chunk of req) {body+=chunk;if(body.length>4000000)throw Error('Body too large');}
    const input=JSON.parse(body);
    const ordinal=++requests;
    if(ordinal>2)throw Error('Unexpected model call');
    const id=`response-${ordinal}`;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    function send(type,data) {res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);}
    send('response.created',{response:{id}});
    if(ordinal===1) {
      const tool=input.tools.find(t=>t.name==='exec_command'||t.name==='shell_command');
      if(!tool)throw Error('Tool absent');
      // mkdtemp generated this path from a fixed, shell-safe absolute prefix.
      const command=`test -w /workspace && test ! -e '${hostFixture}' && test "$(ls /sys/class/net)" = lo && printf RUNNER_OK`;
      send('response.output_item.done',{item:{type:'function_call',name:tool.name,arguments:JSON.stringify({cmd:command,workdir:'/workspace'}),call_id:'synthetic-call'}});
    } else {
      sawRunnerOutput=input.input.some(i=>i.type==='function_call_output'&&i.call_id==='synthetic-call'&&JSON.stringify(i.output).includes('RUNNER_OK'));
      send('response.output_item.done',{item:{type:'message',role:'assistant',content:[{type:'output_text',text:'Synthetic fixture complete'}]}});
    }
    send('response.completed',{response:{id,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
    res.end();
  } catch {res.end();}
});
let timer;
try {
  await writeFile(hostFixture,'SYNTHETIC_LOCAL_ONLY',{mode:0o600});
  const codexHome=path.join(root,'codex');
  await mkdir(codexHome,{mode:0o700});
  await writeFile(path.join(codexHome,'environments.toml'),config,{mode:0o600});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  await writeFile(path.join(codexHome,'config.toml'),[
    'model_provider = "synthetic"','model = "gpt-5.4"','web_search = "disabled"',
    '[features]','hooks = false','plugins = false','apps = false',
    '[model_providers.synthetic]','name = "Synthetic local transport"',
    `base_url = "http://127.0.0.1:${server.address().port}/v1"`,'wire_api = "responses"','requires_openai_auth = false',
  ].join('\n'),{mode:0o600});
  client=new AccountClient({codexHome},{binary,timeoutMs:12000});
  await client.initialize();
  const info=await client.request('environment/info',{environmentId:'isolated-worker'});
  assert.equal(info.cwd,'file:///workspace');
  await assert.rejects(client.request('environment/info',{environmentId:'local'}));
  // Docker is the process/filesystem boundary in this synthetic run.
  const {thread}=await client.request('thread/start',{cwd:'/workspace',ephemeral:true,approvalPolicy:'never',sandbox:'danger-full-access',environments:[{cwd:'/workspace',environmentId:'isolated-worker'}]});
  assert.equal(thread.environments?.length,1);
  assert.equal(thread.environments[0].environmentId,'isolated-worker');
  const notification=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>reject(new Error('No turn completion')),16000);
    client.on('notification',message=>{
      if(message.method==='turn/completed'&&message.params?.threadId===thread.id) {
        clearTimeout(timer);
        resolve(message.params.turn);
      }
    });
  });
  const [,turn]=await Promise.all([client.request('turn/start',{threadId:thread.id,input:[{type:'text',text:'Run the synthetic isolation check'}]}),notification]);
  assert.equal(turn.status,'completed');
  assert.equal(requests,2);
  assert.equal(sawRunnerOutput,true);
  assert.equal(await readFile(hostFixture,'utf8'),'SYNTHETIC_LOCAL_ONLY');
  console.log(JSON.stringify({outcome:'protected_fixture',localEnvironmentDisabled:true,offlineExecutor:true,modelRequests:0}));
} catch {
  console.error('Synthetic isolated executor check failed');
  process.exitCode=1;
} finally {
  clearTimeout(timer);
  await client?.close();
  server.closeAllConnections();
  server.close();
  await rm(root,{recursive:true,force:true});
}
