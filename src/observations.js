import manifest from '../package.json' with {type:'json'};
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {isUsageLimit} from './usage.js';
const reasons=['completed','incomplete_stream','quota','timeout','cancelled','provider_error','invalid_output','recovered_interruption','budget','output_error','execution_unknown'];
const efforts=['minimal','low','medium','high','xhigh','max','ultra'];
const components=['input_tokens','output_tokens','cached_input_tokens'];
const numeric=n=>Number.isSafeInteger(n)&&n>=0&&n<=1e15;
const hash=s=>createHash('sha256').update(s).digest('hex');
const id=s=>typeof s==='string'&&/^[a-f0-9-]{36}$/.test(s);
const digest=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const signals=new WeakMap();
const applicationRelease=manifest.version;
const nodeVersion=process.versions.node.split('.').map(Number);
const runtime=()=>({nodeMajor:nodeVersion[0],nodeMinor:nodeVersion[1],nodePatch:nodeVersion[2]});
const runtimeValid=v=>v&&Object.keys(v).length===3&&Object.keys(v).every(k=>['nodeMajor','nodeMinor','nodePatch'].includes(k)&&numeric(v[k])&&v[k]<=100000);
export class BudgetError extends Error {constructor(){super('Logical run budget exhausted');this.code='budget';}}
export function bindBudgetSignal(signal,o,r){if(signal&&r)signals.set(signal,{o,r});}
export function budgetForSignal(signal){return signal&&signals.get(signal);}
export function terminalReason(error,signal){return error?.executionUnknown?'execution_unknown':error instanceof BudgetError||signal?.reason instanceof BudgetError?'budget':signal?.aborted?(signal.reason?.code==='timeout'?'timeout':'cancelled'):isUsageLimit(error)?'quota':reasons.includes(error?.observationReason)?error.observationReason:'provider_error';}
export function safeFailure(reason){const e=new Error('Codex execution did not complete');e.observationReason=reason;return e;}
const toolCategories={history_read:'history',history_search:'history',memory_read:'memory',memory_search:'memory',memory_save:'memory',memory_explain:'memory',memory_forget:'memory',memory_forget_preview:'memory',learning_read:'learning',learning_evidence:'learning',learning_feedback:'learning',profile_read:'profile',profile_write:'profile',profile_patch:'profile',create_task:'task',cancel_task:'task',task_status:'task',schedule:'schedule',list_schedules:'schedule',cancel_schedule:'schedule',send_voice:'delivery',location_get:'location',location_set_default:'location',location_clear_temporary:'location',mail_agents:'mail',mail_send:'mail',mail_commit:'mail',mail_inbox:'mail',mail_read:'mail',mail_status:'mail'};
const categories=[...new Set(Object.values(toolCategories)),'other'];
// No SDK objects or errors enter these rows. The only identifiers in receipt
// payloads are service UUIDs; operational relations live in a separate table.
export class Observations {
  constructor(store,{epoch=randomUUID(),recover=true}={}){this.store=store;this.dropped=0;this.epoch=epoch;this.ready=this.safe(()=>{
    store.db.exec(`CREATE TABLE IF NOT EXISTS run_observations (id TEXT PRIMARY KEY,terminal TEXT,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempt_observations (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observation_links (run_id TEXT PRIMARY KEY,conversation_id TEXT,parent_run_id TEXT,job_id TEXT);
      CREATE TABLE IF NOT EXISTS active_attempt_observations (id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_baselines (thread_key TEXT PRIMARY KEY,usage TEXT,valid INTEGER NOT NULL,active INTEGER NOT NULL,epoch TEXT NOT NULL,generation INTEGER NOT NULL);`);
    if(recover)store.db.exec('UPDATE usage_baselines SET valid=0,active=0,generation=generation+1');
    this.salt=store.get('observation-salt')||randomUUID();store.set('observation-salt',this.salt);
    if(recover){
    for(const row of store.db.prepare('SELECT payload FROM active_attempt_observations').all()){const p=JSON.parse(row.payload);p.elapsedMs=null;p.toolCount=null;p.artifactBytes=null;this.record(p);}
    store.db.exec('DELETE FROM active_attempt_observations');
    // Crash recovery has no trustworthy end usage or timing.
    for(const row of store.db.prepare('SELECT id,payload FROM run_observations WHERE terminal IS NULL').all()){
      const p=JSON.parse(row.payload);const recovered={schema_version:1,application_release:applicationRelease,runtime:runtime(),id:row.id,reason:'recovered_interruption',elapsedMs:null,tools:null,artifactBytes:null,attempts:null,toolCounts:null,usageComplete:false,inputTokens:null,outputTokens:null};
      if(p.schema_version!==1||Object.keys(p).length!==2||!Object.keys(p).every(k=>['schema_version','id'].includes(k))){this.dropped=Math.min(1e15,this.dropped+1);continue;}
      if(id(p.id))this.recordRun(recovered);
    }
    }
    return true;
  })===true;}
  safe(fn){if(this.ready===false){this.dropped=Math.min(1e15,this.dropped+1);return undefined;}try{return fn();}catch{this.dropped=Math.min(1e15,this.dropped+1);return undefined;}}
  run(limits={},controller,relations={}){
    const r={id:randomUUID(),started:performance.now(),tools:0,artifactBytes:0,attempts:0,limits,controller,usageComplete:true,input:0,output:0,terminal:false,outputFailed:false};
    if(controller){bindBudgetSignal(controller.signal,this,r);if(limits.wallMs)r.timer=setTimeout(()=>controller.abort(new BudgetError()),limits.wallMs);}
    this.safe(()=>this.store.transaction(()=>{
      this.store.db.prepare('INSERT INTO run_observations VALUES (?,NULL,?)').run(r.id,JSON.stringify({schema_version:1,id:r.id}));
      this.store.db.prepare('INSERT INTO observation_links VALUES (?,?,?,?)').run(r.id,this.store.get('conversation-id')||null,relations.parentRunId||null,relations.jobId||null);
    }));return r;
  }
  boundary(r,admission=false){if(!r)return;r.controller?.signal.throwIfAborted();const l=r.limits;if((l.wallMs&&performance.now()-r.started>=l.wallMs)||(l.tools&&r.tools>l.tools)||(l.artifacts&&r.artifactBytes>l.artifacts)||(admission&&l.tokens&&r.usageComplete&&r.input+r.output>=l.tokens)){
    r.budgetExceeded=true;r.controller?.abort(new BudgetError());throw new BudgetError();}}
  tool(r,name){if(!r)return;r.tools++;r.toolCounts??={};const category=Object.hasOwn(toolCategories,name)?toolCategories[name]:'other';r.toolCounts[category]=(r.toolCounts[category]||0)+1;this.boundary(r);}
  artifact(r,size){if(!r)return;if(!numeric(size))throw new BudgetError();r.artifactBytes+=size;this.boundary(r);}
  attempt(r,settings,profile,thread,fresh=false){this.boundary(r,true);r.attempts++;const a={id:randomUUID(),run:r,started:performance.now(),toolsAtStart:r.tools,artifactsAtStart:r.artifactBytes,terminal:false,threadKey:null,generation:0,baseline:null,settings:{effort:efforts.includes(settings?.effort)?settings.effort:'low',toolScope:settings?.toolScope==='read'?'read':'conversation',timeout:numeric(settings?.timeout)?settings.timeout:0,modelHash:settings?.model?hash(String(settings.model)):null},profile:['main','worker','research','review'].includes(profile)?profile:'review',promptHash:null,toolsHash:null};this.safe(()=>this.store.db.prepare('INSERT INTO active_attempt_observations VALUES (?,?)').run(a.id,JSON.stringify(this.receipt(a,'recovered_interruption'))));if(thread)this.thread(a,thread,fresh);return a;}
  bundle(a,prompt,tools){this.safe(()=>{if(a){a.promptHash=hash(prompt);a.toolsHash=tools===null?null:hash(tools);this.store.db.prepare('UPDATE active_attempt_observations SET payload=? WHERE id=?').run(JSON.stringify(this.receipt(a,'recovered_interruption')),a.id);}});}
  thread(a,thread,fresh=false){if(!a||a.threadKey||typeof thread!=='string')return;a.threadKey=hash(this.salt+'\0'+thread);this.safe(()=>this.store.transaction(()=>{
    const db=this.store.db,row=db.prepare('SELECT * FROM usage_baselines WHERE thread_key=?').get(a.threadKey);
    if(!row){a.baseline=fresh?Object.fromEntries(components.map(k=>[k,0])):null;db.prepare('INSERT INTO usage_baselines VALUES (?,NULL,?,1,?,0)').run(a.threadKey,Number(fresh),this.epoch);}
    else {a.overlap=Boolean(row.active);a.generation=row.generation+(row.active?1:0);a.baseline=row.valid&&!row.active&&row.epoch===this.epoch?JSON.parse(row.usage):null;db.prepare('UPDATE usage_baselines SET active=active+1,valid=?,generation=?,epoch=? WHERE thread_key=?').run(Number(Boolean(a.baseline)),a.generation,this.epoch,a.threadKey);}
  }));}
  invalidateThread(thread){this.safe(()=>this.store.db.prepare('UPDATE usage_baselines SET valid=0,generation=generation+1 WHERE thread_key=?').run(hash(this.salt+'\0'+thread)));}
  finishAttempt(a,reason,raw){if(!a||a.terminal)return;a.terminal=true;
    const usage={};for(const k of components)if(numeric(raw?.[k]))usage[k]=raw[k];
    const present=Object.keys(usage).length>0,complete=components.every(k=>numeric(usage[k]));let delta=null;
    const persisted=this.safe(()=>this.store.transaction(()=>{
      const db=this.store.db;
      // Durable identity wins before examining a newer thread lease. A replay
      // (even changed content) must not mutate accounting or completeness.
      if(db.prepare('SELECT id FROM attempt_observations WHERE id=?').get(a.id))return 'duplicate';
      const p=this.receipt(a,reason,present?usage:null,complete?'supported_complete':present?'partial':'unknown');
      const row=a.threadKey?db.prepare('SELECT * FROM usage_baselines WHERE thread_key=?').get(a.threadKey):null;
      if(reason==='completed'&&complete&&a.baseline&&row?.valid&&row.generation===a.generation&&row.active===1&&row.epoch===this.epoch&&components.every(k=>usage[k]>=a.baseline[k])){delta=Object.fromEntries(components.map(k=>[k,usage[k]-a.baseline[k]]));p.delta=delta;p.attribution='serialized';}
      if(!this.record(p)){
        if(db.prepare('SELECT id FROM attempt_observations WHERE id=?').get(a.id))return 'duplicate';
        throw new Error('Observation rejected');
      }
      db.prepare('DELETE FROM active_attempt_observations WHERE id=?').run(a.id);
      if(row){const active=Math.max(0,row.active-1),valid=reason==='completed'&&complete&&active===0&&row.generation===a.generation&&!a.overlap;db.prepare('UPDATE usage_baselines SET usage=?,valid=?,active=? WHERE thread_key=?').run(present?JSON.stringify(usage):null,Number(valid),active,a.threadKey);}
      return 'committed';
    }));
    if(persisted==='duplicate')return;
    if(delta&&persisted==='committed'){a.run.input+=delta.input_tokens;a.run.output+=delta.output_tokens;}else a.run.usageComplete=false;
  }
  receipt(a,reason,usage=null,completeness='unknown'){
    return {schema_version:1,application_release:applicationRelease,id:a.id,runId:a.run.id,reason,elapsedMs:Math.min(1e15,Math.max(0,Math.round(performance.now()-a.started))),profile:a.profile,settings:a.settings,sdk:'0.159.2',cli:'0.159.2',runtime:runtime(),source:'codex_sdk',semantics:'thread_total',completeness:completeness,usage,delta:null,attribution:'unattributed',cacheWriteProvenance:'unknown_sdk_default',promptHash:a.promptHash,toolsHash:a.toolsHash,retryCount:0,toolCount:Math.max(0,a.run.tools-a.toolsAtStart),artifactBytes:Math.max(0,a.run.artifactBytes-a.artifactsAtStart)};
  }
  record(p){const keys=['schema_version','application_release','id','runId','reason','elapsedMs','profile','settings','sdk','cli','runtime','source','semantics','completeness','usage','delta','attribution','cacheWriteProvenance','promptHash','toolsHash','retryCount','toolCount','artifactBytes'];
    const valid=p&&p.schema_version===1&&p.application_release===applicationRelease&&Object.keys(p).length===keys.length&&Object.keys(p).every(k=>keys.includes(k))&&id(p.id)&&id(p.runId)&&reasons.includes(p.reason)&&(numeric(p.elapsedMs)||p.reason==='recovered_interruption'&&p.elapsedMs===null)&&['main','worker','research','review'].includes(p.profile)&&p.sdk==='0.159.2'&&p.cli==='0.159.2'&&runtimeValid(p.runtime)&&p.source==='codex_sdk'&&p.semantics==='thread_total'&&['supported_complete','partial','unknown'].includes(p.completeness)&&['serialized','unattributed'].includes(p.attribution)&&p.cacheWriteProvenance==='unknown_sdk_default'&&numeric(p.retryCount)&&(numeric(p.toolCount)||p.reason==='recovered_interruption'&&p.toolCount===null)&&(numeric(p.artifactBytes)||p.reason==='recovered_interruption'&&p.artifactBytes===null)&&[p.promptHash,p.toolsHash].every(v=>v===null||digest(v))&&p.settings&&Object.keys(p.settings).length===4&&Object.keys(p.settings).every(k=>['effort','toolScope','timeout','modelHash'].includes(k))&&efforts.includes(p.settings.effort)&&['read','conversation'].includes(p.settings.toolScope)&&numeric(p.settings.timeout)&&(p.settings.modelHash===null||digest(p.settings.modelHash))&&[p.usage,p.delta].every(v=>v===null||(typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>components.includes(k)&&numeric(v[k]))));
    if(!valid){this.dropped=Math.min(1e15,this.dropped+1);return false;}return this.safe(()=>{return this.store.db.prepare('INSERT OR IGNORE INTO attempt_observations VALUES (?,?,?)').run(p.id,p.runId,JSON.stringify(p)).changes===1;})===true;
  }
  recordRun(p){
    const keys=['schema_version','application_release','runtime','id','reason','elapsedMs','tools','artifactBytes','attempts','toolCounts','usageComplete','inputTokens','outputTokens'];
    const recovered=p?.reason==='recovered_interruption';
    const valid=p&&p.schema_version===1&&p.application_release===applicationRelease&&Object.keys(p).length===keys.length&&Object.keys(p).every(k=>keys.includes(k))&&id(p.id)&&reasons.includes(p.reason)&&runtimeValid(p.runtime)&&[p.elapsedMs,p.tools,p.artifactBytes,p.attempts].every(v=>numeric(v)||recovered&&v===null)&&typeof p.usageComplete==='boolean'&&[p.inputTokens,p.outputTokens].every(v=>p.usageComplete?numeric(v):v===null)&&(recovered&&p.toolCounts===null||p.toolCounts&&typeof p.toolCounts==='object'&&!Array.isArray(p.toolCounts)&&Object.keys(p.toolCounts).every(k=>categories.includes(k)&&numeric(p.toolCounts[k])));
    if(!valid){this.dropped=Math.min(1e15,this.dropped+1);return false;}
    return this.safe(()=>{this.store.db.prepare('UPDATE run_observations SET terminal=?,payload=? WHERE id=? AND terminal IS NULL').run(p.reason,JSON.stringify(p),p.id);return true;})===true;
  }
  finishRun(r,reason){if(!r||r.terminal)return;r.terminal=true;clearTimeout(r.timer);if(reason!=='execution_unknown'&&(r.budgetExceeded||r.controller?.signal.reason instanceof BudgetError))reason='budget';if(r.outputFailed&&reason==='completed')reason='output_error';const p={schema_version:1,application_release:applicationRelease,runtime:runtime(),id:r.id,reason:reasons.includes(reason)?reason:'provider_error',elapsedMs:Math.min(1e15,Math.max(0,Math.round(performance.now()-r.started))),tools:r.tools,artifactBytes:r.artifactBytes,attempts:r.attempts,toolCounts:Object.fromEntries(categories.filter(k=>numeric(r.toolCounts?.[k])).map(k=>[k,r.toolCounts[k]])),usageComplete:r.usageComplete,inputTokens:r.usageComplete?r.input:null,outputTokens:r.usageComplete?r.output:null};this.recordRun(p);}
}

// Conversation routes use separate SQLite connections to one tenant database.
// A new connection is not a process restart and must not recover live receipts.
const epochs=new Map();
export function observationsForStore(store){
  if(store.file===':memory:')return new Observations(store);
  const key=path.resolve(store.file),entry=epochs.get(key);
  const live=entry?.connections.filter(ref=>ref.deref()?.isOpen)||[];
  const o=new Observations(store,live.length?{epoch:entry.epoch,recover:false}:undefined);
  epochs.set(key,{epoch:o.epoch,connections:[...live,new WeakRef(store.db)]});return o;
}
