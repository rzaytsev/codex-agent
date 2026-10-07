import {ContractDenial} from './contract-denial.js';
import {trustedHistoryOrigin} from './owner-evidence.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const fields={key:{type:'string'},kind:{type:'string',enum:['rule','preference','style','question']},target:{type:'string',enum:['PLAYBOOK.md','AGENTS.md','USER.md','SOUL.md']},content:{type:'string'},scope:{type:'string'},expected_benefit:{type:'string'},check:{type:'string'},sources:{type:'array',items:{type:'string'}},expected_revision:{type:'integer',minimum:0},status:{type:'string',enum:['trial','active','pending','resolved','retired']}};
export const learningSchema={type:'object',additionalProperties:false,required:['summary','changes'],properties:{summary:{type:'string'},changes:{type:'array',items:{type:'object',additionalProperties:false,required:Object.keys(fields),properties:fields}}}};
export const validationSchema={type:'object',additionalProperties:false,required:['decisions'],properties:{decisions:{type:'array',items:{type:'object',additionalProperties:false,required:['key','accept','reason'],properties:{key:{type:'string'},accept:{type:'boolean'},reason:{type:'string'}}}}}};
export const LEARNING_HEADING='## Continuous learning v1';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const begin='<!-- assistant-learning:begin -->',end='<!-- assistant-learning:end -->';
const keyPattern=/^[a-z0-9][a-z0-9-]{0,79}$/;
const secretPattern=/-----BEGIN (?:[A-Z ]*PRIVATE KEY)|\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+\S{12,}|(?:api[_-]?key|password|token|secret)\s*[=:]\s*["']?[A-Za-z0-9_/-]{16,}/i;
const authorityPattern=/\b(?:ignore|override|disable|bypass|expand|remove)\b.{0,60}\b(?:core|privacy|permission|authorization|safety|owner|consent)\b|\b(?:full|unrestricted|blanket) (?:authority|permission|access)\b/i;
export function withoutLearning(text) {
  const a=text.indexOf(begin),b=text.indexOf(end);
  if(a<0&&b<0)return text;
  if(a<0||b<a||text.indexOf(begin,a+begin.length)>=0||text.indexOf(end,b+end.length)>=0)throw new Error('Invalid managed learning section');
  return text.slice(0,a)+text.slice(b+end.length);
}
export class Learning {
  constructor(workspace,store,owner) {
    this.workspace=workspace;this.store=store;this.db=store.db;this.owner=owner;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learning_events(id INTEGER PRIMARY KEY,user TEXT NOT NULL,source TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(user,source));
      CREATE INDEX IF NOT EXISTS learning_events_owner ON learning_events(user,id);
      CREATE TABLE IF NOT EXISTS learning_records(user TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,revision INTEGER NOT NULL,updated INTEGER NOT NULL,offered INTEGER,outbox_id INTEGER,PRIMARY KEY(user,key));
      CREATE TABLE IF NOT EXISTS learning_versions(user TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(user,key,revision));
      CREATE TABLE IF NOT EXISTS learning_outcomes(id TEXT PRIMARY KEY,user TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS learning_outcomes_candidate ON learning_outcomes(user,key,revision);
      CREATE TABLE IF NOT EXISTS learning_trial_bindings(user TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,evidence_cursor INTEGER NOT NULL,PRIMARY KEY(user,key,revision));
      CREATE TABLE IF NOT EXISTS learning_reviews(id TEXT PRIMARY KEY,user TEXT NOT NULL,created INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS learning_history AFTER INSERT ON history WHEN NEW.role IN ('user','assistant','event') BEGIN
        INSERT OR IGNORE INTO learning_events(user,source,created) VALUES(NEW.user,'history:'||NEW.id,NEW.created); END;
      CREATE TRIGGER IF NOT EXISTS learning_jobs AFTER UPDATE OF state ON jobs WHEN NEW.state IN ('completed','failed','cancelled','interrupted') AND NEW.prompt NOT LIKE '[LEARNING]%' AND NEW.prompt NOT LIKE '[MEMORY]%' AND NEW.prompt NOT LIKE '[REFLECTION]%' AND NEW.prompt NOT LIKE '[CLEANUP]%' BEGIN
        INSERT OR IGNORE INTO learning_events(user,source,created) VALUES(NEW.user,'job:'||NEW.id,NEW.created); END;
    `);
    if(owner) {
      const previous=store.get('learning-owner');
      if((previous&&previous!==owner)||this.db.prepare('SELECT user FROM learning_records WHERE user!=? UNION SELECT user FROM learning_events WHERE user!=? LIMIT 1').get(owner,owner))throw new Error('Learning belongs to another owner');
      store.set('learning-owner',owner);
      this.db.prepare("INSERT OR IGNORE INTO learning_events(user,source,created) SELECT user,'history:'||id,created FROM history WHERE user=? AND role IN ('user','assistant','event') ORDER BY id").run(owner);
      this.db.prepare("INSERT OR IGNORE INTO learning_events(user,source,created) SELECT user,'job:'||id,created FROM jobs WHERE user=? AND state IN ('completed','failed','cancelled','interrupted') AND prompt NOT LIKE '[LEARNING]%' AND prompt NOT LIKE '[MEMORY]%' AND prompt NOT LIKE '[REFLECTION]%' AND prompt NOT LIKE '[CLEANUP]%' ORDER BY created").run(owner);
    }
  }
  checkOwner() {if(!this.owner||this.store.get('learning-owner')!==this.owner)throw new Error('Learning owner unavailable');}
  blocked() {return new Set(this.db.prepare('SELECT history_id FROM memory_blocked_history WHERE user=? UNION SELECT j.value AS history_id FROM memory_tombstones t,json_each(t.blocked_history) j WHERE t.user=?').all(this.owner,this.owner).map(row=>'history:'+row.history_id));}
  evidence(source) {
    this.checkOwner();if(typeof source!=='string'||this.blocked().has(source))throw new Error('Unavailable learning evidence');
    const history=source.match(/^history:([1-9]\d*)$/);
    if(history) {
      const row=this.db.prepare("SELECT id,role,text,created,actor_id FROM history WHERE user=? AND id=? AND role IN ('user','assistant','event')").get(this.owner,Number(history[1]));
      if(row) {
        const provenance=this.db.prepare('SELECT origin,known_quote,provenance_version FROM history_origins WHERE owner=? AND history_id=?').get(this.owner,row.id),origin=trustedHistoryOrigin(provenance);
        return {...row,source,origin,provenance_version:provenance?.provenance_version??0,original_owner_statement:row.role==='user'&&row.actor_id===this.owner&&origin==='direct_owner'};
      }
    }
    if(/^job:[a-z0-9-]{1,80}$/.test(source)) {
      const row=this.db.prepare("SELECT id,state,prompt,result,created FROM jobs WHERE user=? AND id=? AND state IN ('completed','failed','cancelled','interrupted') AND prompt NOT LIKE '[LEARNING]%' AND prompt NOT LIKE '[MEMORY]%' AND prompt NOT LIKE '[REFLECTION]%' AND prompt NOT LIKE '[CLEANUP]%'").get(this.owner,source.slice(4));
      if(row)return {...row,source};
    }
    throw new Error('Unavailable learning evidence');
  }
  get(key,revision) {
    this.checkOwner();if(!keyPattern.test(key))throw new Error('Invalid learning key');
    const row=revision===undefined?this.db.prepare('SELECT * FROM learning_records WHERE user=? AND key=?').get(this.owner,key):this.db.prepare('SELECT * FROM learning_versions WHERE user=? AND key=? AND revision=?').get(this.owner,key,revision);
    if(!row)return null;const record={...JSON.parse(row.payload),revision:row.revision,updated:row.updated??row.created,offered:row.offered??null,outbox_id:row.outbox_id??null};
    const blocked=this.blocked(),review_reasons=record.sources.filter(s=>blocked.has(s)).map(source=>({source,reason:'shared_history_forgotten'}));
    return {...record,outcome_receipts:this.outcomes(key).filter(r=>r.candidate_revision===record.revision),candidate_hash:digest([this.owner,record.key,record.revision,record.kind,record.target,record.content,record.scope,record.expected_benefit,record.check]),check_hash:digest(record.check),review_state:review_reasons.length?'needs_review':'ready',review_reasons};
  }
  list() {this.checkOwner();return this.db.prepare("SELECT key FROM learning_records WHERE user=? ORDER BY CASE WHEN json_extract(payload,'$.status') IN ('active','trial','pending') THEN 0 ELSE 1 END,updated DESC,key LIMIT 100").all(this.owner).map(row=>this.get(row.key));}
  current({limit=100,kind,status,unoffered=false}={}) {
    this.checkOwner();
    if(!Number.isInteger(limit)||limit<1||limit>100||kind!==undefined&&!['rule','preference','style','question'].includes(kind)||status!==undefined&&!['active','trial','pending'].includes(status))throw new Error('Invalid current learning selection');
    // Retained historical rows must not consume current capacity or crowd useful
    // evidence out of bounded context, projection, question and review inputs.
    return this.db.prepare(`SELECT r.key FROM learning_records r WHERE r.user=?
      AND json_extract(r.payload,'$.status') IN ('active','trial','pending')
      AND NOT EXISTS (SELECT 1 FROM json_each(r.payload,'$.sources') s JOIN json_each(?) b ON s.value=b.value)
      AND (? IS NULL OR json_extract(r.payload,'$.kind')=?)
      AND (? IS NULL OR json_extract(r.payload,'$.status')=?)
      AND (?=0 OR r.offered IS NULL)
      ORDER BY r.updated DESC,r.key LIMIT ?`).all(this.owner,JSON.stringify([...this.blocked()]),kind??null,kind??null,status??null,status??null,Number(unoffered),limit).map(row=>this.get(row.key));
  }
  usable(record) {return record.sources.every(source=>!this.blocked().has(source));}
  context(query='') {
    const tokens=(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)||[]).slice(0,40);
    let budget=0;
    return this.current().map(r=>({r,score:tokens.filter(t=>(r.scope+' '+r.content).toLowerCase().includes(t)).length})).filter(({r,score})=>r.kind!=='rule'||score>0||r.scope==='general').sort((a,b)=>b.score-a.score).slice(0,8).flatMap(({r})=>{
      const entry={key:r.key,kind:r.kind,target:r.target,content:r.content,scope:r.scope,status:r.status,check:r.check,revision:r.revision,offered:r.offered,sources:r.sources};budget+=JSON.stringify(entry).length;return budget<=6500?[entry]:[];
    });
  }
  target() {this.checkOwner();return this.db.prepare('SELECT coalesce(max(id),0) AS n FROM learning_events WHERE user=?').get(this.owner).n;}
  batch(target) {
    const after=Number(this.store.get(`learning-cursor:${this.owner}`)||0),records=[];let cursor=after,size=0,truncated=0;
    const rows=this.db.prepare('SELECT * FROM learning_events WHERE user=? AND id>? AND id<=? ORDER BY id LIMIT 50').all(this.owner,after,target);
    for(const row of rows) {
      if(this.blocked().has(row.source)){cursor=row.id;continue;}
      let record=this.evidence(row.source);
      for(const field of ['text','prompt','result'])if(record[field]?.length>12000){record={...record,[field]:record[field].slice(0,12000),truncated:true};}
      const length=JSON.stringify(record).length;if(size+length>45000&&records.length)break;
      records.push(record);size+=length;cursor=row.id;if(record.truncated)truncated++;
    }
    if(!rows.length)cursor=target;
    return {after,cursor,target,records,truncated};
  }
  validate(change,batch) {
    this.checkOwner();
    if(!change||Object.keys(change).some(k=>!Object.hasOwn(fields,k))||typeof change.key!=='string'||!keyPattern.test(change.key)||!Number.isSafeInteger(change.expected_revision)||change.expected_revision<0)throw new Error('Invalid learning change');
    for(const field of ['content','scope','expected_benefit','check'])if(typeof change[field]!=='string'||!change[field].trim()||change[field].length>(field==='content'?1800:500)||secretPattern.test(change[field])||authorityPattern.test(change[field])||change[field].includes('<!--'))throw new Error('Invalid learning content');
    const targets={rule:['PLAYBOOK.md','AGENTS.md'],preference:['USER.md'],style:['SOUL.md'],question:['PLAYBOOK.md']};
    if(!targets[change.kind]?.includes(change.target)||!fields.status.enum.includes(change.status))throw new Error('Invalid learning target/status');
    if(!Array.isArray(change.sources)||!change.sources.length||change.sources.length>10||!change.sources.some(s=>batch.records.some(r=>r.source===s)))throw new Error('Learning needs new batch evidence');
    const evidence=change.sources.map(s=>this.evidence(s)),current=this.get(change.key);
    if((current?.revision||0)!==change.expected_revision)throw new Error('Learning revision conflict');
    if(current?.offered&&change.kind==='question'&&current.content!==change.content)throw new Error('Do not rewrite an offered question');
    if(current&&(current.kind!==change.kind||current.target!==change.target))throw new Error('Learning kind/target conflict');
    if(current&&['retired','resolved'].includes(current.status))throw new Error('Do not revive dismissed learning automatically');
    if(change.kind==='rule') {
      if(!['trial','active','retired'].includes(change.status))throw new Error('Invalid rule state');
      if(change.status==='active') {
        if(!current||current.content!==change.content||current.scope!==change.scope||current.check!==change.check||current.expected_benefit!==change.expected_benefit)throw new Error('Promotion needs an unchanged trial');
        if(current.status==='trial') {
          const receipts=this.outcomes(current.key).filter(r=>r.candidate_revision===current.revision&&r.candidate_hash===current.candidate_hash&&r.check_hash===current.check_hash);
          if(receipts.some(r=>r.outcome==='regressed'))throw new ContractDenial('learning_regression');
          // Retained receipts stay in audit, but new promotion needs current
          // source authority. Deterministic checks have a distinct host contract.
          const improved=receipts.find(r=>r.outcome==='improved'&&r.evidence_ids.every(s=>this.usable({sources:[s]})&&change.sources.includes(s))&&
            (r.authority==='deterministic_check'||r.authority==='explicit_owner'&&r.evidence_ids.every(s=>evidence.some(e=>e.source===s&&e.original_owner_statement===true))));
          if(!improved)throw new ContractDenial('learning_outcome_required');
        }
      }
    } else if(change.kind==='question') {
      if(!['pending','resolved','retired'].includes(change.status)||change.status!=='pending'&&!current)throw new Error('Invalid question state');
    } else if(!['active','retired'].includes(change.status)||!evidence.some(e=>e.original_owner_statement===true))throw new ContractDenial('learning_owner_evidence_required');
    if(!current&&change.status==='retired')throw new Error('Cannot retire missing learning');
    const wasCurrent=current&&['trial','active','pending'].includes(current.status)&&this.usable(current);
    if(!wasCurrent&&['trial','active','pending'].includes(change.status)&&this.current({limit:40}).length>=40)throw new Error('Learning context capacity reached');
    return current;
  }
  put(change) {
    const current=this.get(change.key),revision=(current?.revision||0)+1,now=Date.now();
    const payload=JSON.stringify(change);
    this.db.prepare('INSERT INTO learning_records(user,key,payload,revision,updated) VALUES(?,?,?,?,?) ON CONFLICT(user,key) DO UPDATE SET payload=excluded.payload,revision=excluded.revision,updated=excluded.updated').run(this.owner,change.key,payload,revision,now);
    this.db.prepare('INSERT INTO learning_versions VALUES(?,?,?,?,?)').run(this.owner,change.key,revision,payload,now);
    if(current?.outbox_id&&['retired','resolved'].includes(change.status))this.db.prepare("UPDATE outbox SET state='cancelled' WHERE id=? AND user=? AND state='pending'").run(current.outbox_id,this.owner);
    if(change.kind==='rule'&&change.status==='trial')this.db.prepare('INSERT INTO learning_trial_bindings VALUES (?,?,?,?)').run(this.owner,change.key,revision,this.target());
    this.store.set('learning-export-dirty','1');
  }
  apply(batch,result,validation,reviewId) {
    if(typeof result.summary!=='string'||result.summary.length>4000||secretPattern.test(result.summary)||!Array.isArray(result.changes)||result.changes.length>5||new Set(result.changes.map(c=>c.key)).size!==result.changes.length)throw new Error('Invalid learning review');
    const decisions=validation.decisions;
    if(!Array.isArray(decisions)||decisions.length!==result.changes.length||new Set(decisions.map(d=>d.key)).size!==decisions.length||decisions.some(d=>!result.changes.some(c=>c.key===d.key)||typeof d.accept!=='boolean'||typeof d.reason!=='string'||d.reason.length>1500||secretPattern.test(d.reason)))throw new Error('Incomplete learning validation');
    let applied=0;
    this.store.transaction(()=>{
      if(Number(this.store.get(`learning-cursor:${this.owner}`)||0)!==batch.after)throw new Error('Learning cursor conflict');
      for(const change of result.changes){this.validate(change,batch);if(decisions.find(d=>d.key===change.key).accept){this.put(change);applied++;}}
      this.db.prepare('INSERT INTO learning_reviews VALUES(?,?,?,?)').run(reviewId,this.owner,Date.now(),JSON.stringify({coverage:{after:batch.after,cursor:batch.cursor,target:batch.target,truncated:batch.truncated},...result,validation}));
      this.store.set(`learning-cursor:${this.owner}`,batch.cursor);
    });
    return {applied,rejected:decisions.length-applied,markdown_synced:this.project()};
  }
  outcomes(key) {
    this.checkOwner();if(!keyPattern.test(key))throw new Error('Invalid learning key');
    return this.db.prepare('SELECT payload FROM learning_outcomes WHERE user=? AND key=? ORDER BY created,id').all(this.owner,key).map(row=>JSON.parse(row.payload));
  }
  // Host-only interface. Intentionally absent from the MCP/direct action registry.
  // Caller is authenticated command intake or trusted deterministic check code,
  // never a model validation result or self-claimed job success.
  recordOutcome(receipt,authority) {
    this.checkOwner();
    const allowed=['key','candidate_revision','candidate_hash','check_hash','outcome','observed_at','evidence_ids','run_id','attempt_id'];
    if(!receipt||Object.keys(receipt).some(k=>!allowed.includes(k))||!authority||Object.keys(authority).some(k=>k!=='kind')||!['explicit_owner','deterministic_check'].includes(authority.kind))throw new Error('Invalid host outcome authority');
    const current=this.get(receipt.key),binding=current&&this.db.prepare('SELECT evidence_cursor FROM learning_trial_bindings WHERE user=? AND key=? AND revision=?').get(this.owner,current.key,current.revision);
    if(!current||current.kind!=='rule'||current.status!=='trial'||!binding||current.review_state!=='ready'||receipt.candidate_revision!==current.revision||receipt.candidate_hash!==current.candidate_hash||receipt.check_hash!==current.check_hash||!['improved','inconclusive','regressed'].includes(receipt.outcome)||!Number.isSafeInteger(receipt.observed_at)||receipt.observed_at<=current.updated||receipt.observed_at>Date.now()+1000)throw new Error('Outcome candidate binding invalid');
    if(!Array.isArray(receipt.evidence_ids)||!receipt.evidence_ids.length||receipt.evidence_ids.length>10||new Set(receipt.evidence_ids).size!==receipt.evidence_ids.length)throw new Error('Outcome needs later evidence');
    for(const source of receipt.evidence_ids) {
      const evidence=this.evidence(source),event=this.db.prepare('SELECT id FROM learning_events WHERE user=? AND source=?').get(this.owner,source);
      if(!event||event.id<=binding.evidence_cursor||current.sources.includes(source)||evidence.created>receipt.observed_at||authority.kind==='explicit_owner'&&evidence.original_owner_statement!==true)throw new Error('Outcome needs later authorized evidence');
    }
    for(const field of ['run_id','attempt_id'])if(receipt[field]!==undefined&&(typeof receipt[field]!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(receipt[field])))throw new Error('Invalid outcome observation ID');
    if(receipt.attempt_id&&!receipt.run_id)throw new Error('Outcome attempt needs run');
    if(receipt.run_id) {
      const run=this.db.prepare('SELECT r.id FROM run_observations r JOIN observation_links l ON l.run_id=r.id JOIN conversations c ON c.id=l.conversation_id WHERE r.id=? AND r.terminal IS NOT NULL AND c.owner=?').get(receipt.run_id,this.owner);
      if(!run)throw new Error('Outcome run evidence unavailable');
      if(receipt.attempt_id&&!this.db.prepare('SELECT id FROM attempt_observations WHERE id=? AND run_id=?').get(receipt.attempt_id,receipt.run_id))throw new Error('Outcome attempt evidence unavailable');
    }
    const payload={id:randomUUID(),...receipt,authority:authority.kind};
    this.db.prepare('INSERT INTO learning_outcomes VALUES (?,?,?,?,?,?)').run(payload.id,this.owner,current.key,current.revision,Date.now(),JSON.stringify(payload));
    return payload;
  }
  feedback({key,expected_revision,action,sources}) {
    const current=this.get(key);
    if(!current||current.revision!==expected_revision||!['rollback','dismiss','resolve'].includes(action)||!Array.isArray(sources)||!sources.length||sources.length>10||!sources.every(s=>this.evidence(s).original_owner_statement===true))throw new ContractDenial('learning_feedback_invalid');
    if(action==='resolve'&&current.kind!=='question')throw new Error('Only questions can be resolved');
    const change=Object.fromEntries(Object.keys(fields).map(k=>[k,current[k]]));
    change.expected_revision=current.revision;change.status=action==='resolve'?'resolved':'retired';change.sources=[...new Set([...current.sources,...sources])].slice(-10);
    this.store.transaction(()=>{
      this.put(change);
      if(current.kind==='question'&&current.outbox_id)this.db.prepare("UPDATE outbox SET state='cancelled' WHERE id=? AND user=? AND state='pending'").run(current.outbox_id,this.owner);
    });
    return {updated:true,record:this.get(key),markdown_synced:this.project()};
  }
  offer(timezone,now=Date.now(),withinTransaction=false) {
    this.checkOwner();const day=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
    if(this.store.get(`learning-question-day:${this.owner}`)===day)return null;
    const question=this.current({kind:'question',status:'pending',unoffered:true,limit:1})[0];
    if(!question)return null;
    const queue=()=>{
      this.store.enqueue(this.owner,{text:question.content+'\n\n'+question.expected_benefit},true);
      const id=this.db.prepare('SELECT last_insert_rowid() AS n').get().n;
      this.db.prepare('UPDATE learning_records SET offered=?,outbox_id=? WHERE user=? AND key=?').run(now,id,this.owner,question.key);
      this.store.set(`learning-question-day:${this.owner}`,day);
    };
    if(withinTransaction)queue();else this.store.transaction(queue);
    return question.key;
  }
  previewForget(historyIds=[]) {
    this.checkOwner();const blocked=new Set([...this.blocked(),...historyIds.map(id=>'history:'+id)]),affected=[];
    for(const {key} of this.db.prepare('SELECT key FROM learning_records WHERE user=? ORDER BY key').all(this.owner)) {
      const record=this.get(key);if(!record.sources.some(s=>blocked.has(s)))continue;
      const pending=record.outbox_id&&this.db.prepare("SELECT id FROM outbox WHERE id=? AND user=? AND state='pending'").get(record.outbox_id,this.owner);
      affected.push({key,revision:record.revision,kind:record.kind,target:record.target,status:record.status,review_state:record.review_state,basis:'shared_history',versions_retained:this.db.prepare('SELECT count(*) AS n FROM learning_versions WHERE user=? AND key=?').get(this.owner,key).n,pending_question_cancelled:pending?.id??null});
    }
    return affected;
  }
  purgeForgotten() {
    // The legacy method name is retained for callers. A shared history ID does
    // not establish semantic dependence: preserve records and revisions for review.
    this.store.transaction(()=>{
      for(const record of this.previewForget())if(record.pending_question_cancelled)this.db.prepare("UPDATE outbox SET state='cancelled' WHERE id=? AND user=? AND state='pending'").run(record.pending_question_cancelled,this.owner);
      this.store.set('learning-export-dirty','1');
    });
    return this.project();
  }
  project() {
    try {
      const records=this.current();
      for(const target of ['PLAYBOOK.md','AGENTS.md','USER.md','SOUL.md']) {
        const dest=path.join(this.workspace,target),stat=fs.existsSync(dest)?fs.lstatSync(dest):null;
        if(stat&&(!stat.isFile()||stat.isSymbolicLink()))throw new Error('Unsafe learning projection');
        const old=stat?fs.readFileSync(dest,'utf8'):'';
        if(target==='PLAYBOOK.md'&&old&&!old.startsWith('# Assistant learning projection\n'))throw new Error('Existing unrelated playbook');
        const selected=records.filter(r=>target==='PLAYBOOK.md'||r.target===target);
        if(target!=='PLAYBOOK.md'&&!selected.length&&!old.includes(begin))continue;
        const body=selected.map(r=>`### ${r.key} (${r.status}, revision ${r.revision})\nScope: ${r.scope}\n${r.content}\nExpected benefit: ${r.expected_benefit}\nCheck: ${r.check}\nSources: ${r.sources.join(', ')}\n`).join('\n');
        const text=target==='PLAYBOOK.md'?'# Assistant learning projection\n\nGenerated from SQLite; do not edit. Trials are unproven.\n\n'+body:withoutLearning(old).trimEnd()+'\n\n'+begin+'\n## Learned adaptations\n'+body+end+'\n';
        if(text===old)continue;const temp=dest+'.'+randomUUID();
        try{fs.writeFileSync(temp,text,{flag:'wx',mode:stat?stat.mode&0o777:0o600});fs.renameSync(temp,dest);}finally{fs.rmSync(temp,{force:true});}
      }
      this.store.set('learning-export-dirty','0');return true;
    } catch {this.store.set('learning-export-dirty','1');console.error('Learning projection pending; private details suppressed');return false;}
  }
}
