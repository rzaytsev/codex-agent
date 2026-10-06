import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Fixed reviewed metadata only: runtime paths, random selection IDs and SDK
// credentials/config are deliberately excluded from observation bundle hashes.
export const restrictedReadDefinition=Object.freeze({version:2,mode:'restricted_read_prototype',filesystem:'minimal_and_exact_runtime',applicationInputs:false,network:false,shellEnvironment:'verified_fixed_path_lang_plus_runtime_thread_id',mcp:'verified_assistant_only',configuration:'bounded_pinned_effective_config_preflight',thread:'fresh_every_attempt'});
export const restrictedShellEnvironment=Object.freeze({PATH:'/usr/bin:/bin',LANG:'C.UTF-8'});

export async function restrictedReadOverrides() {
 const runtime=await fs.realpath(process.execPath);
 const filesystem={':minimal':'read',[runtime]:'read',...(process.platform==='darwin'?{'/System/Library/OpenSSL/openssl.cnf':'read'}:{})};
 // Fresh names avoid merging a lower configured same-name profile or resuming
 // a persisted privileged selection. There is no operator-supplied root list.
 const name=`assistant_restricted_read_${randomUUID().replaceAll('-','')}`;
 return [
  `default_permissions=${JSON.stringify(name)}`,
  `permissions={${name}={filesystem={${Object.entries(filesystem).map(([key,value])=>`${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',')}},network={enabled=false}}}`,
  `shell_environment_policy={inherit="none",ignore_default_excludes=true,exclude=[],include_only=["PATH","LANG"],experimental_use_profile=false,set={PATH=${JSON.stringify(restrictedShellEnvironment.PATH)},LANG=${JSON.stringify(restrictedShellEnvironment.LANG)}}}`
 ];
}

export async function createRestrictedWorkspace(cfg) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-restricted-read-'));
 try {
  const canonical=await fs.realpath(directory);
  for(const root of [cfg.workspace,cfg.codexHome]) {
   const resolved=await fs.realpath(root).catch(error=>{if(error.code==='ENOENT')return path.resolve(root);throw error;});
   const relative=path.relative(resolved,canonical);
   if(relative===''||(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative)))throw new Error('Restricted task cwd overlaps service or auth');
  }
  await fs.chmod(directory,0o700);
  return directory;
 } catch(error) {await fs.rm(directory,{recursive:true,force:true});throw error;}
}
