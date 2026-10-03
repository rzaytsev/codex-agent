import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcilePlugins } from '../src/plugins.js';
import { config } from '../src/config.js';

async function fixture(t,list) {
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'plugin-test-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const cfg=config({SEED_DIR:dir,CODEX_HOME:dir});
  if(list!==undefined)await fs.writeFile(cfg.pluginsFile,JSON.stringify(list));
  return cfg;
}
test('reconciliation installs only missing unique entries and preserves disabled/unlisted plugins',async t=>{
  const cfg=await fixture(t,['existing@catalog','missing@catalog','disabled@catalog','missing@catalog']);
  const calls=[];
  const results=await reconcilePlugins(cfg,{run:async args=>{
    calls.push(args);
    if(args[0]==='list')return {installed:[{pluginId:'existing@catalog',enabled:true},{pluginId:'disabled@catalog',enabled:false},{pluginId:'unrelated@catalog',enabled:true}]};
    return {pluginId:args[1]};
  }});
  assert.deepEqual(calls,[['list','--json'],['add','missing@catalog','--json']]);
  assert.deepEqual(results.map(r=>r.status),['already installed','installed','disabled']);
});
test('unavailable and failed installs report controlled statuses and continue with other plugins',async t=>{
  const cfg=await fixture(t,['absent@catalog','private@catalog','works@catalog']);let report;
  const results=await reconcilePlugins(cfg,{report:r=>report=r,run:async args=>{
    if(args[0]==='list')return {installed:[]};
    if(args[1]==='absent@catalog')throw Object.assign(new Error('secret'),{stderr:'Error: plugin `absent` was not found in remote marketplace `catalog`'});
    if(args[1]==='private@catalog')throw Object.assign(new Error('secret'),{stderr:'authorization-code-secret'});
    return {pluginId:args[1]};
  }});
  assert.deepEqual(results.map(r=>r.status),['unavailable','installation failed','installed']);
  assert.equal(report,results);assert(!JSON.stringify(report).includes('secret'));
});
test('invalid list, missing explicit file and lookup failures never launch installs or expose contents',async t=>{
  for(const list of [['bad; command@catalog'],['plain-name'],Array(21).fill('many@catalog'),{token:'private'}]) {
    const cfg=await fixture(t,list);let calls=0;
    assert.deepEqual(await reconcilePlugins(cfg,{run:async()=>{calls++;}}),[{status:'configuration failed'}]);assert.equal(calls,0);
  }
  const cfg=await fixture(t);assert.deepEqual(await reconcilePlugins(cfg),[]);
  cfg.pluginsFileRequired=true;assert.deepEqual(await reconcilePlugins(cfg),[{status:'configuration failed'}]);
  await fs.writeFile(cfg.pluginsFile,'["one@catalog"]');
  assert.deepEqual(await reconcilePlugins(cfg,{run:async()=>{throw new Error('private');}}),[{plugin:'one@catalog',status:'lookup failed'}]);
});
test('abort prevents additional installation and rejects mismatched CLI responses',async t=>{
  const cfg=await fixture(t,['one@catalog','two@catalog']);const controller=new AbortController();let adds=0;
  const results=await reconcilePlugins(cfg,{signal:controller.signal,run:async args=>{
    if(args[0]==='list')return {installed:[]};
    adds++;controller.abort();return {pluginId:'different@catalog'};
  }});
  assert.equal(adds,1);assert.deepEqual(results.map(r=>r.status),['interrupted','interrupted']);
});
test('native CLI uses selected Codex home, no shell and isolated environment',async t=>{
  const cfg=await fixture(t,['test@catalog']);const binary=path.join(cfg.codexHome,'fake-codex');
  await fs.writeFile(binary,`#!/usr/bin/env node
const fs=require('node:fs');
if(process.env.TELEGRAM_BOT_TOKEN||process.env.OPENAI_API_KEY||process.env.CODEX_HOME!==process.cwd())process.exit(9);
if(!process.argv.includes('forced_login_method="chatgpt"')||!process.argv.includes('cli_auth_credentials_store="file"'))process.exit(8);
fs.appendFileSync('calls.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');
console.log(JSON.stringify(process.argv.includes('list')?{installed:[]}:{pluginId:'test@catalog'}));
`,{mode:0o700});
  const results=await reconcilePlugins(cfg,{binary});
  assert.deepEqual(results,[{plugin:'test@catalog',status:'installed'}]);
  const calls=(await fs.readFile(path.join(cfg.codexHome,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[1].slice(-4),['plugin','add','test@catalog','--json']);
});
test('shutdown kills an active CLI without leaking its stderr',async t=>{
  const cfg=await fixture(t,['test@catalog']);const binary=path.join(cfg.codexHome,'hung-codex');
  await fs.writeFile(binary,`#!/usr/bin/env node
require('node:fs').writeFileSync('child.pid',String(process.pid));
console.error('private authorization code');setInterval(()=>{},1000);
`,{mode:0o700});
  const controller=new AbortController();const running=reconcilePlugins(cfg,{binary,signal:controller.signal});
  const file=path.join(cfg.codexHome,'child.pid');let pid;
  for(let i=0;i<200;i++){try{pid=Number(await fs.readFile(file,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,5));}}
  assert(pid);controller.abort();
  assert.deepEqual(await running,[{plugin:'test@catalog',status:'interrupted'}]);
  assert.throws(()=>process.kill(pid,0));
});
