import {deflateSync} from 'node:zlib';
import {chunks} from './telegram.js';
import {randomUUID} from 'node:crypto';
import {widgetActions,widgetData,widgetState} from './widgets.js';

export const presentationSchema={anyOf:[{type:'object',additionalProperties:false,required:['kind','content','actions','state'],properties:{kind:{type:'string',enum:['widget','rich']},content:{type:'string'},actions:{type:'array',maxItems:8,items:{type:'object',additionalProperties:false,required:['id','label','prompt'],properties:{id:{type:'string',pattern:'^[a-zA-Z0-9_-]{1,64}$'},label:{type:'string',minLength:1,maxLength:80},prompt:{type:'string',minLength:1,maxLength:2000}}}},state:{anyOf:[{type:'string'},{type:'null'}]}}},{type:'null'}]};

// The service chooses the destination and constructs the envelope. Invalid or
// unsupported enhancements must never discard the readable answer.
export function responsePayloads(result,{widgets=true}={}) {
  const text=result.text||'',p=result.presentation;
  const fallback=()=>chunks(text).map(text=>({text}));
  if(!text.trim()||!p||typeof p!=='object'||Array.isArray(p)||typeof p.content!=='string'||!p.content.trim())return fallback();
  if(p.kind==='rich'&&text.length<=3500&&Array.from(p.content).length<=32768)
    return [{type:'rich',markdown:p.content,text}];
  if(p.kind!=='widget'||!widgets||text.length>1024||p.content.includes('\0')||Buffer.byteLength(p.content)>32768)return fallback();
  if(deflateSync(p.content,{level:9}).length>4096)return fallback();
  try {
    const actions=widgetActions(p.actions),state=p.state==null?'{}':p.state;
    const data=widgetData(state);
    if(actions.length||p.state!=null)return [{type:'widget',html:p.content,text,widgetId:randomUUID(),actions,state:JSON.stringify(data),chatData:widgetState(data)}];
  } catch {return fallback();}
  // Scripts run only in Telegram's client sandbox; the service never executes HTML.
  return [{type:'widget',html:p.content,text}];
}
