import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Agent } from '../src/agent.js';
import path from 'node:path';
import { lstat, readdir, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Codex } from '@openai/codex-sdk';
const [socketPath, home, model] = process.argv.slice(2);
assert.equal(process.platform, 'linux');
assert.equal(process.argv.length, 5);
assert.match(model ?? '', /^[a-zA-Z0-9._-]{1,60}$/);
assert.ok(path.isAbsolute(socketPath ?? '') && path.isAbsolute(home ?? ''));
const codexHome = await realpath(home);
assert.match(codexHome, /^\/tmp\/codex-auth-proof\.[A-Za-z0-9]+\/home$/);
assert.equal((await lstat(codexHome)).mode & 0o077, 0);
assert.deepEqual(await readdir(codexHome), ['auth.json']);
assert.ok((await lstat(path.join(codexHome, 'auth.json'))).isFile());
const socket = await lstat(socketPath);
assert.ok(socket.isSocket() && socket.uid === 0 && (socket.mode & 0o777) === 0o600);
await writeFile(path.join(codexHome, 'environments.toml'), [
  'default="isolated-worker"', 'include_local=false', '[[environments]]', 'id="isolated-worker"',
  `program=${JSON.stringify(process.execPath)}`,
  `args=${JSON.stringify([fileURLToPath(new URL('./isolated-executor-stdio.js', import.meta.url)), socketPath])}`,
].join('\n'), {mode:0o600,flag:'wx'});
const cfg=config({WORKSPACE_DIR:path.resolve(codexHome,'../workspace'),CODEX_HOME:codexHome,TELEGRAM_ALLOWED_USER_IDS:'123',RESEARCH_MODEL:model,LEARNING_ENABLED:'false',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',BROWSER_ENABLED:'false'});
const store=new Store(':memory:');
const service=new Service(cfg,store,{},{});
let phase='fixture';
let bridgeRead=false;
let shellRead=false;
let shellCalls=0;
try {
  await service.init();
  const marker='ASSISTANT_BRIDGE_'+crypto.randomUUID();
  store.history('123','user',marker,'123');
  await service.listen();
  const call=service.tool.bind(service);
  service.tool=async (cap,name,args)=>{
    const result=await call(cap,name,args);
    if(name==='history_search')bridgeRead ||= JSON.stringify(result).includes(marker);
    return result;
  };
  let issuedCapability;
  const capability=(...args)=>(issuedCapability=service.capability(...args));
  capability.release=id=>service.releaseCapability(id);
  const agent=new Agent(cfg,store,capability,options=>{
    const url=`http://127.0.0.1:${service.server.address().port}/mcp`;
    const bridge=`mcp_servers.assistant={url=${JSON.stringify(url)},http_headers={Authorization=${JSON.stringify('Bearer '+issuedCapability)}},required=true}`;
    // The bearer capability stays with loopback MCP in the harness.
    const sdk=new Codex({...options,configOverrides:[...options.configOverrides.filter(value=>!value.startsWith('mcp_servers.assistant=')),bridge]});
    const start=sdk.startThread.bind(sdk);
    sdk.startThread=opts=>{
      // Native shell runs in the independently contained remote executor.
      const thread=start({...opts,workingDirectory:'/tmp',sandboxMode:'danger-full-access'});
      const run=thread.runStreamed.bind(thread);
      thread.runStreamed=async (...args)=>{
        const {events}=await run(...args);
        return {events:(async function*(){
          for await(const event of events){
            if(event.type==='item.completed'&&event.item?.type==='command_execution'){
              shellCalls++;
              shellRead ||=event.item.exit_code===0&&String(event.item.aggregated_output).includes('RUNNER_PATH=/workspace');
            }
            yield event;
          }
        })()};
      };
      return thread;
    };
    return sdk;
  });
  phase='deployed_sdk_remote_http_bridge_turn';
  const result=await agent.run('123','Use the assistant history_search tool with an empty query for the synthetic marker, then use the shell tool to run precisely: cd /workspace && printf \"RUNNER_PATH=%s\\n\" \"$(pwd)\". Return both tool results. These are read-only diagnostic steps. If either tool is unavailable, say so.','research',[],AbortSignal.timeout(60000),()=>{},undefined,false,{toolScope:'read'});
  const returnedMarker=String(result.text??'').includes(marker);
  const revoked=service.capabilities.size===0;
  const passed=bridgeRead&&returnedMarker&&shellRead&&revoked;
  const answerReportsUnavailable=/unavailable|no (?:shell|terminal)|cannot (?:run|execute)|don.t have access/i.test(result.text??'');
  console.log(JSON.stringify({phase,outcome:passed?'passed':'unverified',bridgeRead,returnedMarker,shellRead,shellCalls,answerReportsUnavailable,revoked}));
  if(!passed)process.exitCode=1;
} catch {
  console.error(JSON.stringify({outcome:'unverified',phase,bridgeRead,shellRead,shellCalls}));
  process.exitCode=1;
} finally {
  if(service.server?.listening)await new Promise(resolve=>service.server.close(resolve));
  store.db.close();
}
