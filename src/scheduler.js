import {createHash} from 'node:crypto';
import {CronExpressionParser} from 'cron-parser';

// The limits bound admissions and audit writes per tick, even after years down.
export function scheduleIntent(args) {
 const intent={};
 for(const field of ['overlap','misfire','catch_up_limit','misfire_grace_seconds','objective','done_condition','max_runs'])if(args[field]!==undefined)intent[field]=args[field];
 if(args.deadline!==undefined)intent.deadline=Date.parse(args.deadline);
 return intent;
}
export function savedScheduleIntent(s) {
 return scheduleIntent({overlap:s.overlap_policy??undefined,misfire:s.misfire_policy??undefined,catch_up_limit:s.catch_up_limit??undefined,misfire_grace_seconds:s.misfire_grace_seconds??undefined,objective:s.objective??undefined,done_condition:s.done_condition??undefined,max_runs:s.max_runs??undefined,...(s.deadline===null?{}:{deadline:new Date(s.deadline).toISOString()})});
}
export function goalHash(s) {
 return s.objective&&s.done_condition?createHash('sha256').update(JSON.stringify({version:1,id:s.id,user:s.user,conversation:s.conversation_id,objective:s.objective,done_condition:s.done_condition})).digest('hex'):null;
}
function latestOccurrence(s,now,nextCron) {
 const windowStart=now-48*3600000;
 const zone=new Intl.DateTimeFormat('en',{timeZone:s.timezone,timeZoneName:'longOffset'});
 const offset=time=>zone.formatToParts(new Date(time)).find(p=>p.type==='timeZoneName').value;
 const previous=from=>CronExpressionParser.parse(s.cron,{tz:s.timezone,currentDate:new Date(from),strict:false}).prev().getTime();
 if(offset(windowStart)===offset(now))return Math.max(s.due,previous(now+1));
 // cron-parser's reverse DST search differs from forward next(): it can
 // duplicate a daily repeated hour or omit a spring-gap shifted occurrence.
 // Reconstruct only a fixed 48h window using the scheduler's actual forward
 // semantics. Accepted five-field cron has at most one instant per minute.
 let latest=Math.max(s.due,previous(windowStart));
 // Include one terminating probe after the 2881 possible minute candidates.
 for(let n=0;n<=2881;n++) {
  const next=nextCron(s.cron,s.timezone,latest);if(next>now)return latest;
  latest=next;
 }
 throw new Error('Schedule DST normalization limit exceeded');
}
export function occurrencePlan(s,now,nextCron) {
 const next=s.cron?nextCron(s.cron,s.timezone,now):s.due;
 const late=now-s.due>(s.misfire_grace_seconds??60)*1000;
 if(!s.misfire_policy||!late)return {times:[s.due],next};
 if(s.misfire_policy==='skip')return {times:[],skipped:s.due,skippedBefore:s.cron?next:s.due+1,next};
 if(s.misfire_policy==='coalesce') {
  const latest=s.cron?latestOccurrence(s,now,nextCron):s.due;
  return {times:[Math.max(s.due,latest)],...(latest>s.due?{skipped:s.due,skippedBefore:latest}:{}),next};
 }
 const times=[];let cursor=s.due;
 for(let n=0;n<s.catch_up_limit&&cursor<=now;n++) {times.push(cursor);if(!s.cron)break;cursor=nextCron(s.cron,s.timezone,cursor);}
 return {times,...(s.cron&&cursor<=now?{skipped:cursor,skippedBefore:next}:{}),next};
}
export function listSchedule(s,store) {
 return {...s,overlap:s.overlap_policy||'queue',misfire:s.misfire_policy||'legacy',effective_misfire_grace_seconds:s.misfire_policy?s.misfire_grace_seconds??60:null,goal_hash:goalHash(s),last_completed_job:store.prepare("SELECT id FROM jobs WHERE $scope AND schedule_id=? AND state='completed' ORDER BY scheduled_for DESC LIMIT 1").get(s.id)?.id||null};
}
