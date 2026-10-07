import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { restrictedReadOverrides } from '../src/restricted-read.js';
const exec=promisify(execFile);
const flags=['allowedInputReadable','credentialReadable','foreignTaskReadable','symlinkReadable','hardlinkReadable','lateForeignReadable','serviceReadable','approvalReadable','taskWritable','symlinkWritable','hardlinkWritable','lateForeignWritable','foreignWritable','credentialWritable','serviceWritable','approvalWritable','childEnvSanitized','foreignArgReadable'];
const denied=flags.filter(key=>!['allowedInputReadable','childEnvSanitized'].includes(key));

// Only probe-owned inputs may be explicitly granted. Runtime attempts grant no
// application inputs at all. This check cannot lock out same-grant outside writers.
export async function validateProbeInput(file,ownedRoot) {
 const root=await fs.realpath(ownedRoot),parent=await fs.realpath(path.dirname(file));
 if(parent!==root)throw new Error('Input is outside owned fixture');
 const before=await fs.lstat(file);
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw new Error('Unsafe probe input');
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {const opened=await handle.stat();if(!opened.isFile()||opened.nlink!==1||opened.ino!==before.ino||opened.dev!==before.dev)throw new Error('Changed probe input');}
 finally {await handle.close();}
 return fs.realpath(file);
}

export function parseProbeOutput(output) {
 if(typeof output!=='string'||Buffer.byteLength(output)>4096)throw new Error('Invalid probe receipt');
 const result=JSON.parse(output.trim());
 if(!result||Array.isArray(result)||Object.keys(result).length!==flags.length||flags.some(key=>typeof result[key]!=='boolean'))throw new Error('Invalid probe receipt');
 return Object.fromEntries(flags.map(key=>[key,result[key]]));
}

// Runs only synthetic commands, never codex exec/model/account/network. stdout
// carries a fixed handshake and bounded booleans; stderr is drained and discarded.
async function sandboxChild(args,options,createLate) {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{...options,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
  let output='',ready=false,failure,settled=false,lateCreation=Promise.resolve();
  const timer=setTimeout(()=>fail(Object.assign(new Error('Probe timeout'),{code:null})),20000);
  function fail(error){if(settled||failure)return;failure=error;if(child.pid&&process.platform!=='win32'){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}else child.kill('SIGKILL');}
  function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);}
  child.on('error',fail);child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
  child.stdout.on('data',chunk=>{
   if(failure)return;output+=chunk.toString();if(Buffer.byteLength(output)>4096)return fail(new Error('Probe output exceeded bound'));
   if(!ready&&output.startsWith('READY\n')){ready=true;output=output.slice(6);lateCreation=createLate().then(()=>{if(!failure)child.stdin.end('continue\n');},fail);}
  });
  child.on('close',async code=>{await lateCreation;if(failure)return finish(failure);if(code!==0)return finish(Object.assign(new Error('Sandbox unavailable'),{code}));if(!ready)return finish(new Error('Missing probe handshake'));finish(null,output);});
 });
}

export async function runIsolationProbe(mode='builtin') {
 const base={schema:2,version:'unavailable',mode,outcome:'unavailable',credentialIsolationProved:false,liveAuthCompatibility:'unverified',targetLinuxCompatibility:'unverified',fullIsolation:'incomplete_blocking',proofScope:'owned_disposable_fixtures'};
 if(!['builtin','restricted'].includes(mode))return {...base,mode:'invalid',reason:'invalid_mode',exitCode:null};
 let root,neighbor,phase='fixture_setup';
 try {
  root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-isolation-probe-'));
  const home=path.join(root,'home'),codex=path.join(home,'codex'),task=path.join(root,'empty-task'),foreign=path.join(root,'foreign'),input=path.join(root,'owned-input'),service=path.join(root,'service');
  for(const dir of [home,codex,task,foreign,input,service])await fs.mkdir(dir,{mode:0o700});
  const credential=path.join(codex,'synthetic-credential'),other=path.join(foreign,'synthetic-task'),allowed=path.join(input,'allowed'),ledger=path.join(service,'approval-fixture'),database=path.join(service,'service-fixture'),late=path.join(foreign,'late-created');
  for(const file of [credential,other,allowed,ledger,database])await fs.writeFile(file,'DISPOSABLE_CANARY',{mode:0o600});
  const symlink=path.join(task,'credential-link'),hardlink=path.join(task,'foreign-hardlink');
  await fs.symlink(credential,symlink);await fs.link(other,hardlink);
  phase='input_validation';
  const safeInput=await validateProbeInput(allowed,input);
  const env={PATH:'/usr/bin:/bin',HOME:home,CODEX_HOME:codex,LANG:'C.UTF-8'};
  phase='owned_process_setup';
  neighbor=spawn(process.execPath,['-e','setInterval(()=>{},1000)','DISPOSABLE_PROCESS_ARG_CANARY'],{env,cwd:foreign,stdio:'ignore'});
  await new Promise((resolve,reject)=>{neighbor.once('spawn',resolve);neighbor.once('error',reject);});
  let processPositiveControl=false;
  try {processPositiveControl=(await exec('/bin/ps',['-p',String(neighbor.pid),'-o','command='],{env,cwd:task,timeout:3000,maxBuffer:4096})).stdout.includes('DISPOSABLE_PROCESS_ARG_CANARY');} catch { /* Exact owned-PID control unavailable under nested wrappers. */ }
  phase='runtime_version';
  const cli=path.resolve('node_modules/@openai/codex/bin/codex.js');
  if((await exec(process.execPath,[cli,'--version'],{env,cwd:task,timeout:10000,maxBuffer:4096})).stdout.trim()!=='codex-cli 0.159.2')return {...base,reason:'unsupported_runtime',exitCode:null};
  base.version='codex-cli 0.159.2';
  phase='profile_setup';
  let overrides=[],selection=':read-only';
  if(mode==='restricted') {
   overrides=await restrictedReadOverrides();selection=JSON.parse(overrides[0].slice('default_permissions='.length));
   // Probe-only positive control: exact owned file, never a directory grant.
   overrides[1]=overrides[1].replace('filesystem={',`filesystem={${JSON.stringify(safeInput)}="read",`);
  }
  const probe=`const fs=require('node:fs');const [credential,foreign,allowed,symlink,hardlink,late,service,approval,taskWrite,pid,home,codex]=process.argv.slice(1);process.stdout.write('READY\\n');process.stdin.once('data',()=>{const result={};for(const [name,file] of [['allowedInputReadable',allowed],['credentialReadable',credential],['foreignTaskReadable',foreign],['symlinkReadable',symlink],['hardlinkReadable',hardlink],['lateForeignReadable',late],['serviceReadable',service],['approvalReadable',approval]]){try{fs.readFileSync(file);result[name]=true;}catch{result[name]=false;}}for(const [name,file] of [['taskWritable',taskWrite],['symlinkWritable',symlink],['hardlinkWritable',hardlink],['lateForeignWritable',late],['foreignWritable',foreign],['credentialWritable',credential],['serviceWritable',service],['approvalWritable',approval]]){try{fs.writeFileSync(file,'DISPOSABLE_WRITE');result[name]=true;}catch{result[name]=false;}}result.childEnvSanitized=['TELEGRAM_BOT_TOKEN','MAILBOX_TOKEN','GOOGLE_MAPS_API_KEY','ASSISTANT_CAPABILITY','PROBE_AMBIENT_CANARY','PYTHONPATH'].every(key=>!Object.hasOwn(process.env,key))&&(!process.env.HOME||process.env.HOME===home)&&(!process.env.CODEX_HOME||process.env.CODEX_HOME===codex);try{const out=require('node:child_process').execFileSync('/bin/ps',['-p',pid,'-o','command='],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:3000,maxBuffer:4096});result.foreignArgReadable=out.includes('DISPOSABLE_PROCESS_ARG_CANARY');}catch{result.foreignArgReadable=false;}console.log(JSON.stringify(result));process.stdin.destroy();});`;
  try {
   let lateCreated=false;
   const output=await sandboxChild([cli,'sandbox',...overrides.flatMap(value=>['-c',value]),'-P',selection,'-C',task,'--',process.execPath,'-e',probe,credential,other,allowed,symlink,hardlink,late,database,ledger,path.join(task,'write'),String(neighbor.pid),home,codex],{env,cwd:task},async()=>{await fs.writeFile(late,'DISPOSABLE_LATE_CANARY',{mode:0o600});if((await fs.readFile(late,'utf8'))!=='DISPOSABLE_LATE_CANARY')throw new Error('Missing late file control');lateCreated=true;});
   const result=parseProbeOutput(output);
   if(neighbor.exitCode!==null)throw new Error('Missing live process control');
   // Validate late-file existence outside the sandbox to prevent false protection.
   if(!lateCreated)throw new Error('Missing late file control');
   if(!processPositiveControl)return {...base,reason:'process_control_unavailable',exitCode:null};
   if(!result.allowedInputReadable)return {...base,reason:'input_control_unavailable',exitCode:null};
   const protectedFixtures=result.childEnvSanitized&&denied.every(key=>!result[key]);
   return {...base,outcome:protectedFixtures?'protected':'bypass',...result,processPositiveControl:true,lateFilePositiveControl:true,credentialIsolationProved:protectedFixtures};
  } catch(error) {return {...base,reason:error.code===71?'sandbox_apply_denied':'runtime_error',exitCode:Number.isInteger(error.code)&&error.code>=0&&error.code<=255?error.code:null};}
 } catch(error) {return {...base,reason:phase,exitCode:null};}
 finally {
  if(neighbor&&neighbor.exitCode===null&&neighbor.pid){const exited=new Promise(resolve=>neighbor.once('exit',resolve));neighbor.kill();await exited;}
  if(root)await fs.rm(root,{recursive:true,force:true});
 }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const args=process.argv.slice(2),mode=args.length===0?'builtin':args.length===1&&args[0]==='--mode=restricted'?'restricted':args.length===1&&args[0]==='--mode=builtin'?'builtin':'invalid';
 console.log(JSON.stringify(await runIsolationProbe(mode)));
}
