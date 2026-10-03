import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
export class Store {
  constructor(file) {
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
      CREATE TABLE IF NOT EXISTS main_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, thread TEXT, created INTEGER NOT NULL);`);
    for(const table of ['inputs','history','jobs','schedules','outbox']) {
      const columns=this.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
      for(const [column,type] of [['conversation_id','TEXT'],['session_id','TEXT'],['actor_id','TEXT']])if(!columns.includes(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  bindConversation(owner,{id=randomUUID(),chatId=owner,kind='dm',title='',sessionId=randomUUID()}={}) {
    return this.transaction(()=>{
      const previous=this.get('conversation-owner');if(previous&&previous!==owner)throw new Error('Conversation belongs to another owner');
      let row=this.db.prepare('SELECT * FROM conversations WHERE kind=? LIMIT 1').get(kind);
      if(row&&(row.owner!==owner||(kind==='group'&&row.id!==id)))throw new Error('Conversation identity mismatch');
      if(!row){const session=sessionId;this.db.prepare('INSERT INTO conversations(id,owner,chat_id,kind,title,session_id) VALUES (?,?,?,?,?,?)').run(id,owner,chatId,kind,title,session);this.db.prepare('INSERT INTO main_sessions VALUES (?,?,?,?)').run(session,id,this.get(`thread:${owner}`)||null,Date.now());row=this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id);}
      this.set('conversation-owner',owner);this.set('conversation-id',row.id);this.set('main-session',row.session_id);
      for(const table of ['inputs','history','jobs','schedules','outbox'])this.db.prepare(`UPDATE ${table} SET conversation_id=?,session_id=?,actor_id=coalesce(actor_id,user) WHERE conversation_id IS NULL`).run(row.id,row.session_id);
      // Stamp all existing insert paths, including maintenance and auth delivery.
      for(const table of ['inputs','history','jobs','schedules','outbox'])this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_conversation AFTER INSERT ON ${table} BEGIN UPDATE ${table} SET conversation_id=coalesce(NEW.conversation_id,(SELECT value FROM meta WHERE key='conversation-id')),session_id=coalesce(NEW.session_id,(SELECT value FROM meta WHERE key='main-session')),actor_id=coalesce(NEW.actor_id,NEW.user) WHERE rowid=NEW.rowid; END;`);
      return row;
    });
  }
  rotateSession(user) {
    const conversation=this.get('conversation-id');if(!conversation){this.set(`thread:${user}`,'');return;}
    this.transaction(()=>{const id=randomUUID();this.db.prepare('INSERT INTO main_sessions VALUES (?,?,NULL,?)').run(id,conversation,Date.now());this.db.prepare('UPDATE conversations SET session_id=? WHERE id=?').run(id,conversation);this.set('main-session',id);this.set(`thread:${user}`,'');});
  }
  get(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  set(key,value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));if(key.startsWith('thread:')&&this.get('main-session'))this.db.prepare('UPDATE main_sessions SET thread=? WHERE id=?').run(String(value),this.get('main-session')); }
  ingest(id,user,payload) { return this.db.prepare('INSERT OR IGNORE INTO inputs(id,user,payload,created) VALUES (?,?,?,?)').run(id,user,JSON.stringify(payload),Date.now()).changes > 0; }
  history(user,role,text,actorId=user) { this.db.prepare('INSERT INTO history(user,role,text,created,actor_id) VALUES (?,?,?,?,?)').run(user,role,text,Date.now(),actorId); }
  search(user,query='',since=0) { return this.db.prepare('SELECT id,role,text,created FROM history WHERE user=? AND created>=? AND instr(lower(text),lower(?))>0 ORDER BY id DESC LIMIT 100').all(user,since,query).reverse(); }
  historyPage(user,{after=0,since=0,until=Date.now(),limit=50}={}) {
    if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>50||!Number.isFinite(since)||!Number.isFinite(until)) throw new Error('Invalid history page');
    const rows=this.db.prepare('SELECT id,role,text,created FROM history WHERE user=? AND id>? AND created>=? AND created<=? ORDER BY id LIMIT ?').all(user,after,since,until,limit+1);
    const records=rows.slice(0,limit);return {records,next_cursor:records.at(-1)?.id||after,has_more:rows.length>limit};
  }
  enqueue(user,payload,proactive=false,{sessionId,actorId}={}) { this.db.prepare('INSERT INTO outbox(user,payload,due,proactive,session_id,actor_id) VALUES (?,?,?,?,?,?)').run(user,JSON.stringify(payload),Date.now(),Number(proactive),sessionId||null,actorId||null); }
  job(user,prompt,profile='worker') { const id = randomUUID(); this.db.prepare('INSERT INTO jobs(id,user,prompt,profile,state,created) VALUES (?,?,?,?,?,?)').run(id,user,prompt,profile,'queued',Date.now()); return id; }
  jobs(user) { return this.db.prepare('SELECT id,profile,state,created,result FROM jobs WHERE user=? ORDER BY created DESC LIMIT 30').all(user); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  recover() {
    return this.transaction(() => {
      const interrupted = this.db.prepare("SELECT * FROM jobs WHERE state='running'").all();
      for (const j of interrupted) { this.db.prepare("UPDATE jobs SET state='interrupted' WHERE id=?").run(j.id); if(!this.get(`memory-job:${j.id}`)&&!this.get(`learning-job:${j.id}`))this.enqueue(j.user,{text:`Task ${j.id} was interrupted by a restart. Ask me to review/resume it; external actions will not be retried blindly.`}); }
      const inputs = this.db.prepare("SELECT * FROM inputs WHERE state='processing'").all();
      for (const i of inputs) this.enqueue(i.user,{text:`Message ${i.id} was interrupted by a restart. Please ask me to review it before retrying actions.`});
      this.db.exec("UPDATE inputs SET state='interrupted' WHERE state='processing'; UPDATE outbox SET state='uncertain' WHERE state='sending';");
    });
  }
}
