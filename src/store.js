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
  }
  get(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value; }
  set(key,value) { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value)); }
  ingest(id,user,payload) { return this.db.prepare('INSERT OR IGNORE INTO inputs(id,user,payload,created) VALUES (?,?,?,?)').run(id,user,JSON.stringify(payload),Date.now()).changes > 0; }
  history(user,role,text) { this.db.prepare('INSERT INTO history(user,role,text,created) VALUES (?,?,?,?)').run(user,role,text,Date.now()); }
  search(user,query='',since=0) { return this.db.prepare('SELECT id,role,text,created FROM history WHERE user=? AND created>=? AND instr(lower(text),lower(?))>0 ORDER BY id DESC LIMIT 100').all(user,since,query).reverse(); }
  historyPage(user,{after=0,since=0,until=Date.now(),limit=50}={}) {
    if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>50||!Number.isFinite(since)||!Number.isFinite(until)) throw new Error('Invalid history page');
    const rows=this.db.prepare('SELECT id,role,text,created FROM history WHERE user=? AND id>? AND created>=? AND created<=? ORDER BY id LIMIT ?').all(user,after,since,until,limit+1);
    const records=rows.slice(0,limit);return {records,next_cursor:records.at(-1)?.id||after,has_more:rows.length>limit};
  }
  enqueue(user,payload,proactive=false) { this.db.prepare('INSERT INTO outbox(user,payload,due,proactive) VALUES (?,?,?,?)').run(user,JSON.stringify(payload),Date.now(),Number(proactive)); }
  job(user,prompt,profile='worker') { const id = randomUUID(); this.db.prepare('INSERT INTO jobs(id,user,prompt,profile,state,created) VALUES (?,?,?,?,?,?)').run(id,user,prompt,profile,'queued',Date.now()); return id; }
  jobs(user) { return this.db.prepare('SELECT id,profile,state,created,result FROM jobs WHERE user=? ORDER BY created DESC LIMIT 30').all(user); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  recover() {
    return this.transaction(() => {
      const interrupted = this.db.prepare("SELECT * FROM jobs WHERE state='running'").all();
      for (const j of interrupted) { this.db.prepare("UPDATE jobs SET state='interrupted' WHERE id=?").run(j.id); if(!this.get(`memory-job:${j.id}`))this.enqueue(j.user,{text:`Task ${j.id} was interrupted by a restart. Ask me to review/resume it; external actions will not be retried blindly.`}); }
      const inputs = this.db.prepare("SELECT * FROM inputs WHERE state='processing'").all();
      for (const i of inputs) this.enqueue(i.user,{text:`Message ${i.id} was interrupted by a restart. Please ask me to review it before retrying actions.`});
      this.db.exec("UPDATE inputs SET state='interrupted' WHERE state='processing'; UPDATE outbox SET state='uncertain' WHERE state='sending';");
    });
  }
}
