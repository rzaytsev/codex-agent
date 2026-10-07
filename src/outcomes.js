import {safeFailure} from './observations.js';
const text={type:'string',maxLength:2000};
const list={type:'array',maxItems:16,items:text};
export const outcomeSchema={type:'object',additionalProperties:false,required:['status','checks','evidence','limitations'],properties:{status:{type:'string',enum:['achieved','partial','blocked','unknown']},checks:list,evidence:list,limitations:list}};
export const checkpointSchema={type:'object',additionalProperties:false,required:['plan_version','last_verified_milestone','next_safe_step','unresolved_effects'],properties:{plan_version:{type:'integer',minimum:1,maximum:1000000},last_verified_milestone:text,next_safe_step:text,unresolved_effects:list}};
function valid(value,schema){
  if(schema.type==='string')return typeof value==='string'&&value.length<=(schema.maxLength||Infinity)&&(!schema.enum||schema.enum.includes(value));
  if(schema.type==='integer')return Number.isInteger(value)&&value>=schema.minimum&&value<=schema.maximum;
  if(schema.type==='array')return Array.isArray(value)&&value.length<=schema.maxItems&&value.every(v=>valid(v,schema.items));
  return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===schema.required.length&&schema.required.every(k=>Object.hasOwn(value,k)&&valid(value[k],schema.properties[k]));
}
export function validateOutcome(result){for(const [key,schema] of [['outcome',outcomeSchema],['checkpoint',checkpointSchema]])if(result[key]!==undefined&&result[key]!==null&&!valid(result[key],schema))throw safeFailure('invalid_output');return result;}
export function outcomeRecord(result){validateOutcome(result);return {version:1,authority:result.outcome?'model_reported':'unknown',goal:result.outcome?.status||'unknown',checks:result.outcome?.checks||[],evidence:result.outcome?.evidence||[],limitations:result.outcome?.limitations||[],checkpoint:result.checkpoint||null,host_verified:false,resume:'fresh_owner_intent_required'};}
export const interruptedOutcome=()=>({...outcomeRecord({}),limitations:['Execution effects may be unresolved; reconcile before new work.']});
