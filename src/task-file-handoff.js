import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const taskFileLimit = 8 * 1024 * 1024;
const frameLimit = 12 * 1024 * 1024;
export const taskFileCount = 4;
const rejected = () => new Error('Task file handoff unavailable');
const inputDirectory = '/workspace/input';
const outputDirectory = '/workspace/output';

export function taskOutputName(file) {
  const name = path.posix.basename(file);
  if (file !== outputDirectory + '/' + name || !/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,127}$/.test(name)) throw rejected();
  return name;
}

async function* frames(socket) {
  let parts = [], size = 0;
  for await (const chunk of socket.iterator({destroyOnReturn:false})) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      size += part.length;
      if (size > frameLimit) throw rejected();
      parts.push(part);
      if (end < 0) break;
      const raw = Buffer.concat(parts, size).toString('utf8');
      parts = []; size = 0; start = end + 1;
      yield {raw, value:JSON.parse(raw)};
    }
  }
  if (size) throw rejected();
}

async function write(socket, line) {
  if (socket.destroyed || socket.writableEnded) throw rejected();
  await new Promise((resolve,reject) => socket.write(line+'\n',error => error?reject(rejected()):resolve()));
}

export async function startTaskFileHandoff(home, upstreamPath, input, signal) {
  signal?.throwIfAborted();
  const endpoint = path.join(home,'executor.sock');
  let harness, runner, ready = false, used = false, sequence = 0;
  const pending = new Map();
  const close = () => {
    signal?.removeEventListener('abort',close);
    harness?.destroy(); runner?.destroy(); server.close();
    for (const entry of pending.values()) entry.reject(rejected());
    pending.clear();
  };
  const request = async (method, params) => {
    const id = 'assistant-task-file-' + (++sequence);
    let timer;
    try {
      const result = new Promise((resolve,reject) => {
        pending.set(id,{resolve,reject});
        timer = setTimeout(() => reject(rejected()),8000);
      });
      const sent = write(runner,JSON.stringify({id,method,params}));
      const [,value] = await Promise.all([sent,result]);
      return value;
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  const reply = async () => {
    for await (const {raw,value} of frames(runner)) {
      if (typeof value.id === 'string' && value.id.startsWith('assistant-task-file-')) {
        const entry = pending.get(value.id);
        if (!entry) throw rejected();
        if (Object.hasOwn(value,'error') || !Object.hasOwn(value,'result')) entry.reject(rejected());
        else entry.resolve(value.result);
      } else if (!harness.destroyed) {
        await write(harness,raw);
      }
    }
    close();
  };
  const forward = async () => {
    for await (const {raw,value} of frames(harness)) {
      if (typeof value.id === 'string' && value.id.startsWith('assistant-task-file-')) throw rejected();
      await write(runner,raw);
      if (value.method !== 'initialized') continue;
      if (ready) throw rejected();
      for (const dir of [inputDirectory,outputDirectory]) {
        await request('fs/createDirectory',{path:pathToFileURL(dir).href,followSymlinks:false});
      }
      if (input) await request('fs/writeFile',{
        path:pathToFileURL(inputDirectory+'/'+input.name).href,dataBase64:input.bytes.toString('base64'),followSymlinks:false,
      });
      ready = true;
    }
    // Keep the worker alive after Codex closes its side so the service can
    // collect the final reply's named files through the same connection.
  };
  const server = createServer({allowHalfOpen:true},socket => {
    if (used) {socket.destroy();return;}
    used = true; harness = socket;
    runner = createConnection(upstreamPath);
    harness.on('error',close); runner.on('error',close);
    void reply().catch(close);
    void forward().catch(close);
  });
  try {
    server.listen(endpoint);
    await once(server,'listening');
    signal?.addEventListener('abort',close,{once:true});
    signal?.throwIfAborted();
    return {
      endpoint,close,
      async read(name,maxBytes) {
        if (!ready || !runner || runner.destroyed) throw rejected();
        const url = pathToFileURL(outputDirectory+'/'+taskOutputName(outputDirectory+'/'+name)).href;
        const params = {path:url,followSymlinks:false};
        const meta = await request('fs/getMetadata',params);
        if (meta.isFile!==true || meta.isSymlink!==false || !Number.isSafeInteger(meta.size) || meta.size<0 || meta.size>maxBytes) throw rejected();
        const data = await request('fs/readFile',params);
        if (typeof data.dataBase64!=='string' || data.dataBase64.length>Math.ceil(maxBytes/3)*4) throw rejected();
        const bytes = Buffer.from(data.dataBase64,'base64');
        if (bytes.length!==meta.size || bytes.length>maxBytes || bytes.toString('base64')!==data.dataBase64) throw rejected();
        return bytes;
      },
    };
  } catch(error) {close();throw error;}
}
