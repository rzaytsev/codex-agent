import {interruptedOutcome} from './outcomes.js';
import {historyOrigin,knownQuote,trustedHistoryOrigin} from './owner-evidence.js';
import { observationsForStore } from './observations.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
export class AdmissionConflict extends Error {
  constructor() {super('Admission conflict: request key already identifies different intent');this.name='AdmissionConflict';}
}
// Fixed JSON ordering also normalizes omitted optional fields. Store hashes,
// rather than a second copy of private task/schedule instructions.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
export class Store {
  constructor(file) {
    this.file=file;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS inputs (id INTEGER PRIMARY KEY, user TEXT, payload TEXT, state TEXT DEFAULT 'pending', created INTEGER);
      CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, user TEXT, role TEXT, text TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, user TEXT, prompt TEXT, profile TEXT, state TEXT, result TEXT, created INTEGER, thread TEXT);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, user TEXT, kind TEXT, prompt TEXT, cron TEXT, timezone TEXT, due INTEGER, enabled INTEGER DEFAULT 1, unique_key TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, user TEXT, payload TEXT, state TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, due INTEGER, proactive INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS inputs_pending_order ON inputs(created,id) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS jobs_state_order ON jobs(state,created);
      CREATE INDEX IF NOT EXISTS jobs_user_order ON jobs(user,created DESC);
      CREATE INDEX IF NOT EXISTS schedules_due ON schedules(due) WHERE enabled=1;
      CREATE INDEX IF NOT EXISTS outbox_pending_order ON outbox(id) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS history_user_order ON history(user,id);
    `);
    // Additive: older databases keep every row and the legacy thread key.
    this.db.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, chat_id TEXT NOT NULL, message_thread_id INTEGER, kind TEXT NOT NULL, title TEXT, state TEXT NOT NULL DEFAULT 'active', settings TEXT NOT NULL DEFAULT '{}', session_id TEXT NOT NULL, UNIQUE(chat_id,message_thread_id));
      CREATE UNIQUE INDEX IF NOT EXISTS conversations_transport ON conversations(chat_id,coalesce(message_thread_id,0));
      CREATE TABLE IF NOT EXISTS history_origins (history_id INTEGER PRIMARY KEY, owner TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('direct_owner','owner_group','forwarded','bot','attachment','event','other')));
      CREATE TABLE IF NOT EXISTS main_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, thread TEXT, created INTEGER NOT NULL);`);
    // Additive host quote metadata; retained origins and audit are never rewritten.
    if(!this.db.prepare('PRAGMA table_info(history_origins)').all().some(c=>c.name==='known_quote'))this.db.exec('ALTER TABLE history_origins ADD COLUMN known_quote INTEGER NOT NULL DEFAULT 0 CHECK(known_quote IN (0,1))');
    // Unknown historical attribution cannot grant new authority. Do not infer
    // quote-aware provenance from old defaults, text, timestamps or unbound input.
    if(!this.db.prepare('PRAGMA table_info(history_origins)').all().some(c=>c.name==='provenance_version'))this.db.exec('ALTER TABLE history_origins ADD COLUMN provenance_version INTEGER NOT NULL DEFAULT 0 CHECK(provenance_version IN (0,1))');
    // No resource foreign key/cascade: retain admission audit through cleanup.
    this.db.exec(`CREATE TABLE IF NOT EXISTS admissions (
      owner TEXT NOT NULL, conversation_id TEXT NOT NULL, intent TEXT NOT NULL,
      request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, resource_id TEXT NOT NULL,
      response TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY(owner,conversation_id,intent,request_key));`);
    for(const table of ['inputs','history','jobs','schedules','outbox']) {
      const columns=this.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
      for(const [column,type] of [['conversation_id','TEXT'],['session_id','TEXT'],['actor_id','TEXT']])if(!columns.includes(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    // Nullable intent fields distinguish omitted legacy behavior from explicit
    // policies. No resource cascade: occurrence and owner receipts are audit.
    for(const [table,fields] of Object.entries({jobs:[['goal_outcome','TEXT'],['schedule_id','TEXT'],['scheduled_for','INTEGER']],schedules:[['overlap_policy','TEXT'],['misfire_policy','TEXT'],['catch_up_limit','INTEGER'],['misfire_grace_seconds','INTEGER'],['objective','TEXT'],['done_condition','TEXT'],['deadline','INTEGER'],['max_runs','INTEGER'],['runs','INTEGER NOT NULL DEFAULT 0'],['goal_state',"TEXT NOT NULL DEFAULT 'active'"]]})) {
      const columns=this.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
      for(const [column,type] of fields)if(!columns.includes(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_schedule_occurrence ON jobs(schedule_id,scheduled_for) WHERE schedule_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS schedule_occurrences (schedule_id TEXT NOT NULL, scheduled_for INTEGER NOT NULL, disposition TEXT NOT NULL, job_id TEXT, recorded_at INTEGER NOT NULL, conversation_id TEXT, session_id TEXT, actor_id TEXT, skipped_before INTEGER, PRIMARY KEY(schedule_id,scheduled_for));
      CREATE TABLE IF NOT EXISTS schedule_goal_receipts (schedule_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, goal_hash TEXT NOT NULL, owner TEXT NOT NULL, conversation_id TEXT NOT NULL, evidence_id INTEGER NOT NULL, authority TEXT NOT NULL CHECK(authority='explicit_owner'), recorded_at INTEGER NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, filename TEXT NOT NULL, owner TEXT NOT NULL, conversation_id TEXT, session_id TEXT, actor_id TEXT NOT NULL, created INTEGER NOT NULL);`);
    const outboxColumns=this.db.prepare('PRAGMA table_info(outbox)').all().map(c=>c.name);
    if(!outboxColumns.includes('artifact_id'))this.db.exec('ALTER TABLE outbox ADD COLUMN artifact_id TEXT REFERENCES artifacts(id)');
    if(!outboxColumns.includes('legacy_state'))this.db.exec('ALTER TABLE outbox ADD COLUMN legacy_state TEXT');
    // Do not fabricate enqueue-time immutability for retained path-only rows.
    this.db.exec("UPDATE outbox SET legacy_state=state,state='legacy' WHERE state IN ('pending','sending','uncertain') AND json_valid(payload) AND json_extract(payload,'$.type') IN ('file','voice','photo') AND json_extract(payload,'$.artifactId') IS NULL");
    this.db.exec(`CREATE INDEX IF NOT EXISTS inputs_conversation_pending ON inputs(conversation_id,created,id) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS jobs_conversation_state ON jobs(conversation_id,state,created);
      CREATE INDEX IF NOT EXISTS history_conversation_order ON history(conversation_id,user,id);
      CREATE INDEX IF NOT EXISTS outbox_conversation_pending ON outbox(conversation_id,id) WHERE state='pending';
      CREATE INDEX IF NOT EXISTS schedules_conversation_due ON schedules(conversation_id,due) WHERE enabled=1;`);
    this.observations=observationsForStore(this);
  }
  bindConversation(owner,{id=randomUUID(),chatId=owner,kind='dm',title='',sessionId=randomUUID()}={}) {
    return this.transaction(()=>{
      const previous=this.get('conversation-owner');if(previous&&previous!==owner)throw new Error('Conversation belongs to another owner');
      let row=kind==='group'?this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id):this.db.prepare('SELECT * FROM conversations WHERE kind=? LIMIT 1').get(kind);
      if(row&&(row.owner!==owner||(kind==='group'&&row.id!==id)))throw new Error('Conversation identity mismatch');
      if(!row){const session=sessionId;this.db.prepare('INSERT INTO conversations(id,owner,chat_id,kind,title,session_id) VALUES (?,?,?,?,?,?)').run(id,owner,chatId,kind,title,session);this.db.prepare('INSERT INTO main_sessions VALUES (?,?,?,?)').run(session,id,this.get(`thread:${owner}`)||null,Date.now());row=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);}
      this.conversationId=row.id;this.kind=kind;
      this.set('conversation-owner',owner);this.set('conversation-id',row.id);this.set('main-session',row.session_id);
      this.db.prepare('INSERT OR IGNORE INTO main_sessions VALUES (?,?,NULL,?)').run(row.session_id,row.id,Date.now());
      if(kind==='dm')for(const table of ['inputs','history','jobs','schedules','outbox'])this.db.prepare(`UPDATE ${table} SET conversation_id=?,session_id=?,actor_id=coalesce(actor_id,user) WHERE conversation_id IS NULL`).run(row.id,row.session_id);
      // Stamp all existing insert paths, including maintenance and auth delivery.
      for(const table of ['inputs','history','jobs','schedules','outbox'])this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_conversation AFTER INSERT ON ${table} BEGIN UPDATE ${table} SET conversation_id=coalesce(NEW.conversation_id,(SELECT value FROM meta WHERE key='conversation-id')),session_id=coalesce(NEW.session_id,(SELECT value FROM meta WHERE key='main-session')),actor_id=coalesce(NEW.actor_id,NEW.user) WHERE rowid=NEW.rowid; END;`);
      return row;
    });
  }
  // Explicit query scopes keep the existing SQL readable. Never infer scope from
  // the last active chat or rewrite arbitrary SQL automatically.
  prepare(sql) {return this.db.prepare(sql.replaceAll('$scope',this.conversationId?`conversation_id='${this.conversationId.replaceAll("'","''")}'`:'conversation_id IS NULL'));}
  metaKey(key) {return this.kind==='group'?`conversation:${this.conversationId}:${key}`:key;}
  rotateSession(user) {
    const conversation=this.get('conversation-id');if(!conversation){this.set(`thread:${user}`,'');return;}
    this.transaction(()=>{const id=randomUUID();this.db.prepare('INSERT INTO main_sessions VALUES (?,?,NULL,?)').run(id,conversation,Date.now());this.db.prepare('UPDATE conversations SET session_id=? WHERE id=?').run(id,conversation);this.set('main-session',id);this.set(`thread:${user}`,'');});
  }
  get(key) {if(key==='conversation-id'&&this.conversationId)return this.conversationId;if(key==='main-session'&&this.conversationId)return this.db.prepare('SELECT session_id FROM conversations WHERE id=?').get(this.conversationId)?.session_id;return this.db.prepare('SELECT value FROM meta WHERE key=?').get(this.metaKey(key))?.value; }
  set(key,value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.metaKey(key),String(value));if(key.startsWith('thread:')&&this.get('main-session'))this.db.prepare('UPDATE main_sessions SET thread=? WHERE id=?').run(String(value),this.get('main-session')); }
  ingest(id,user,payload) { return this.db.prepare('INSERT OR IGNORE INTO inputs(id,user,payload,created,conversation_id,session_id) VALUES (?,?,?,?,?,?)').run(id,user,JSON.stringify(payload),Date.now(),this.conversationId||null,this.get('main-session')||null).changes > 0; }
  history(user,role,text,actorId=user) { this.db.prepare('INSERT INTO history(user,role,text,created,actor_id,conversation_id,session_id) VALUES (?,?,?,?,?,?,?)').run(user,role,text,Date.now(),actorId,this.conversationId||null,this.get('main-session')||null); return Number(this.db.prepare('SELECT last_insert_rowid() AS id').get().id); }
  // Only host intake uses this path; ordinary history inserts grant no authority.
  ownerHistory(cfg,message,text) {
    const write=()=>{
      const id=Store.prototype.history.call(this,cfg.owner,message.event?'event':'user',text,String(message.from?.id||cfg.owner));
      this.db.prepare('INSERT INTO history_origins(history_id,owner,origin,known_quote,provenance_version) VALUES (?,?,?,?,1)').run(id,cfg.owner,historyOrigin(message,cfg),Number(knownQuote(message)));
      return id;
    };
    return this.db.isTransaction?write():this.transaction(write);
  }
  historySource(id,owner) {
    const row=this.db.prepare('SELECT origin,known_quote,provenance_version FROM history_origins WHERE history_id=? AND owner=?').get(id,owner);
    return trustedHistoryOrigin(row);
  }
  search(user,query='',since=0,{all=false}={}) { return this.prepare(`SELECT id,role,text,created,conversation_id FROM history WHERE ${all?'1':'$scope'} AND user=? AND created>=? AND instr(lower(text),lower(?))>0 ORDER BY id DESC LIMIT 100`).all(user,since,query).reverse(); }
  historyPage(user,{after=0,since=0,until=Date.now(),limit=50,all=false}={}) {
    if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>50||!Number.isFinite(since)||!Number.isFinite(until)) throw new Error('Invalid history page');
    const rows=this.prepare(`SELECT id,role,text,created,conversation_id FROM history WHERE ${all?'1':'$scope'} AND user=? AND id>? AND created>=? AND created<=? ORDER BY id LIMIT ?`).all(user,after,since,until,limit+1);
    const records=rows.slice(0,limit);return {records,next_cursor:records.at(-1)?.id||after,has_more:rows.length>limit};
  }
  recordArtifact(a) {this.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?)').run(a.id,a.sha256,a.size,a.mime,a.filename,a.owner,a.conversation_id,a.session_id,a.actor_id,a.created);}
  enqueue(user,payload,proactive=false,{sessionId,actorId}={}) {
    const session=sessionId||this.get('main-session')||null,actor=actorId||user,conversation=this.conversationId||null;
    if(payload.artifactId) {
      const a=this.db.prepare('SELECT * FROM artifacts WHERE id=?').get(payload.artifactId);
      if(!a||a.owner!==user||a.conversation_id!==conversation||a.session_id!==session||a.actor_id!==actor)throw new Error('Artifact route mismatch');
    }
    this.db.prepare('INSERT INTO outbox(user,payload,due,proactive,session_id,actor_id,conversation_id,artifact_id) VALUES (?,?,?,?,?,?,?,?)').run(user,JSON.stringify(payload),Date.now(),Number(proactive),session,actor,conversation,payload.artifactId||null);this.onEnqueue?.();
  }
  job(user,prompt,profile='worker') { const id = randomUUID(); this.db.prepare('INSERT INTO jobs(id,user,prompt,profile,state,created,conversation_id,session_id) VALUES (?,?,?,?,?,?,?,?)').run(id,user,prompt,profile,'queued',Date.now(),this.conversationId||null,this.get('main-session')||null); return id; }
  schedule(id,user,kind,prompt,cron,timezone,due,key) {this.db.prepare('INSERT OR IGNORE INTO schedules(id,user,kind,prompt,cron,timezone,due,unique_key,conversation_id,session_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id,user,kind,prompt,cron,timezone,due,key,this.conversationId||null,this.get('main-session')||null);}
  jobs(user,id) {
    const select='SELECT id,profile,state,created,result,goal_outcome FROM jobs WHERE $scope AND user=?';
    const rows=id===undefined?this.prepare(select+' ORDER BY created DESC LIMIT 30').all(user):this.prepare(select+' AND id=?').all(user,id);
    return rows.map(row=>({...row,goal_outcome:row.goal_outcome?JSON.parse(row.goal_outcome):interruptedOutcome()}));
  }
  admit(owner,intent,key,payload,create) {
    const conversation=this.conversationId||'',fingerprint=createHash('sha256').update(JSON.stringify(canonical({version:1,owner,conversation,intent,...payload}))).digest('hex');
    return this.transaction(()=>{
      if(key!==undefined) {
        const previous=this.db.prepare('SELECT fingerprint,response FROM admissions WHERE owner=? AND conversation_id=? AND intent=? AND request_key=?').get(owner,conversation,intent,key);
        if(previous) {if(previous.fingerprint!==fingerprint)throw new AdmissionConflict();return JSON.parse(previous.response);}
      }
      const response=create();
      if(key!==undefined)this.db.prepare('INSERT INTO admissions VALUES (?,?,?,?,?,?,?,?)').run(owner,conversation,intent,key,fingerprint,response.id,JSON.stringify(response),Date.now());
      return response;
    });
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  recover() {
    return this.transaction(() => {
      for(const j of this.prepare("SELECT id FROM jobs WHERE $scope AND state='cancel_requested'").all())this.prepare("UPDATE jobs SET result=?,goal_outcome=coalesce(goal_outcome,?) WHERE $scope AND id=?").run('Cancellation requested before restart; execution exit unknown. Reconcile effects and require fresh owner intent.',JSON.stringify(interruptedOutcome()),j.id);
      const interrupted = this.prepare("SELECT * FROM jobs WHERE $scope AND state='running'").all();
      for (const j of interrupted) { this.db.prepare("UPDATE jobs SET state='interrupted' WHERE id=?").run(j.id); if(!this.get(`memory-job:${j.id}`)&&!this.get(`learning-job:${j.id}`))this.enqueue(j.user,{text:`Task ${j.id} was interrupted by a restart. Reconcile effects and give fresh owner intent; external actions will not be retried blindly.`}); }
      const inputs = this.prepare("SELECT * FROM inputs WHERE $scope AND state='processing'").all();
      for (const i of inputs) this.enqueue(i.user,{text:`Message ${i.id} was interrupted by a restart. Please ask me to review it before retrying actions.`});
      this.prepare("UPDATE inputs SET state='interrupted' WHERE $scope AND state='processing'").run();this.prepare("UPDATE outbox SET state='uncertain' WHERE $scope AND state='sending'").run();
    });
  }
}
