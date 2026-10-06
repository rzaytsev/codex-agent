// Deterministic production contracts: real registry/service/store, no SDK execution.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';
import {actionRegistry} from '../src/action-registry.js';
import {ContractDenial} from '../src/contract-denial.js';
const owner='999';
export function createContractAdapter() {
  return {name:'deterministic-production-service',qualityEvidence:false,model:'none',effort:'none',async run(input,features) {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'production-contract-'));
    const cfg=config({WORKSPACE_DIR:root,CODEX_HOME:path.join(root,'empty-codex'),TELEGRAM_ALLOWED_USER_IDS:owner,TELEGRAM_BOT_TOKEN:'',PROACTIVE_ENABLED:'false',CLEANUP_ENABLED:'false',BROWSER_ENABLED:'false',WORKSPACE_PYTHON_BASE:'',MEMORY_ENABLED:String(features.memoryEnabled),LEARNING_ENABLED:String(features.learningEnabled)});
    const database=path.join(root,'synthetic.db'),sources=new Map(),results={};let store,service;
    const open=async()=>{store=new Store(database);service=new Service(cfg,store,{}, {run:()=>{throw Error('Models are forbidden in deterministic lane');}});await service.init();};
    const resolve=value=>typeof value==='string'&&value.startsWith('$source:')?sources.get(value.slice(8)):Array.isArray(value)?value.map(resolve):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolve(v)])):value;
    const cap=()=>({user:owner,actorId:owner,owner,conversationId:store.get('conversation-id'),sessionId:store.get('main-session')});
    const call=async(name,args)=>{
      try {const result=await service.tool(cap(),name,resolve(args));return Array.isArray(result)?result:{status:'allowed',...result};}
      catch(error) {
        const expected=name==='memory_save'?['memory_primary_evidence_required','memory_source_forgotten','memory_tombstoned']:name==='learning_feedback'?['learning_feedback_invalid']:!actionRegistry.has(name)?['action_denied']:[];
        if(!(error instanceof ContractDenial)||!expected.includes(error.code))throw error;
        return {status:'denied',denial_code:error.code};
      }
    };
    try {
      await open();
      for(const step of input.steps) {
        features.signal?.throwIfAborted();
        if(step.op==='history') {
          const message={from:{id:Number(owner)},chat:{id:Number(owner),type:'private'},text:step.text};
          if(step.origin==='forwarded')message.forward_sender_name='Synthetic hidden sender';
          if(step.origin==='attachment')message.document={file_id:'synthetic'};
          if(step.origin==='bot')message.via_bot={id:1};
          if(step.origin==='other')message.chat.type='group';
          const id=store.ownerHistory(cfg,message,step.text);sources.set(step.id,'history:'+id);
        } else if(step.op==='reopen') {store.db.close();await open();results[step.id]={status:'reopened'};}
        else if(step.op==='tool') {
          // Flags control eval capture/ordinary context, while production memory
          // tools remain usable when maintenance is disabled (existing contract).
          if(!features.memoryEnabled&&step.tool==='memory_save')results[step.id]={status:'skipped'};
          else {
            const result=await call(step.tool,step.args);
            results[step.id]=result;
          }
        } else if(step.op==='learning') {
          if(!features.learningEnabled){results[step.id]={status:'skipped'};continue;}
          const change=resolve(step.change),batch=service.learning.batch(service.learning.target());
          try {const result=service.learning.apply(batch,{summary:'',changes:[change]},{decisions:[{key:change.key,accept:true,reason:'Synthetic proposal validator.'}]},step.id);results[step.id]={status:'allowed',applied:result.applied};}
          catch(error) {
            const expected=['preference','style'].includes(change.kind)?['learning_owner_evidence_required']:change.kind==='rule'&&change.status==='active'?['learning_outcome_required','learning_regression']:[];
            if(!(error instanceof ContractDenial)||!expected.includes(error.code))throw error;
            results[step.id]={status:'denied',denial_code:error.code};
          }
        } else if(step.op==='check') {
          if(!features.learningEnabled){results[step.id]={status:'skipped'};continue;}
          const record=service.learning.get(step.key);
          // Fixed reviewed check selected at trial creation; never a model claim.
          // This proves service context injection only, not model helpfulness.
          const passed=record?.check==='planning-context-v1'&&service.learning.context('planning').some(r=>r.key===step.key&&r.status==='trial'&&r.content==='Include a verification step in planning checklists.');
          if(!passed){results[step.id]={status:'check_failed'};continue;}
          // Observation occurs after a verified check, at a later clock tick.
          await new Promise(resolve=>setTimeout(resolve,2));
          const source='history:'+store.ownerHistory(cfg,{from:{id:Number(owner)},chat:{id:Number(owner),type:'private'},text:'Synthetic deterministic context check completed.'},'Synthetic deterministic context check completed.');
          service.learning.recordOutcome({key:record.key,candidate_revision:record.revision,candidate_hash:record.candidate_hash,check_hash:record.check_hash,outcome:'improved',observed_at:Date.now(),evidence_ids:[source]},{kind:'deterministic_check'});
          sources.set(step.id,source);results[step.id]={status:'checked'};
        } else throw Error('Unknown contract operation');
      }
      const clean=r=>r&&({key:r.key,content:r.content,revision:r.revision,certainty:r.certainty,status:r.status,review_state:r.review_state,entity:r.entity,project:r.project,sources:r.sources.map(s=>[...sources].find(([,v])=>v===s)?.[0]||s)});
      const memory=store.db.prepare('SELECT key FROM memories ORDER BY key').all().map(r=>clean(service.memory.get(r.key)));
      const learning=service.learning.list().map(clean);
      const outcomes=learning.flatMap(r=>service.learning.outcomes(r.key)).map(r=>({candidate_revision:r.candidate_revision,outcome:r.outcome,authority:r.authority}));
      // Sanitize results to fixture-owned data only; no paths or arbitrary errors.
      const sanitize=r=>Array.isArray(r)?r.map(sanitize):r&&typeof r==='object'?Object.fromEntries(Object.entries(r).filter(([k])=>!['path','updated','created','markdown_synced'].includes(k)).map(([k,v])=>[k,sanitize(v)])):r;
      return {results:sanitize(results),memory,learning,outcomes,outbox:store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,modelCalls:0};
    } finally {if(store?.db.isOpen)store.db.close();await fs.rm(root,{recursive:true,force:true});}
  }};
}
