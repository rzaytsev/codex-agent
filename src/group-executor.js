import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

// Only a host-owned Unix socket is mounted into the service. The executor sees
// neither this socket, its client's authentication, nor any other conversation.
export async function executorBridge(cfg,writable=true,signal) {
  const server=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:16*1024*1024});
  const sockets=new Set();
  const close=()=>{for(const socket of sockets)socket.destroy();for(const client of server.clients)client.terminate();server.close();};
  if(signal?.aborted){close();signal.throwIfAborted();}
  signal?.addEventListener('abort',close,{once:true});
  server.on('connection',client=>{
    const socket=net.createConnection(cfg.executorSocket);sockets.add(socket);
    let buffer='',ready=false;const pending=[];
    socket.on('connect',()=>socket.write(JSON.stringify({conversation:cfg.group.id,writable})+'\n'));
    socket.on('data',chunk=>{
      buffer+=chunk.toString();
      if(buffer.length>16*1024*1024){client.terminate();socket.destroy();return;}
      let end;
      while((end=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        if(!ready){if(line!=='READY'){client.terminate();socket.destroy();return;}ready=true;for(const data of pending)socket.write(data);pending.length=0;}
        else if(client.readyState===WebSocket.OPEN)client.send(line);
      }
    });
    socket.on('error',()=>client.terminate());socket.on('close',()=>{sockets.delete(socket);client.terminate();});
    client.on('message',data=>{if(data.length>16*1024*1024||String(data).includes('\n')||pending.length>100){client.terminate();return;}const line=String(data)+'\n';if(ready)socket.write(line);else pending.push(line);});
    client.on('close',()=>socket.destroy());
  });
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  return {url:`ws://127.0.0.1:${server.address().port}`,close:()=>{signal?.removeEventListener('abort',close);close();}};
}

export async function probeGroupExecutor(cfg) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  const bridge=await executorBridge(cfg,true,controller.signal);
  const client=new WebSocket(bridge.url),waiting=new Map();let sequence=0;
  client.on('message',data=>{const value=JSON.parse(String(data));if(value.id!==undefined){const call=waiting.get(value.id);waiting.delete(value.id);value.error?call?.reject(new Error('Executor probe failed')):call?.resolve(value.result);}});
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;waiting.set(id,{resolve,reject});client.send(JSON.stringify({id,method,params}));});
  client.on('close',()=>{for(const call of waiting.values())call.reject(new Error('Executor unavailable'));waiting.clear();});
  try {
    await new Promise((resolve,reject)=>{client.once('open',resolve);client.once('error',reject);});
    await request('initialize',{clientName:'assistant-isolation-probe'});client.send(JSON.stringify({method:'initialized'}));
    const file=cfg.workspace+'/outputs/probe-'+randomUUID();
    const script=`test ! -e /data/codex/auth.json && test ! -e /workspace/USER.md && test ! -e /workspace/state && test ! -e /var/run/docker.sock && test -z "$ASSISTANT_CAPABILITY" && printf isolated > '${file}' && /bin/rm '${file}' && ! /usr/bin/curl --silent --max-time 2 http://127.0.0.1:8765/health`;
    await request('process/start',{processId:'probe',argv:['/bin/sh','-c',script],cwd:'file://'+cfg.workspace,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp'},tty:false,pipeStdin:false});
    for(;;){const result=await request('process/read',{processId:'probe',waitMs:1000,maxBytes:1000});if(result.exited)return result.exitCode===0;}
  } catch {return false;}
  finally {clearTimeout(timer);client.terminate();bridge.close();}
}
