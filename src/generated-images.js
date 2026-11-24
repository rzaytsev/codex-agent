import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Only the trusted CLI's current thread may supply generated output. Never accept
// a model-selected source path or inspect credentials/other thread directories.
async function imageDirectory(home,thread) {
  if(typeof home!=='string'||!(/^[a-f0-9-]{36}$/i.test(thread||'')))return null;
  const parent=path.join(home,'generated_images'),source=path.join(parent,thread);
  for(const dir of [parent,source]) {
    let s;try{s=await fs.lstat(dir);}catch(e){if(e.code==='ENOENT')return null;throw e;}
    if(!s.isDirectory()||s.isSymbolicLink())throw new Error('Unsafe generated image directory');
  }
  return source;
}

export async function generatedImageNames(home,thread) {
  const dir=await imageDirectory(home,thread);return dir?await fs.readdir(dir):[];
}

export async function collectGeneratedImages(home,thread,workspace,signal,existing=[]) {
  const source=await imageDirectory(home,thread);if(!source)return [];
  const excluded=new Set(existing),names=(await fs.readdir(source)).filter(name=>!excluded.has(name));
  if(names.length>32)throw new Error('Too many generated image entries');
  const root=await fs.realpath(workspace),outputs=path.join(root,'outputs');
  let directory,total=0;const result=[];
  for(const name of names.sort()) {
    signal?.throwIfAborted();if(!/\.(png|jpe?g)$/i.test(name))continue;
    if(result.length>=4)throw new Error('Too many generated images');
    const file=path.join(source,name),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>16*1024*1024)throw new Error('Unsafe generated image');
    const handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    let bytes;
    try {
      const before=await handle.stat();if(before.ino!==stat.ino||before.dev!==stat.dev||before.size!==stat.size)throw new Error('Generated image changed');
      const parts=[];let size=0;
      while(true) {
        const part=Buffer.alloc(Math.min(1024*1024,16*1024*1024+1-size));
        const {bytesRead}=await handle.read(part,0,part.length,null);if(!bytesRead)break;
        size+=bytesRead;if(size>16*1024*1024)throw new Error('Generated image byte limit');
        parts.push(part.subarray(0,bytesRead));
      }
      bytes=Buffer.concat(parts,size);const after=await handle.stat();
      if(bytes.length!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new Error('Generated image changed');
    }finally{await handle.close();}
    const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    if(!png&&!jpeg)throw new Error('Invalid generated image');
    total+=bytes.length;if(total>16*1024*1024)throw new Error('Generated image byte limit');
    await fs.mkdir(outputs,{recursive:true,mode:0o700});if((await fs.lstat(outputs)).isSymbolicLink())throw new Error('Unsafe output directory');
    if(!directory)directory=await fs.mkdtemp(path.join(outputs,'imagegen-'));
    signal?.throwIfAborted();const dest=path.join(directory,randomUUID()+(png?'.png':'.jpg'));
    await fs.writeFile(dest,bytes,{flag:'wx',mode:0o600});result.push(dest);
  }
  return result;
}
