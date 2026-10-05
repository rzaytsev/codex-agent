import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withoutLearning } from './learning.js';

function managed(text) {
  withoutLearning(text); // Reject malformed or duplicated service-owned markers.
  return text.match(/<!-- assistant-learning:begin -->[\s\S]*?<!-- assistant-learning:end -->/)?.[0]||'';
}
export class Profiles {
  constructor(workspace) {this.workspace=workspace;this.reads=new WeakMap();}
  snapshot(file) {
    if(!['USER.md','SOUL.md'].includes(file))throw new Error('Invalid profile');
    const dest=path.join(this.workspace,file),stat=fs.lstatSync(dest);
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Unsafe profile');
    const content=fs.readFileSync(dest,'utf8');
    return {file,content,hash:createHash('sha256').update(content).digest('hex')};
  }
  read(file,cap) {
    const current=this.snapshot(file),reads=this.reads.get(cap)||new Map();
    reads.set(file,current.hash);this.reads.set(cap,reads);return current;
  }
  write(args,cap,patch=false) {
    // Keep comparison and rename synchronous: all conversation mains and learning
    // projection share this service process. This is not a cross-process lock.
    const current=this.snapshot(args.file),reads=this.reads.get(cap);
    if(args.expected_hash!==undefined&&(typeof args.expected_hash!=='string'||!/^[a-f0-9]{64}$/.test(args.expected_hash)))throw new Error('Invalid profile hash');
    if(patch&&args.expected_hash===undefined)throw new Error('Profile patch requires expected hash');
    if(!patch&&(typeof args.content!=='string'||args.content.length>50000))throw new Error('Invalid profile');
    if(patch&&(typeof args.old_text!=='string'||!args.old_text||args.old_text.length>50000||typeof args.new_text!=='string'||args.new_text.length>50000))throw new Error('Invalid profile patch');
    const expected=args.expected_hash??reads?.get(args.file);
    if(!expected||expected!==current.hash)return {updated:false,conflict:true,reason:expected?'stale_hash':'read_required',current};
    let content=args.content;
    if(patch) {
      const index=current.content.indexOf(args.old_text);
      if(index<0||current.content.indexOf(args.old_text,index+1)>=0)throw new Error('Profile patch must match exactly once');
      content=current.content.slice(0,index)+args.new_text+current.content.slice(index+args.old_text.length);
    }
    const before=managed(current.content),after=managed(content);
    if(after!==before) {
      if(patch||after)throw new Error('Cannot edit managed learning section');
      // Legacy full replacements may omit the generated section; retain it.
      content+=(content.endsWith('\n')?'\n':'\n\n')+before+'\n';
    }
    if(content.length>50000)throw new Error('Invalid profile size');
    const dest=path.join(this.workspace,args.file),temp=dest+'.'+randomUUID();
    try {
      fs.writeFileSync(temp,content,{flag:'wx',mode:0o600});
      cap.signal?.throwIfAborted();fs.renameSync(temp,dest);
      reads?.delete(args.file); // A second legacy replacement must read again.
      return {updated:args.file};
    } finally {fs.rmSync(temp,{force:true});}
  }
}
