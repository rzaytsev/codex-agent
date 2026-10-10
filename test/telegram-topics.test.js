import test from 'node:test';
import assert from 'node:assert/strict';
import { Telegram, TelegramError } from '../src/telegram.js';

test('text, literal approvals, media and typing carry the service-selected topic',async()=>{
  const telegram=new Telegram('unused'),calls=[];
  telegram.call=async(method,body)=>{calls.push({method,body});return {};};
  await telegram.sendPart('123',{text:'Topic reply',message_thread_id:999},101);
  await telegram.sendPart('123',{text:'Exact approval',plainText:true},101);
  for(const type of ['file','voice','photo'])await telegram.sendPart('123',{type,path:'synthetic.dat',filename:'synthetic.dat',bytes:Buffer.from('synthetic')},101);
  const stop=telegram.startTyping('123',101);await new Promise(r=>setImmediate(r));stop();
  assert.deepEqual(calls.map(c=>c.method),['sendMessage','sendMessage','sendDocument','sendVoice','sendPhoto','sendChatAction']);
  for(const {body} of calls)assert.equal(body instanceof FormData?body.get('message_thread_id'):body.message_thread_id,body instanceof FormData?'101':101);
  await telegram.sendPart('123',{text:'Ordinary chat'});assert.equal(Object.hasOwn(calls.at(-1).body,'message_thread_id'),false);
});

test('formatting and photo fallbacks preserve the destination even when a topic is unavailable',async()=>{
  const telegram=new Telegram('unused'),calls=[];let reject=true;
  telegram.call=async(method,body)=>{calls.push({method,body});if(reject){reject=false;throw new TelegramError(400);}return {};};
  await telegram.sendPart('123',{text:'Fallback text'},202);
  assert.ok(calls.every(c=>c.body.message_thread_id===202));assert.equal(calls.length,2);
  calls.length=0;reject=true;await telegram.sendPart('123',{type:'photo',path:'synthetic.png',bytes:Buffer.from('synthetic')},202);
  assert.deepEqual(calls.map(c=>c.method),['sendPhoto','sendDocument']);assert.ok(calls.every(c=>c.body.get('message_thread_id')==='202'));
  calls.length=0;telegram.call=async(method,body)=>{calls.push({method,body});throw new TelegramError(400);};
  await assert.rejects(telegram.sendPart('123',{text:'Deleted topic'},202));assert.ok(calls.every(c=>c.body.message_thread_id===202));
});
