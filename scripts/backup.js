import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
const [source,destination]=process.argv.slice(2);
if(!source||!destination) throw new Error('Usage: node scripts/backup.js <database> <snapshot-path>');
const resolved=path.resolve(destination);fs.mkdirSync(path.dirname(resolved),{recursive:true,mode:0o700});
if(fs.existsSync(resolved)) throw new Error('Snapshot destination already exists');
const db=new DatabaseSync(source,{readOnly:true});await backup(db,resolved);db.close();fs.chmodSync(resolved,0o600);console.log('Consistent SQLite snapshot created');
