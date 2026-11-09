import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';
import {Conversations} from '../src/conversations.js';
import {Telegram} from '../src/telegram.js';
export const answer={text:'Synthetic answer',files:[],voice:false};
export async function fixture(t) {
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'controls-'));
 const cfg=config({WORKSPACE_DIR:workspace,CODEX_HOME:path.join(workspace,'codex'),TELEGRAM_ALLOWED_USER_IDS:'123',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',MEMORY_ENABLED:'false',LEARNING_ENABLED:'false',BROWSER_ENABLED:'false'});
 const store=new Store(path.join(workspace,'db')),sent=[],requests=[];let messageId=100;
 const telegram=new Telegram('unused');telegram.call=async(method,body)=>{sent.push({method,body});return method==='sendMessage'?{message_id:++messageId,chat:{id:123},...(body.message_thread_id!==undefined?{message_thread_id:body.message_thread_id}:{})}:true;};
 const agent={run:async(_user,prompt)=>{requests.push(prompt);return {...answer};}},service=new Service(cfg,store,telegram,agent);await service.init();
 const router=new Conversations(service,{agentFactory:()=>agent});service.conversations=router;router.setIdentity({username:'demo_bot',has_topics_enabled:true});
 t.after(async()=>{await router.stop();for(const s of router.all())s.store.db.close();await fs.rm(workspace,{recursive:true,force:true});});
 const query=(row,action,id=20,patch={})=>({update_id:id,callback_query:{id:'query-'+id,from:{id:123},message:{message_id:row.message_id,chat:{id:123,type:'private'},...(service.cfg.topic?{message_thread_id:service.cfg.topic.message_thread_id}:{})},data:`ctl:${row.id}:${action}`,...patch}});
 const row=id=>store.prepare('SELECT * FROM telegram_controls WHERE $scope AND id=?').get(id);
 const task=async(title='Synthetic task')=>{const result=await service.tool({user:'123',worker:false},'create_task',{prompt:'Produce a synthetic answer.',title});await service.deliver();return store.prepare('SELECT * FROM telegram_controls WHERE $scope AND job_id=?').get(result.id);};
 return {workspace,cfg,store,service,router,sent,requests,agent,query,row,task};
}
export const waitFor=async(predicate)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Synthetic condition timed out');};
