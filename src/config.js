import path from 'node:path';
import { actionPolicy } from './action-policy.js';
import { CronExpressionParser } from 'cron-parser';
export function config(env = process.env) {
  const allowed = new Set((env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  if ([...allowed].some(s => !/^[1-9]\d*$/.test(s))) throw new Error('Allowed Telegram users must be numeric positive IDs');
  if(allowed.size>1)throw new Error('Configure exactly one Telegram owner per agent; use separate instances for different people');
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const profile = (prefix, fallback) => ({ model: env[`${prefix}_MODEL`] || undefined, effort: env[`${prefix}_REASONING`] || fallback });
  const profiles = { main: profile('MAIN','low'), worker: profile('WORKER','high'), research: profile('RESEARCH','medium'), review: profile('REVIEW','high'), deep_research: profile('DEEP_RESEARCH','high') };
  for (const p of Object.values(profiles)) if (!['minimal','low','medium','high','xhigh','max','ultra'].includes(p.effort)) throw new Error('Invalid reasoning effort');
  const timezone = env.TIMEZONE || 'UTC';
  new Intl.DateTimeFormat('en', {timeZone: timezone});
  const cron = (name, fallback) => {
    const value = env[name] || fallback;
    try {
      if(typeof value!=='string'||value.trim().split(/\s+/).length!==5) throw new Error();
      CronExpressionParser.parse(value,{tz:timezone,strict:false}).next();
    } catch { throw new Error(`Invalid ${name}`); }
    return value;
  };
  let mail;
  if(env.MAILBOX_URL||env.MAILBOX_TOKEN||env.MAILBOX_ID) {
    const url=new URL(env.MAILBOX_URL);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!env.MAILBOX_TOKEN||env.MAILBOX_TOKEN.length<32||!/^[a-z][a-z0-9-]{0,63}$/.test(env.MAILBOX_ID||'')||allowed.size!==1)throw new Error('Invalid mailbox configuration');
    mail={url:url.origin,token:env.MAILBOX_TOKEN,id:env.MAILBOX_ID};
  }
  return { token: env.TELEGRAM_BOT_TOKEN || '', allowed, owner:[...allowed][0], timezone, profiles, mail,
    actionPolicy:actionPolicy(env.ACTION_POLICY,integer('ACTION_APPROVAL_TTL_SECONDS',600,30,3600)), readOnlyWorkspacePrototype:env.READ_ONLY_WORKSPACE_PROTOTYPE==='true', restrictedReadProfilePrototype:env.RESTRICTED_READ_PROFILE_PROTOTYPE==='true',
    workspace: path.resolve(env.WORKSPACE_DIR || './workspace'), codexHome: path.resolve(env.CODEX_HOME || './.codex-data'),
    seedDir: env.SEED_DIR ? path.resolve(env.SEED_DIR) : undefined,
    pluginsFile: env.PLUGINS_FILE ? path.resolve(env.PLUGINS_FILE) : env.SEED_DIR ? path.resolve(env.SEED_DIR,'plugins.json') : undefined,
    pluginsFileRequired: Boolean(env.PLUGINS_FILE),
    pythonBase: env.WORKSPACE_PYTHON_BASE || '',
    cleanupEnabled: env.CLEANUP_ENABLED !== 'false', cleanupCron: cron('CLEANUP_CRON','0 3 * * *'),
    memoryEnabled: env.MEMORY_ENABLED !== 'false', memoryCrons:{daily:cron('MEMORY_DAILY_CRON','15 3 * * *'),weekly:cron('MEMORY_WEEKLY_CRON','45 3 * * 0')}, memoryMaxBatches:integer('MEMORY_MAX_BATCHES',4,1,20),
    learningEnabled: env.LEARNING_ENABLED !== 'false', learningCron:cron('LEARNING_CRON','30 3 * * *'), learningMaxBatches:integer('LEARNING_MAX_BATCHES',2,1,10),
    browserEnabled: env.BROWSER_ENABLED !== 'false', browserExecutable: env.BROWSER_EXECUTABLE || '/usr/bin/chromium',
    maxWorkers: integer('MAX_WORKERS',2,1,8), maxMainTurns:integer('MAX_MAIN_TURNS',2,1,8), maxExecutions:integer('MAX_EXECUTIONS',4,1,16), mainTimeout: integer('MAIN_TIMEOUT_SECONDS',180,10,3600), workerTimeout: integer('WORKER_TIMEOUT_SECONDS',1800,10,86400),
    runBudgets:{wallMs:integer('RUN_MAX_WALL_SECONDS',0,0,86400)*1000,tools:integer('RUN_MAX_SERVICE_TOOLS',0,0,100000),artifacts:integer('RUN_MAX_ARTIFACT_BYTES',0,0,1e12),tokens:integer('RUN_OBSERVED_TOKEN_ADMISSION',0,0,1e12)},
    researchMaxSources:integer('RESEARCH_MAX_SOURCES',40,1,200),
    maxBytes: integer('MAX_ATTACHMENT_MB',20,1,20)*1024*1024,
    proactive: env.PROACTIVE_ENABLED !== 'false',
    reviews: {daily: cron('DAILY_REVIEW_CRON','0 19 * * *'), weekly: cron('WEEKLY_REVIEW_CRON','0 18 * * 0'), monthly: cron('MONTHLY_REVIEW_CRON','0 18 1 * *')},
    quietStart: integer('QUIET_START_HOUR',22,0,23), quietEnd: integer('QUIET_END_HOUR',8,0,23),
    whisperModel: env.WHISPER_MODEL || 'base', whisperLanguage: env.WHISPER_LANGUAGE || '', ttsVoice: env.TTS_VOICE || 'en'
  };
}
export function authorized(message, cfg) {
  return message?.chat?.type === 'private' && !message.from?.is_bot && cfg.allowed.has(String(message.from?.id)) && String(message.chat.id) === String(message.from.id);
}
export function quiet(cfg, date = new Date()) {
  const h = Number(new Intl.DateTimeFormat('en-GB',{timeZone:cfg.timezone,hour:'2-digit',hourCycle:'h23'}).format(date));
  return cfg.quietStart === cfg.quietEnd ? false : cfg.quietStart < cfg.quietEnd ? h >= cfg.quietStart && h < cfg.quietEnd : h >= cfg.quietStart || h < cfg.quietEnd;
}
