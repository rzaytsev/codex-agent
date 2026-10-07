import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
// Disposable files only. No model, auth, network request or host configuration.
const root=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-isolation-probe-'));
let report={schema:1,version:'unavailable',mode:'read-only',outcome:'unavailable',reason:'runtime_error',exitCode:null,credentialIsolationProved:false,liveAuthCompatibility:'unverified'};
try {
 const home=path.join(root,'home'),task=path.join(root,'task'),foreign=path.join(root,'foreign');
 for(const dir of [home,task,foreign,path.join(home,'codex')])await fs.mkdir(dir,{recursive:true,mode:0o700});
 const credential=path.join(home,'codex','synthetic-credential'),other=path.join(foreign,'synthetic-task');
 await fs.writeFile(credential,'DISPOSABLE_CREDENTIAL_CANARY');await fs.writeFile(other,'DISPOSABLE_FOREIGN_CANARY');
 const probe=`const fs=require('node:fs');const [credential,foreign,write]=process.argv.slice(1);const result={};for(const [name,file] of [['credentialReadable',credential],['foreignTaskReadable',foreign]]){try{fs.readFileSync(file);result[name]=true;}catch{result[name]=false;}}try{fs.writeFileSync(write,'disposable-write');result.taskWritable=true;}catch{result.taskWritable=false;}console.log(JSON.stringify(result));`;
 const env={PATH:process.env.PATH,HOME:home,CODEX_HOME:path.join(home,'codex'),LANG:'C.UTF-8'};
 const cli=path.resolve('node_modules/@openai/codex/bin/codex.js');
 const installed=(await exec(process.execPath,[cli,'--version'],{env,cwd:task,timeout:10000})).stdout.trim();
 if(installed!=='codex-cli 0.159.2') {report.reason='unsupported_runtime';throw new Error('Unsupported runtime');}
 const version='codex-cli 0.159.2';
 try {
  const {stdout}=await exec(process.execPath,[cli,'sandbox','-P',':read-only','-C',task,'--',process.execPath,'-e',probe,credential,other,path.join(task,'write-canary')],{env,cwd:task,timeout:20000,maxBuffer:64000});
  const results=JSON.parse(stdout.trim());
  if(['credentialReadable','foreignTaskReadable','taskWritable'].some(key=>typeof results?.[key]!=='boolean'))throw new Error('Invalid probe result');
  report={schema:1,version,mode:'read-only',outcome:results.credentialReadable||results.foreignTaskReadable||results.taskWritable?'bypass':'protected',credentialReadable:results.credentialReadable,foreignTaskReadable:results.foreignTaskReadable,taskWritable:results.taskWritable,credentialIsolationProved:!results.credentialReadable&&!results.foreignTaskReadable&&!results.taskWritable,liveAuthCompatibility:'unverified'};
 } catch(error) {
  // Never emit raw CLI stderr/error/config/environment; only fixed status fields.
  report={schema:1,version,mode:'read-only',outcome:'unavailable',reason:error.code===71?'sandbox_apply_denied':'runtime_error',exitCode:Number.isInteger(error.code)?error.code:null,credentialIsolationProved:false,liveAuthCompatibility:'unverified'};
 }
} catch { /* Version/dependency failures retain a fixed unavailable receipt. */ } finally {await fs.rm(root,{recursive:true,force:true});}
console.log(JSON.stringify(report));
