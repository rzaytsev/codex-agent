import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { executorBridge } from '../src/group-executor.js';

test('executor bridge binds one group and read scope; abort closes its isolated transport',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'group-executor-'));
  const socket=path.join(root,'broker.sock'),received=[];
  const broker=net.createServer(connection=>{
    let buffer='',ready=false;
    connection.on('data',data=>{buffer+=data;let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!ready){received.push(JSON.parse(line));connection.write('READY\n');ready=true;}else connection.write(line+'\n');}});
  });
  await new Promise(resolve=>broker.listen(socket,resolve));
  const controller=new AbortController(),bridge=await executorBridge({group:{id:'synthetic-group'},executorSocket:socket},false,controller.signal);
  const client=new WebSocket(bridge.url);
  t.after(async()=>{client.terminate();bridge.close();await new Promise(resolve=>broker.close(resolve));await fs.rm(root,{recursive:true,force:true});});
  await new Promise(resolve=>client.once('open',resolve));
  const reply=new Promise(resolve=>client.once('message',data=>resolve(JSON.parse(String(data)))));
  client.send(JSON.stringify({id:1,method:'initialize',params:{clientName:'synthetic'}}));
  assert.equal((await reply).id,1);assert.deepEqual(received,[{conversation:'synthetic-group',writable:false}]);
  const closed=new Promise(resolve=>client.once('close',resolve));controller.abort();await closed;
});
