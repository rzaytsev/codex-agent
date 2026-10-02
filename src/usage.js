import { AccountClient } from './codex-account.js';

export class UsageLimitError extends Error {
  constructor() { super('Codex usage limit reached'); this.name='UsageLimitError'; }
}
export function isUsageLimit(error) {
  if(error instanceof UsageLimitError) return true;
  const code=error?.codexErrorInfo ?? error?.code;
  if(typeof code==='string' && /^(usage[_-]?limit[_-]?(exceeded|reached)|quota_exceeded)$/i.test(code)) return true;
  return typeof error?.message==='string' && /(?:usage[_ -]?limit[_ -]?(?:reached|exceeded)|(?:hit|reached|exceeded|exhausted) (?:your |the )?usage limit|quota (?:has been )?(?:exceeded|exhausted)|out of Codex messages)/i.test(error.message);
}
// Only this read endpoint is used. Raw RPC responses/errors and stderr are never logged.
export async function readUsage(cfg,options) {
  const client=new AccountClient(cfg,options);
  try {
    await client.initialize();
    const result=await client.request('account/rateLimits/read');
    if(!result)throw new Error('Missing account usage');
    return normalizeUsage(result);
  } catch {throw new Error('Codex account usage is unavailable');}
  finally {await client.close();}
}

export function normalizeUsage(result) {
  const buckets=result.rateLimitsByLimitId && Object.keys(result.rateLimitsByLimitId).length?Object.values(result.rateLimitsByLimitId):[result.rateLimits];
  return {ordinaryUsageAllowed:typeof result.ordinaryUsageAllowed==='boolean'?result.ordinaryUsageAllowed:null,buckets:buckets.filter(Boolean).map(b=>({
    name:typeof b.limitName==='string'?b.limitName.slice(0,80):typeof b.limitId==='string'?b.limitId.slice(0,80):'Codex',
    windows:['primary','secondary'].map(kind=>{const w=b[kind];return {kind,usedPercent:typeof w?.usedPercent==='number'&&Number.isFinite(w.usedPercent)?w.usedPercent:null,minutes:typeof w?.windowDurationMins==='number'?w.windowDurationMins:null,resetsAt:typeof w?.resetsAt==='number'&&w.resetsAt>0&&w.resetsAt<8640000000000?w.resetsAt:null};})
  }))};
}
export function formatUsage(usage,timezone) {
  const date=seconds=>new Intl.DateTimeFormat('en-GB',{timeZone:timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(seconds*1000));
  const out=['Codex account limits (shared by agents using this account):'];
  if(usage.ordinaryUsageAllowed===false)out.push('Ordinary usage is currently blocked.');
  for(const bucket of usage.buckets) {
    out.push(bucket.name);
    for(const w of bucket.windows) {
      const label=w.minutes?`${w.minutes>=1440?w.minutes/1440+' day':w.minutes>=60?w.minutes/60+' hour':w.minutes+' minute'} window`:w.kind+' window';
      out.push(`${label}: ${w.usedPercent===null?'remaining usage unavailable':Math.max(0,Math.min(100,100-w.usedPercent))+'% remaining'}; ${w.resetsAt===null?'reset time unavailable':'resets '+date(w.resetsAt)+' ('+timezone+')'}.`);
    }
  }
  if(!usage.buckets.length)out.push('Remaining usage and reset times are unavailable.');
  return out.join('\n');
}
