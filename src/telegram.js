import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const mimeTypes={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.zip':'application/zip','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.html':'text/html','.svg':'image/svg+xml','.mp4':'video/mp4','.mp3':'audio/mpeg','.ogg':'audio/ogg'};
export const mimeType=file=>mimeTypes[path.extname(file).toLowerCase()]||'application/octet-stream';
export class TelegramError extends Error {
  constructor(code,retryAfter=0) { super(`Telegram request failed (${code})`); this.code=code; this.retryAfter=retryAfter; }
}
export function chunks(text, size=1500) { const chars = Array.from(text); const out=[]; for(let i=0;i<chars.length;i+=size) out.push(chars.slice(i,i+size).join('')); return out; }
export function format(text) {
  return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*([^\n*]+)\*\*/g,'<b>$1</b>').replace(/`([^\n`]+)`/g,'<code>$1</code>');
}
export class Telegram {
  constructor(token,fetcher=fetch) { this.token=token; this.fetch=fetcher; }
  async call(method,body,timeoutMs=70000,signal) {
    signal?.throwIfAborted();
    const deadline=AbortSignal.timeout(timeoutMs);
    let response;
    try { response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`,{method:'POST',body: body instanceof FormData ? body : JSON.stringify(body), headers:body instanceof FormData ? undefined : {'content-type':'application/json'},signal:signal?AbortSignal.any([signal,deadline]):deadline}); }
    catch { throw new TelegramError('network'); }
    let data; try { data=await response.json(); } catch { throw new TelegramError('invalid-response'); }
    if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.ok!=='boolean'||(data.ok&&!Object.hasOwn(data,'result'))) throw new TelegramError('invalid-response');
    if (!data.ok) {
      const code=Number.isInteger(data.error_code)&&data.error_code>=100&&data.error_code<=599?data.error_code:'invalid-response';
      const retryAfter=Number.isSafeInteger(data.parameters?.retry_after)&&data.parameters.retry_after>=0?data.parameters.retry_after:0;
      throw new TelegramError(code,retryAfter);
    }
    signal?.throwIfAborted();
    return data.result;
  }
  async action(user,action='typing') {
    try {await this.call('sendChatAction',{chat_id:user,action},5000);return true;} catch {return false;}
  }
  startTyping(user) {
    let stopped=false;let pending=false;
    const tick=async()=>{if(stopped||pending)return;pending=true;try {await this.action(user);} finally {pending=false;}};
    void tick();const timer=setInterval(()=>void tick(),4000);timer.unref();
    return ()=>{stopped=true;clearInterval(timer);};
  }
  async registerCommands(users) {
    const commands=[
      {command:'help',description:'Show bot commands and supported messages'},
      {command:'auth',description:'Sign in or change ChatGPT account; status or cancel'},
      {command:'tdl_auth',description:'Connect Telegram user account; status or cancel'},
      {command:'usage',description:'Show Codex remaining limits and reset times'},
      {command:'status',description:'List worker tasks and their status'},
      {command:'new',description:'Start a fresh conversation; keep profile and files'},
      {command:'cancel',description:'Cancel a worker task: /cancel <task-id>'},
      {command:'stop',description:'Stop your current reply immediately'},
      {command:'location',description:'Show saved location; default or clear to change it'},
      {command:'group',description:'Manage owner-linked group conversations'}
    ];
    const scopes=[{type:'default'},{type:'all_private_chats'},...Array.from(users,chat_id=>({type:'chat',chat_id}))];
    for(const scope of scopes) await this.call('setMyCommands',{commands,scope});
  }
  async download(fileId,dest,maxBytes,signal) {
    signal?.throwIfAborted();
    const file=await this.call('getFile',{file_id:fileId},70000,signal);
    signal?.throwIfAborted();
    if(!file||typeof file.file_path!=='string'||!file.file_path) throw new Error('Attachment download failed');
    if (file.file_size > maxBytes) throw new Error('Attachment too large');
    let response;
    const deadline=AbortSignal.timeout(60000);
    try { response=await this.fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`,{signal:signal?AbortSignal.any([signal,deadline]):deadline}); }
    catch { throw new Error('Attachment download failed'); }
    if (!response.ok) throw new Error('Attachment download failed');
    const parts=[]; let size=0;
    try {
      for await (const part of response.body) {
        signal?.throwIfAborted();size+=part.length;
        if(size>maxBytes) throw new Error('Attachment too large');
        parts.push(part);
      }
    } catch {throw new Error(size>maxBytes?'Attachment too large':'Attachment download failed');}
    signal?.throwIfAborted();
    const temp=dest+'.'+randomUUID();
    try {
      await fs.writeFile(temp,Buffer.concat(parts),{signal,flag:'wx'});
      signal?.throwIfAborted();
      await fs.rename(temp,dest);
      signal?.throwIfAborted();
    } finally {await fs.rm(temp,{force:true});}
  }
  async sendPart(user,payload) {
    if (payload.type === 'file' || payload.type === 'voice' || payload.type === 'photo') {
      if(payload.artifactId&&!Buffer.isBuffer(payload.bytes))throw new Error('Artifact bytes must be verified before sending');
      const data=new FormData(); data.set('chat_id',user);
      const field=payload.type === 'voice'?'voice':payload.type==='photo'?'photo':'document';
      data.set(field,new Blob([payload.bytes??await fs.readFile(payload.path)],{type:payload.mime||(payload.type==='voice'?'audio/ogg':mimeType(payload.path))}),payload.filename||path.basename(payload.path));
      if(payload.caption)data.set('caption',payload.caption);
      if(payload.type==='voice') data.set('caption','AI-generated voice');
      try {return await this.call(payload.type==='voice'?'sendVoice':payload.type==='photo'?'sendPhoto':'sendDocument',data);}
      catch(e) {
        if(payload.type!=='photo'||e.code!==400) throw e;
        const fallback=new FormData();fallback.set('chat_id',user);fallback.set('document',data.get('photo'));if(payload.caption)fallback.set('caption',payload.caption);
        return this.call('sendDocument',fallback);
      }
    }
    try { return await this.call('sendMessage',{chat_id:user,text:format(payload.text),parse_mode:'HTML'}); }
    catch(e) { if(e.code!==400) throw e; return this.call('sendMessage',{chat_id:user,text:payload.text}); }
  }
}
