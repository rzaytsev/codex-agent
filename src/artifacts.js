import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { mimeType } from './telegram.js';
const MAX=49*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
export class ArtifactError extends Error {constructor(){super('Artifact rejected: unsafe path, route or integrity');this.code='artifact';}}
// Node has no portable openat walk. Check every component before and after the
// descriptor copy and compare identities; this detects path replacement but is
// not isolation from malicious code with the same filesystem grant.
async function walk(root,file) {
  const relative=path.relative(root,file);if(!relative||relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))throw new ArtifactError();
  const entries=[];let current=root;
  for(const part of relative.split(path.sep)) {current=path.join(current,part);const stat=await fs.lstat(current,{bigint:true});if(stat.isSymbolicLink())throw new ArtifactError();entries.push([current,stat]);}
  if(await fs.realpath(file)!==file)throw new ArtifactError();return entries;
}
async function unchanged(entries) {for(const [file,before] of entries){const after=await fs.lstat(file,{bigint:true});if(after.isSymbolicLink()||after.dev!==before.dev||after.ino!==before.ino)throw new ArtifactError();}}
async function boundedRead(handle) {
  const parts=[];let size=0;
  while(true) {const part=Buffer.alloc(Math.min(1024*1024,MAX+1-size));const {bytesRead}=await handle.read(part,0,part.length,null);if(!bytesRead)break;size+=bytesRead;if(size>MAX)throw new ArtifactError();parts.push(part.subarray(0,bytesRead));}
  return Buffer.concat(parts,size);
}
export class Artifacts {
  constructor(cfg,store){this.cfg=cfg;this.store=store;}
  async root() {return fs.realpath(this.cfg.workspace);}
  async storage(root) {
    const state=path.join(root,'state'),dir=path.join(state,'outbox-artifacts');
    await fs.mkdir(state,{recursive:true,mode:0o700});await walk(root,state);
    await fs.mkdir(dir,{mode:0o700,recursive:true});await walk(root,dir);await fs.chmod(dir,0o700);return dir;
  }
  safeSource(root,file) {
    const relative=path.relative(root,file),parts=relative.split(path.sep),name=parts.at(-1).toLowerCase();
    const logical=path.resolve(this.cfg.workspace),rebase=value=>{const requested=path.resolve(value);return requested.startsWith(root+path.sep)?requested:path.resolve(root,path.relative(logical,requested));};
    // Path policy prevents ordinary service exports of known operational data.
    // Renaming/copying private contents via arbitrary code remains out of scope.
    if(parts.some(p=>p.startsWith('.')||/^(state|private|profiles|credentials|auth|codex|backups)$/i.test(p))||/^(agents|soul|user|core|playbook)\.md$/i.test(name)||/^(auth\.json|credentials(?:\.json)?|secrets?(?:\.json)?|tokens?(?:\.json)?|id_rsa|id_ed25519)$/i.test(name)||/\.(sqlite(?:-wal|-shm)?|db(?:-wal|-shm)?|pem|key|p12|pfx|env)$/i.test(name)||file===rebase(this.store.file))throw new ArtifactError();
    if(this.cfg.codexHome){const home=rebase(this.cfg.codexHome);if(file===home||file.startsWith(home+path.sep))throw new ArtifactError();}
  }
  async snapshot(user,payload,{sessionId,actorId}={},signal) {
    signal?.throwIfAborted();if(user!==this.cfg.owner)throw new ArtifactError();
    const root=await this.root(),logical=path.resolve(this.cfg.workspace),requested=path.resolve(logical,payload.path);
    const file=requested.startsWith(root+path.sep)?requested:path.resolve(root,path.relative(logical,requested));this.safeSource(root,file);
    const entries=await walk(root,file);let source,dest;
    try {
      source=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      const before=await source.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size>BigInt(MAX)||!same(before,entries.at(-1)[1]))throw new ArtifactError();
      const bytes=await boundedRead(source);signal?.throwIfAborted();
      if(bytes.length>MAX||!same(before,await source.stat({bigint:true})))throw new ArtifactError();await unchanged(entries);
      const dir=await this.storage(root),id=randomUUID(),snapshot=path.join(dir,id);
      dest=await fs.open(snapshot,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      await dest.writeFile(bytes);await dest.sync();await dest.close();dest=null;
      // Flush directory entry before committing a durable SQLite reference.
      for(const directoryPath of [dir,path.dirname(dir),root]) {const directory=await fs.open(directoryPath,fs.constants.O_RDONLY);try{await directory.sync();}finally{await directory.close();}}
      await walk(root,snapshot);signal?.throwIfAborted();
      const artifact={id,sha256:hash(bytes),size:bytes.length,mime:payload.type==='voice'?'audio/ogg':mimeType(file),filename:path.basename(file),owner:user,conversation_id:this.store.get('conversation-id')||null,session_id:sessionId||this.store.get('main-session')||null,actor_id:actorId||user,created:Date.now()};
      this.store.recordArtifact(artifact);
      return {...payload,path:snapshot,artifactId:id};
    } finally {await source?.close();await dest?.close();}
  }
  async load(row,payload) {
    try {
      const a=this.store.db.prepare('SELECT * FROM artifacts WHERE id=?').get(payload.artifactId);
      if(!a||row.artifact_id!==a.id||a.owner!==this.cfg.owner||row.user!==a.owner||a.conversation_id!==row.conversation_id||a.conversation_id!==(this.store.get('conversation-id')||null)||a.session_id!==row.session_id||a.actor_id!==row.actor_id)throw new ArtifactError();
      const root=await this.root(),file=path.join(root,'state','outbox-artifacts',a.id);
      if(!/^[a-f0-9-]{36}$/.test(a.id)||payload.path!==file)throw new ArtifactError();
      const entries=await walk(root,file),handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let bytes;
      try {
        const before=await handle.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(a.size)||before.size>BigInt(MAX)||!same(before,entries.at(-1)[1]))throw new ArtifactError();
        bytes=await boundedRead(handle);if(!same(before,await handle.stat({bigint:true})))throw new ArtifactError();await unchanged(entries);
      }finally{await handle.close();}
      if(bytes.length!==a.size||hash(bytes)!==a.sha256)throw new ArtifactError();
      // These very bytes are sent. Telegram never reopens the snapshot path.
      const {path:unused,...rest}=payload;return {...rest,bytes,filename:a.filename,mime:a.mime};
    }catch {throw new ArtifactError();}
  }
}
