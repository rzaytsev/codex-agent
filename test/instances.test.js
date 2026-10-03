import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
const exec=promisify(execFile);

async function fixture(t) {
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agent-layout-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root=path.join(dir,'source with spaces');await fs.mkdir(root);
  for(const item of ['bin','templates','compose.yaml','package.json','.gitignore','.dockerignore'])await fs.cp(item,path.join(root,item),{recursive:true});
  await fs.mkdir(path.join(root,'scripts'));await fs.copyFile('scripts/create-agent.js',path.join(root,'scripts/create-agent.js'));
  const data=path.join(dir,'private data');
  const run=(...args)=>exec(path.join(root,'bin/agent'),args,{cwd:dir});
  await run('create','alpha','--data-root',data);await run('create','beta','--data-root',data);
  return {dir,root,data,run};
}

test('instance creation isolates data, keeps restrictive modes and refuses overwrite or unsafe paths',async t=>{
  const {root,data,run}=await fixture(t);
  const file=path.join(root,'private/instances/alpha/agent.env');
  const original=await fs.readFile(file,'utf8');
  assert(original.includes(path.join(data,'alpha/workspace')));
  assert((await fs.readFile(path.join(root,'private/instances/beta/agent.env'),'utf8')).includes(path.join(data,'beta/workspace')));
  assert.match(original,/TELEGRAM_BOT_TOKEN=\n/);
  assert.equal((await fs.stat(file)).mode&0o777,0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode&0o777,0o700);
  const plugins=path.join(root,'private/instances/alpha/seed/plugins.json');
  assert.deepEqual(JSON.parse(await fs.readFile(plugins,'utf8')),[]);
  assert.equal((await fs.stat(plugins)).mode&0o777,0o600);
  await assert.rejects(run('create','alpha','--data-root',data));
  assert.equal(await fs.readFile(file,'utf8'),original);
  for(const [name,base] of [['../escape',data],['gamma',root],['gamma',"/tmp/a'quoted"],['gamma','relative']])
    await assert.rejects(run('create',name,'--data-root',base));
});

test('launcher resolves private overrides from any cwd and does not print resolved secrets',async t=>{
  const {dir,root,run}=await fixture(t);
  const fake=path.join(dir,'fake');await fs.mkdir(fake);
  await fs.writeFile(path.join(fake,'docker'),'#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),env:{AGENT_NAME:process.env.AGENT_NAME,AGENT_INSTANCE_DIR:process.env.AGENT_INSTANCE_DIR,WORKSPACE_HOST_PATH:process.env.WORKSPACE_HOST_PATH}}));\n',{mode:0o755});
  await fs.writeFile(path.join(root,'private/instances/alpha/compose.override.yaml'),'services: {}\n');
  const {stdout}=await exec(path.join(root,'bin/agent'),['config','alpha'],{cwd:dir,env:{...process.env,PATH:fake+path.delimiter+process.env.PATH,WORKSPACE_HOST_PATH:'/wrong'}});
  const result=JSON.parse(stdout);assert(result.args.includes('codex-agent-alpha'));
  assert(result.args.includes(path.join(root,'private/instances/alpha/compose.override.yaml')));
  assert.deepEqual(result.args.slice(-2),['config','--quiet']);assert.equal(result.env.WORKSPACE_HOST_PATH,undefined);
  const started=await exec(path.join(root,'bin/agent'),['up','alpha','--no-build','--force-recreate'],{cwd:dir,env:{...process.env,PATH:fake+path.delimiter+process.env.PATH}});
  assert(!JSON.parse(started.stdout).args.includes('--build'));
  assert(JSON.parse(started.stdout).args.includes('--no-build'));
  await assert.rejects(run('config','alpha','--environment'));
  await assert.rejects(run('ps','missing'));
});

test('Compose resolves two independent instances with private overrides and read-only public skills',async t=>{
  try {await exec('docker',['compose','version']);}catch{t.skip('Docker Compose unavailable');return;}
  const {root,data,run}=await fixture(t);
  await fs.writeFile(path.join(root,'private/instances/alpha/compose.override.yaml'),'services:\n  assistant:\n    volumes:\n      - type: bind\n        source: ./private/shared-skills/custom\n        target: /workspace/.agents/skills/custom\n        read_only: true\n        bind: {create_host_path: false}\n');
  const configs=[];
  for(const name of ['alpha','beta']) {
    await run('config',name);
    const instance=path.join(root,'private/instances',name);
    const args=['compose','--project-directory',root,'--env-file',path.join(instance,'agent.env'),'-p',`codex-agent-${name}`,'-f',path.join(root,'compose.yaml')];
    if(name==='alpha')args.push('-f',path.join(instance,'compose.override.yaml'));
    const {stdout}=await exec('docker',[...args,'config','--format','json'],{env:{...process.env,AGENT_NAME:name,AGENT_ENV_FILE:path.join(instance,'agent.env'),AGENT_INSTANCE_DIR:instance}});
    const cfg=JSON.parse(stdout);configs.push(cfg);
    const mounts=cfg.services.assistant.volumes;
    assert.equal(mounts.find(m=>m.target==='/workspace').source,path.join(data,name,'workspace'));
    assert.equal(mounts.find(m=>m.target==='/workspace').bind.create_host_path,false);
    assert.equal(mounts.find(m=>m.target==='/data/codex').source,path.join(data,name,'codex'));
    assert.equal(mounts.find(m=>m.target==='/run/agent-seed').source,path.join(instance,'seed'));
    assert.equal(mounts.find(m=>m.target==='/workspace/.agents/skills/google-maps').read_only,true);
    assert.equal(mounts.find(m=>m.target==='/workspace/.agents/skills/telegram-read').read_only,true);
  }
  assert.notEqual(configs[0].name,configs[1].name);
  assert.equal(configs[0].services.assistant.volumes.find(m=>m.target.endsWith('/custom')).source,path.join(root,'private/shared-skills/custom'));
  assert(!configs[1].services.assistant.volumes.some(m=>m.target.endsWith('/custom')));
});

test('private seeds initialize only missing profiles and cannot cross instance boundaries',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-seeds-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const name of ['alpha','beta']) {
    const seed=path.join(dir,name,'seed');await fs.mkdir(seed,{recursive:true});
    await fs.writeFile(path.join(seed,'USER.md'),`Synthetic owner ${name}`);
    await fs.writeFile(path.join(seed,'SOUL.md'),`Character ${name}`);
    const cfg=config({WORKSPACE_DIR:path.join(dir,name,'workspace'),SEED_DIR:seed});
    const db=new Store(path.join(dir,name,'state.sqlite'));t.after(()=>db.db.close());
    const service=new Service(cfg,db,{},{});await service.init();
    assert.equal(await fs.readFile(path.join(cfg.workspace,'USER.md'),'utf8'),`Synthetic owner ${name}`);
    await fs.writeFile(path.join(cfg.workspace,'USER.md'),'Updated by owner');
    await fs.writeFile(path.join(seed,'USER.md'),'Stale seed');await service.init();
    assert.equal(await fs.readFile(path.join(cfg.workspace,'USER.md'),'utf8'),'Updated by owner');
    assert((await fs.readFile(path.join(cfg.workspace,'AGENTS.md'),'utf8')).includes('Durable memory'));
  }
});
