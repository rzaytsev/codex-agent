import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';

const execute=promisify(execFile);
export function groupPermissions(workspace,writable=true) {
  // Linux re-execs the pinned native helper inside its filesystem namespace.
  // Grant only the installed runtime vendor tree, never the application/state.
  const runtime={};
  if(process.platform==='linux') {
    const require=createRequire(import.meta.url);
    let vendor;
    try {vendor=path.join(path.dirname(require.resolve(`@openai/codex-linux-${process.arch}/package.json`)),'vendor');}
    catch {vendor=path.resolve('node_modules/@openai/codex/vendor');}
    runtime[realpathSync(vendor)]='read';
  }
  return {default_permissions:'conversation',permissions:{conversation:{filesystem:{':root':'deny',':minimal':'read',':tmpdir':'deny',':slash_tmp':'deny',...runtime,[workspace]:'read',...Object.fromEntries((writable?['outputs','projects','tasks']:[]).map(dir=>[path.join(workspace,dir),'write'])),[path.join(workspace,'.codex')]:'deny','/proc':'deny','/sys':'deny'},network:{enabled:false}}},features:{apps:false,plugins:false,hooks:false,multi_agent:false,multi_agent_v2:false,browser_use:false,browser_use_external:false,in_app_browser:false,code_mode:false,code_mode_host:true,shell_snapshot:false},project_doc_max_bytes:0,projects:{[workspace]:{trust_level:'untrusted'}}};
}

// No real-model call. A host that cannot enforce deny-read stays unavailable.
export async function probeGroupSandbox(cfg,executeFile=execute) {
  if(!['linux','darwin'].includes(process.platform))return false;
  const marker=path.join(cfg.groupState,'probe-private'),link=path.join(cfg.workspace,'outputs','probe-link');
  await fs.writeFile(marker,'synthetic isolation marker',{mode:0o600});
  await fs.symlink(marker,link);
  const listener=http.createServer((_,res)=>res.end('synthetic probe'));
  try {await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});}
  catch {await fs.rm(link,{force:true});await fs.rm(marker,{force:true});return false;}
  const profile=groupPermissions(cfg.workspace);
  const quote=value=>`'${value.replace(/'/g,"'\\''")}'`;
  const output=path.join(cfg.workspace,'outputs','probe-output');
  // Bubblewrap creates empty parent scaffolding for allowed mounts; test actual
  // private directories rather than requiring those synthetic parents to vanish.
  const script=[...([marker,link,'/proc/self/environ'].map((file,i)=>`if /bin/cat ${quote(file)} >/dev/null 2>&1; then printf 'Unexpected read ${i}\\n' >&2; exit 1; fi`)),...([cfg.codexHome,cfg.groupState].map((dir,i)=>`if /bin/ls ${quote(dir)} >/dev/null 2>&1; then printf 'Unexpected listing ${i}\\n' >&2; exit 1; fi`)),`printf ok > ${quote(output)} || exit 1`,`/bin/rm ${quote(output)} || exit 1`,`if /usr/bin/curl --silent --max-time 2 http://127.0.0.1:${listener.address().port}/ >/dev/null 2>&1; then printf 'Unexpected network access\\n' >&2; exit 1; fi`,`printf isolated`].join('\n');
  const args=['-c',`permissions.conversation.filesystem={${Object.entries(profile.permissions.conversation.filesystem).map(([k,v])=>`${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}}`,'-c','permissions.conversation.network.enabled=false','sandbox','--permission-profile','conversation','--','/bin/sh','-c',script];
  try {
    const result=await executeFile(process.execPath,[path.resolve('node_modules/@openai/codex/bin/codex.js'),...args],{cwd:cfg.workspace,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:cfg.workspace,CODEX_HOME:cfg.codexHome},timeout:15000,maxBuffer:16384});
    return result.stdout.trim()==='isolated';
  } catch {return false;}
  finally {await new Promise(resolve=>listener.close(resolve));await fs.rm(link,{force:true});await fs.rm(marker,{force:true});}
}
