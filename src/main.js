import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { Store } from './store.js';
import { Telegram } from './telegram.js';
import { Agent } from './agent.js';
import { Service } from './service.js';
import { Auth } from './auth.js';
import { TdlAuth } from './tdl-auth.js';
import { reconcilePlugins } from './plugins.js';
const cfg=config();
await fs.mkdir(path.join(cfg.workspace,'state'),{recursive:true});
await fs.mkdir(cfg.codexHome,{recursive:true});
const store=new Store(path.join(cfg.workspace,'state','assistant.sqlite'));
const telegram=new Telegram(cfg.token);const service=new Service(cfg,store,telegram,null);
const capability=(...args)=>service.capability(...args);capability.release=t=>service.releaseCapability(t);
service.agent=new Agent(cfg,store,capability,undefined,service.memory);
await service.init();await service.listen();
const telegramReady=Boolean(cfg.token && cfg.allowed.size);
service.auth=new Auth(cfg,store,{busy:()=>service.mainBusy||service.controllers.size>0,
  prepare:signal=>{service.state='setup:plugins';return reconcilePlugins(cfg,{signal,report:results=>{
    if(service.stopping)return;
    if(results.some(r=>r.status==='installed'))store.set(`thread:${cfg.owner}`,'');
    for(const result of results)console.log(`Plugin ${result.plugin||'list'}: ${result.status}`);
    const issues=results.filter(r=>!['installed','already installed'].includes(r.status));
    if(issues.length)service.auth.say('Plugin setup:\n'+issues.map(r=>`${r.plugin||'Plugin list'}: ${r.status}`).join('\n')+'\nOther assistant features remain available. Check the list and account connections; restart or complete /auth to check again.');
  }});}});
service.tdlAuth=new TdlAuth(cfg,store,{busy:()=>service.mainBusy||service.controllers.size>0||service.auth.phase!=='idle'});
await service.tdlAuth.init();
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  service.stopping=true;service.state='stopping';for(const ctrl of service.controllers.values()) ctrl.abort();
  service.server.close();void service.auth.close();void service.tdlAuth.close();setTimeout(()=>process.exit(0),2000).unref();
});
if(telegramReady)await service.auth.init();else service.state='setup:telegram';
let lastPoll=Date.now();let commandsRegistered=false;let lastCommandAttempt=0;
setInterval(()=>{
  if(!telegramReady||service.stopping) return;
  try {service.auth.tick();service.tdlAuth.tick();if(service.auth.ready)service.workers();service.schedules();} catch {console.error('Scheduler tick failed');}
  void service.conversation(service.auth.ready);void service.deliver();
  void service.mail?.tick();
  service.state=Date.now()-lastPoll>120000?'degraded:telegram':service.auth.health;
},1000).unref();
console.log('Assistant started; configuration values and credentials are not logged');
while(!service.stopping) {
  if(!telegramReady) {await new Promise(r=>setTimeout(r,10000));continue;}
  if(!commandsRegistered && Date.now()-lastCommandAttempt>60000) {
    lastCommandAttempt=Date.now();
    try {await telegram.registerCommands(cfg.allowed);commandsRegistered=true;}
    catch {console.error('Telegram command registration failed; will retry; private error details suppressed');}
  }
  try {
    const updates=await telegram.call('getUpdates',{offset:Number(store.get('offset')||0),timeout:30,allowed_updates:['message','edited_message']});
    for(const update of updates) {service.ingest(update);store.set('offset',update.update_id+1);}
    service.state=service.auth.health;lastPoll=Date.now();
  } catch {service.state='degraded:telegram';console.error('Telegram polling failed; private error details suppressed');await new Promise(r=>setTimeout(r,5000));}
}
