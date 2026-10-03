import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [name,option,dataRoot,...extra]=process.argv.slice(2);
if(!name||!/^[a-z][a-z0-9-]{0,31}$/.test(name)||option!=='--data-root'||!dataRoot||extra.length)
  throw new Error('Usage: node scripts/create-agent.js <name> --data-root <absolute-host-directory>');
if(!path.isAbsolute(dataRoot)||/[\r\n\0'$]/.test(dataRoot))throw new Error('Data root must be an absolute path without quotes, dollars or control characters');
const directory=path.join(root,'private','instances',name);
const resolved=path.resolve(dataRoot);
async function canonicalDestination(value) {
  try {return await fs.realpath(value);}catch(error){
    if(error.code!=='ENOENT')throw error;
    return path.join(await canonicalDestination(path.dirname(value)),path.basename(value));
  }
}
const canonical=await canonicalDestination(resolved),sourceRoot=await fs.realpath(root);
if(canonical===sourceRoot||canonical.startsWith(sourceRoot+path.sep))throw new Error('Runtime data must live outside the source checkout');
await fs.mkdir(path.dirname(directory),{recursive:true,mode:0o700});
await fs.mkdir(directory,{mode:0o700}); // Exclusive: an existing instance is never overwritten.
await fs.mkdir(path.join(directory,'seed'),{mode:0o700});
await fs.copyFile(path.join(root,'templates','plugins.json'),path.join(directory,'seed','plugins.json'));
await fs.chmod(path.join(directory,'seed','plugins.json'),0o600);
const base=await fs.readFile(path.join(root,'templates','agent.env.example'),'utf8');
const content=base.replace(/^AGENT_NAME=.*$/m,`AGENT_NAME=${name}`)
  .replace(/^WORKSPACE_HOST_PATH=.*$/m,`WORKSPACE_HOST_PATH='${path.join(resolved,name,'workspace')}'`)
  .replace(/^CODEX_HOST_PATH=.*$/m,`CODEX_HOST_PATH='${path.join(resolved,name,'codex')}'`);
await fs.writeFile(path.join(directory,'agent.env'),content,{flag:'wx',mode:0o600});
console.log('Created private instance configuration. Fill its credentials and create its workspace/codex directories on the target host before starting.');
