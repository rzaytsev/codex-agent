// Evaluation-only adapter: real service extraction/validation/storage and fresh
// Agent answers, with no Telegram server, polling, delivery or account tools.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Codex } from '@openai/codex-sdk';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';
import { Agent } from '../src/agent.js';
import { EvaluationRunError } from './memory-quality-harness.js';

// Checked against `codex-cli 0.159.2 features list`. Removed switches are not
// relied upon. Read-only is still needed: this is not a universal tool firewall.
const disabledFeatures = ['shell_tool','apps','plugins','hooks','multi_agent','multi_agent_v2',
  'browser_use','browser_use_external','in_app_browser','computer_use','image_generation','view_image',
  'memories','code_mode','code_mode_host'];
const owner = '999';
const version = name => JSON.parse(readFileSync(new URL(`../node_modules/@openai/${name}/package.json`, import.meta.url), 'utf8')).version;
const digest = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = [
  ...readdirSync(new URL('../src/', import.meta.url)).filter(file => file.endsWith('.js')).map(file => `src/${file}`),
  ...readdirSync(new URL('../templates/', import.meta.url)).filter(file => file.endsWith('.md')).map(file => `templates/${file}`),
  'scripts/memory-quality.js','scripts/memory-quality-harness.js','scripts/memory-quality-adapter.js'];
const fingerprint = () => Object.fromEntries(sourceFiles.sort().map(file => [file,
  digest(readFileSync(new URL(`../${file}`, import.meta.url)))]));

export function createAdapter({CodexClass = Codex, allowSubscriptionUsage = false, authHome,
  model, effort = 'low', maxCalls = 100, timeoutMs = 180000} = {}) {
  const live = CodexClass === Codex;
  if (live && (!allowSubscriptionUsage || !authHome)) throw Error('Subscription calls require explicit opt-in and an existing auth home');
  if (live && (version('codex') !== '0.159.2' || version('codex-sdk') !== '0.159.2')) throw Error('Unsupported evaluation runtime; recheck tool restrictions');
  if (!model || !Number.isInteger(maxCalls) || maxCalls < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1) throw Error('Invalid model or evaluation limits');
  let totalCalls = 0;
  return {name:live ? 'subscription-service' : 'fake-test-only', qualityEvidence:live,
    runtime:{model, effort, maxCalls, timeoutMs, cli:version('codex'), sdk:version('codex-sdk'), sourceSha256:fingerprint(), tools:'restricted; see docs/memory-quality-evals.md'},
    async run(input, {memoryEnabled, learningEnabled=memoryEnabled, signal} = {}) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-quality-'));
      const workspace = path.join(root, 'workspace'), home = path.join(root, 'home'), codexHome = path.join(root, 'codex');
      const stores = new Map(), sources = new Map(), observation = {probes:[], promptInputs:[], calls:0, usage:{input_tokens:0, output_tokens:0, cached_input_tokens:0}};
      const local = new AbortController();
      const timer = setTimeout(() => local.abort(), timeoutMs);
      const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
      try {
        for (const dir of [workspace, home, codexHome]) await fs.mkdir(dir, {mode:0o700});
        // Only existing subscription authentication is linked. No config, skills,
        // plugins, sessions or account data from the original home are imported.
        if (live) {
          const auth = path.resolve(authHome, 'auth.json');
          await fs.access(auth);
          await fs.symlink(auth, path.join(codexHome, 'auth.json'));
        }
        const cfg = config({WORKSPACE_DIR:workspace, CODEX_HOME:codexHome, TELEGRAM_ALLOWED_USER_IDS:owner,
          TELEGRAM_BOT_TOKEN:'', PROACTIVE_ENABLED:'false', CLEANUP_ENABLED:'false', BROWSER_ENABLED:'false',
          WORKSPACE_PYTHON_BASE:'', MEMORY_ENABLED:String(memoryEnabled), LEARNING_ENABLED:String(learningEnabled),
          MEMORY_MAX_BATCHES:'1', LEARNING_MAX_BATCHES:'1', TIMEZONE:'UTC',
          MAIN_MODEL:model, RESEARCH_MODEL:model, REVIEW_MODEL:model, MAIN_REASONING:effort, RESEARCH_REASONING:effort, REVIEW_REASONING:effort});
        const database = path.join(workspace, 'state.sqlite');
        const store = new Store(database);stores.set('dm', store);
        const service = new Service(cfg, store, {}, null);await service.init();
        await fs.writeFile(path.join(workspace, 'USER.md'), 'Synthetic owner. Onboarding is complete. No other personal facts have been provided.\n');
        const sdkFactory = options => {
          const developerInstructions = options.config.developer_instructions +
            '\nSynthetic offline evaluation: use only supplied evidence and return the requested schema. Do not use tools, read files, contact accounts, or take external actions. Answer in English.';
          const sdk = new CodexClass({env:{PATH:process.env.PATH, HOME:home, CODEX_HOME:codexHome, LANG:'C.UTF-8'},
            config:{...options.config, developer_instructions:developerInstructions},
            configOverrides:['mcp_servers={}', ...disabledFeatures.map(name => `features.${name}=false`)]});
          return {
            startThread: opts => {
              const thread = sdk.startThread({...opts, sandboxMode:'read-only', approvalPolicy:'never', webSearchMode:'disabled', networkAccessEnabled:false});
              return {runStreamed:async (prompt, opts) => {
                combined.throwIfAborted();
                if (totalCalls >= maxCalls) throw Error('Evaluation call budget exhausted');
                const profilesSha256 = Object.fromEntries(await Promise.all(['AGENTS.md','SOUL.md','USER.md'].map(async file =>
                  [file, digest(await fs.readFile(path.join(workspace, file)))])));
                observation.promptInputs.push({call:observation.calls + 1, profilesSha256,
                  developerInstructionsSha256:digest(developerInstructions), inputSha256:digest(JSON.stringify(prompt)),
                  outputSchemaSha256:digest(JSON.stringify(opts.outputSchema))});
                totalCalls++;observation.calls++;
                const stream = await thread.runStreamed(prompt, {...opts, signal:combined});
                return {events:(async function* () {
                  for await (const event of stream.events) {
                    combined.throwIfAborted();
                    if (event.item && !['agent_message','reasoning'].includes(event.item.type)) throw Error('Unexpected tool activity in evaluation');
                    if (event.type === 'turn.completed') for (const key of Object.keys(observation.usage)) {const n=event.usage?.[key];observation.usage[key]=observation.usage[key]!==null&&Number.isSafeInteger(n)&&n>=0&&n<=1e15?observation.usage[key]+n:null;}
                    yield event;
                  }
                })()};
              }};
            },
            resumeThread: () => {throw Error('Evaluation requires fresh threads');}
          };
        };
        const capability = (user, worker, review, runSignal) => service.capability(user, true, true, runSignal);
        capability.release = token => service.releaseCapability(token);
        const agentFor = conversationStore => new Agent(cfg, conversationStore, capability, sdkFactory, service.memory, service.learning);
        service.agent = agentFor(store);
        const conversation = name => {
          if(name==='dm')return store;
          if (!stores.has(name)) {
            const next = new Store(database);
            next.bindConversation(owner, {id:randomUUID(), chatId:String(-100 - stores.size), kind:'group', title:name});
            stores.set(name, next);
          }
          return stores.get(name);
        };
        const snapshot = () => {
          const normalize = record => ({key:record.key, category:record.category, kind:record.kind, title:record.title,
            content:record.content, certainty:record.certainty, status:record.status, revision:record.revision,
            scope:record.scope, target:record.target, sourceRefs:record.sources, sources:record.sources.map(source => sources.get(source) || source)});
          return {memory:store.db.prepare('SELECT key FROM memories ORDER BY id').all().map(row => normalize(service.memory.get(row.key))),
            learning:service.learning.list().map(normalize)};
        };
        for (const stage of input.stages) {
          combined.throwIfAborted();
          const stageSources = [];
          for (const message of stage.messages) {
            const target = conversation(message.conversation);
            if(message.role==='user') {
              // Fixture transport metadata is host-owned and never inferred from text.
              const transport={from:{id:Number(owner)},chat:{id:Number(owner),type:'private'},text:message.text};
              if(message.origin==='forwarded')transport.forward_sender_name='Synthetic hidden sender';
              else if(message.origin==='attachment')transport.document={file_id:'synthetic'};
              else if(message.origin==='bot')transport.via_bot={id:1};
              else if(['event','other'].includes(message.origin))transport.event=true;
              const chat=target.kind==='group'?target.db.prepare('SELECT chat_id FROM conversations WHERE id=?').get(target.conversationId):null;
              if(chat){transport.chat={id:Number(chat.chat_id),type:'group'};target.ownerHistory({...cfg,group:{chat_id:chat.chat_id,state:'active'}},transport,message.text);}
              else target.ownerHistory(cfg,transport,message.text);
            } else target.history(owner, message.role, message.text);
            const source = `history:${target.db.prepare('SELECT last_insert_rowid() AS id').get().id}`;
            sources.set(source, message.id);stageSources.push(source);
          }
          for (const kind of stage.maintenance.filter(kind=>kind==='memory'?memoryEnabled:learningEnabled)) {
            const id = store.job(owner, `[${kind.toUpperCase()}] synthetic evaluation`, 'research');
            store.db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(id);
            const job = store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
            if (kind === 'memory') {
              store.set(`memory-job:${id}`, JSON.stringify({period:'daily', target:service.memory.target('daily')}));
              await service.runMemoryJob(job, {signal:combined});
            } else {
              store.set(`learning-job:${id}`, JSON.stringify({target:service.learning.target()}));
              await service.runLearningJob(job, {signal:combined});
            }
          }
          if (learningEnabled && stage.rollback) {
            // Explicit synthetic owner feedback, applied by the service. This
            // measures post-rollback state/context, not model tool selection.
            for (const record of service.learning.list().filter(r => ['active','trial'].includes(r.status)))
              service.learning.feedback({key:record.key, expected_revision:record.revision, action:'rollback', sources:stageSources});
          }
          for (const probe of stage.probes) {
            const target = conversation(probe.conversation), search = target.search;
            target.set(`thread:${owner}`, '');
            if (probe.fresh) target.search = () => [];
            try {
              const answer = await agentFor(target).run(owner, probe.prompt, 'main', [], combined, undefined, undefined, false,
                {actorId:owner, toolScope:'read', settings:cfg.profiles.main});
              observation.probes.push({id:probe.id, answer:answer.text, ...snapshot()});
            } finally {target.search = search;}
          }
        }
        if (store.db.prepare('SELECT count(*) AS n FROM outbox').get().n) throw Error('Evaluation unexpectedly queued delivery');
        return observation;
      } catch (error) {
        throw new EvaluationRunError(error instanceof Error ? error.message : 'Adapter runtime failed', observation);
      } finally {
        // SDK 0.159.2 removes child error listeners after the event stream drains.
        // Aborting that completed stream can then emit an unhandled AbortError.
        // Timeout and caller cancellation already abort active work.
        clearTimeout(timer);
        for (const store of stores.values()) store.db.close();
        await fs.rm(root, {recursive:true, force:true});
      }
    }};
}
