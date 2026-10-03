import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec=promisify(execFile);
const reference=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}@[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

// Never forward CLI output/errors: connection flows can include private details.
export async function reconcilePlugins(cfg,{signal,run,binary=path.resolve('node_modules/.bin/codex'),report=()=>{}}={}) {
  if(!cfg.pluginsFile)return [];
  let wanted;
  try {
    const bytes=await fs.readFile(cfg.pluginsFile);
    if(bytes.length>32768)throw new Error();
    wanted=JSON.parse(bytes.toString('utf8'));
    if(!Array.isArray(wanted)||wanted.length>20||wanted.some(p=>typeof p!=='string'||!reference.test(p)))throw new Error();
    wanted=[...new Set(wanted)];
  } catch(error) {
    if(error.code==='ENOENT'&&!cfg.pluginsFileRequired)return [];
    const results=[{status:'configuration failed'}];report(results);return results;
  }
  if(!wanted.length)return [];
  const bounded=AbortSignal.any([AbortSignal.timeout(180000),...(signal?[signal]:[])]);
  const execute=run|| (async args=>{
    const command=exec(binary,[
      '-c','forced_login_method="chatgpt"','-c','cli_auth_credentials_store="file"','plugin',...args
    ],{cwd:cfg.codexHome,env:{PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:cfg.codexHome},
      signal:bounded,timeout:90000,killSignal:'SIGKILL',maxBuffer:4*1024*1024});
    const closed=new Promise(resolve=>command.child.once('close',resolve));
    try {const {stdout}=await command;return JSON.parse(stdout);}
    finally {await closed;}
  });
  let installed;
  try {
    const listed=await execute(['list','--json'],bounded);
    if(!Array.isArray(listed?.installed))throw new Error();
    installed=new Map(listed.installed.map(p=>[p.pluginId,p]));
  } catch {
    const results=wanted.map(plugin=>({plugin,status:bounded.aborted?'interrupted':'lookup failed'}));report(results);return results;
  }
  const results=[];
  for(const plugin of wanted) {
    if(bounded.aborted){results.push({plugin,status:'interrupted'});continue;}
    const existing=installed.get(plugin);
    if(existing) {results.push({plugin,status:existing.enabled===true?'already installed':'disabled'});continue;}
    try {
      const added=await execute(['add',plugin,'--json'],bounded);
      if(added?.pluginId!==plugin)throw new Error();
      results.push({plugin,status:'installed'});
    } catch(error) {
      // Match only the CLI's controlled not-found diagnostic, without exposing it.
      const unavailable=/plugin `[^`]+` was not found in (?:remote )?marketplace/.test(error.stderr||'');
      results.push({plugin,status:bounded.aborted?'interrupted':unavailable?'unavailable':'installation failed'});
    }
  }
  report(results);return results;
}
