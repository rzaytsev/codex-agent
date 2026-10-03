import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeGroupSandbox } from '../src/group-sandbox.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Synthetic only: no Telegram credentials, existing workspace or model call.
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-group-sandbox-'));
const root=await fs.realpath(temporary);
try {
  const cfg={workspace:path.join(root,'group'),groupState:path.join(root,'private'),codexHome:path.join(root,'private','codex')};
  for(const directory of [cfg.workspace,cfg.groupState,cfg.codexHome,...['outputs','projects','tasks'].map(name=>path.join(cfg.workspace,name))])await fs.mkdir(directory,{recursive:true});
  const diagnostic=process.argv.includes('--diagnostics')?async(file,args,options)=>{
    try {return await promisify(execFile)(file,args,options);}
    catch(error){console.error(String(error.stderr||'Synthetic probe could not start').slice(0,4000));throw error;}
  }:undefined;
  const ready=await probeGroupSandbox(cfg,diagnostic);
  console.log(ready?'Group sandbox isolation probe passed.':'Group sandbox isolation probe unavailable or failed; group model execution must stay blocked.');
  if(!ready)process.exitCode=1;
} finally {await fs.rm(root,{recursive:true,force:true});}
