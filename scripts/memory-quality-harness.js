// Evaluation-only orchestration and lexical scoring. No model or service imports.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const matches = (text, patterns = []) => patterns.every(pattern => new RegExp(pattern, 'is').test(text));
const excludes = (text, patterns = []) => patterns.every(pattern => !new RegExp(pattern, 'is').test(text));
const metricCounts = metrics => ({passed:metrics.filter(x => x.passed === true).length, failed:metrics.filter(x => x.passed === false).length, unscored:metrics.filter(x => x.passed === null).length});

// Adapters may attach already collected synthetic observations on failure.
// Never serialize the Error itself or arbitrary error properties into reports.
export class EvaluationRunError extends Error {
  constructor(message, observation) {
    super(message);
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    this.observation = {probes:structuredClone(observation.probes || []), promptInputs:structuredClone(observation.promptInputs || []),
      calls:count(observation.calls), usage:Object.fromEntries(['input_tokens','output_tokens','cached_input_tokens'].map(key => [key, count(observation.usage?.[key])])),
      usageIncomplete:true};
  }
}

export async function loadSuite() {
  const read = async name => JSON.parse(await fs.readFile(new URL(`../evals/memory-quality/${name}.json`, import.meta.url), 'utf8'));
  return {scenarios: await read('scenarios'), expectations: await read('expectations')};
}

export function scoreCase(observation, expected) {
  return expected.checks.map(check => {
    const probe = observation.probes?.find(p => p.id === check.at);
    const identity = {id:check.id, target:check.target, at:check.at};
    if (!probe) return {...identity, passed:false, reason:'missing-probe', matches:[]};
    if (check.target === 'answer') {
      const answer = probe.answer;
      return {...identity, passed:typeof answer === 'string' && Boolean(answer.trim()) && matches(answer, check.all) && excludes(answer, check.none), matches:[]};
    }
    const records = probe[check.target];
    if (!Array.isArray(records)) return {...identity, passed:false, reason:'missing-records', matches:[]};
    const selected = records.filter(record =>
      Object.entries(check.where || {}).every(([key, value]) => (Array.isArray(value) ? value : [value]).includes(record[key])) &&
      matches(`${record.title || ''}\n${record.content || ''}`, check.all) && excludes(`${record.title || ''}\n${record.content || ''}`, check.none) &&
      (check.sources || []).every(source => record.sources?.includes(source)));
    return {...identity, passed:selected.length >= (check.min ?? 0) && selected.length <= (check.max ?? Infinity),
      matches:selected.map(record => ({key:record.key, revision:record.revision, sources:record.sources}))};
  });
}

function modelInput(scenario) {
  // Explicit allowlist: newly added scorer/metadata fields cannot leak to adapters.
  return {id:scenario.id, stages:scenario.stages.map(stage => ({
    messages:stage.messages.map(({id, conversation, role, text}) => ({id, conversation, role, text})),
    maintenance:[...stage.maintenance], rollback:Boolean(stage.rollback),
    probes:stage.probes.map(({id, conversation, fresh, prompt}) => ({id, conversation, fresh, prompt}))
  }))};
}

function validate(scenarios, expectations, modes, repeats) {
  if (!Array.isArray(scenarios) || !scenarios.length || !Array.isArray(expectations)) throw Error('Invalid suite');
  if (!Array.isArray(modes) || !modes.length || new Set(modes).size !== modes.length || modes.some(x => !['on','off'].includes(x))) throw Error('Invalid modes');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw Error('Invalid repeats');
  if (new Set(scenarios.map(x => x.id)).size !== scenarios.length || new Set(expectations.map(x => x.id)).size !== expectations.length || scenarios.length !== expectations.length) throw Error('Duplicate or missing cases');
  for (const scenario of scenarios) {
    const expected = expectations.find(x => x.id === scenario.id);
    if (!expected?.checks?.length) throw Error('Missing expectations');
    const probes = scenario.stages.flatMap(s => s.probes).map(p => p.id);
    const messages = scenario.stages.flatMap(s => s.messages).map(m => m.id);
    if (new Set(probes).size !== probes.length || new Set(messages).size !== messages.length) throw Error('Duplicate input IDs');
    if (new Set(expected.checks.map(x => x.id)).size !== expected.checks.length) throw Error('Duplicate metric IDs');
    for (const stage of scenario.stages) {
      if (stage.maintenance.some(x => !['memory','learning'].includes(x))) throw Error('Invalid maintenance');
      if (stage.messages.some(x => !['user','assistant','event'].includes(x.role) || !x.text || !x.conversation)) throw Error('Invalid message');
      if (stage.probes.some(x => !x.prompt || !x.conversation || typeof x.fresh !== 'boolean')) throw Error('Invalid probe');
    }
    for (const check of expected.checks) {
      if (!['answer','memory','learning'].includes(check.target) || !probes.includes(check.at) || !check.id) throw Error('Invalid scoring target');
      for (const field of ['all','none','sources']) if (check[field] !== undefined && (!Array.isArray(check[field]) || check[field].some(x => typeof x !== 'string'))) throw Error('Invalid scoring patterns');
      for (const pattern of [...check.all || [], ...check.none || []]) new RegExp(pattern, 'is');
      if (check.sources?.some(s => !messages.includes(s))) throw Error('Unknown evidence');
      if (check.where !== undefined && (!check.where || typeof check.where !== 'object' || Array.isArray(check.where))) throw Error('Invalid record filter');
      for (const [field, value] of Object.entries(check.where || {})) {
        if (!['kind','category','certainty','status','scope','target'].includes(field) || (Array.isArray(value) ? !value.length || value.some(x => typeof x !== 'string') : typeof value !== 'string')) throw Error('Invalid record filter');
      }
      if (check.target !== 'answer' && check.min === undefined && check.max === undefined) throw Error('Missing record count');
      for (const bound of ['min','max']) if (check[bound] !== undefined && (!Number.isInteger(check[bound]) || check[bound] < 0)) throw Error('Invalid count');
      if ((check.min ?? 0) > (check.max ?? Infinity)) throw Error('Invalid count range');
    }
  }
}

export async function runSuite({scenarios, expectations, adapter, modes = ['on','off'], repeats = 1, signal}) {
  validate(scenarios, expectations, modes, repeats);
  const report = {version:1, startedAt:new Date().toISOString(), adapter:adapter.name, qualityEvidence:adapter.qualityEvidence === true,
    provenance:{scenariosSha256:hash(scenarios), expectationsSha256:hash(expectations), node:process.version, runtime:adapter.runtime || {}}, cases:[], comparisons:[]};
  for (let repeat = 1; repeat <= repeats; repeat++) for (const scenario of scenarios) for (const mode of modes) {
    signal?.throwIfAborted();
    const start = Date.now(), row = {id:scenario.id, category:scenario.category, repeat, mode};
    const expected = expectations.find(x => x.id === scenario.id);
    try {
      const observation = await adapter.run(modelInput(scenario), {memoryEnabled:mode === 'on', signal});
      const metrics = scoreCase(observation, expected);
      Object.assign(row, {status:metrics.every(x => x.passed) ? 'passed' : 'failed', metrics, observation});
    } catch (error) {
      if (error instanceof EvaluationRunError) row.observation = error.observation;
      Object.assign(row, {status:'error', error:'Adapter failed; inspect locally without publishing private runtime errors',
        metrics:expected.checks.map(({id, target, at}) => ({id, target, at, passed:null, reason:'adapter-error', matches:[]}))});
    }
    row.metricCounts = metricCounts(row.metrics);
    row.durationMs = Date.now() - start;report.cases.push(row);
  }
  for (const on of report.cases.filter(x => x.mode === 'on')) {
    const off = report.cases.find(x => x.id === on.id && x.repeat === on.repeat && x.mode === 'off');
    if (!off) continue;
    const expected = expectations.find(x => x.id === on.id).checks;
    const section = include => {
      const onCounts = metricCounts(on.metrics.filter(include)), offCounts = metricCounts(off.metrics.filter(include));
      return {on:onCounts.passed, off:offCounts.passed, total:expected.filter(include).length, onCounts, offCounts,
        delta:onCounts.unscored || offCounts.unscored ? null : onCounts.passed - offCounts.passed};
    };
    report.comparisons.push({id:on.id, repeat:on.repeat, ...section(() => true),
      answers:section(x => x.target === 'answer'), records:section(x => x.target !== 'answer')});
  }
  report.summary = {cases:report.cases.length, passed:report.cases.filter(x => x.status === 'passed').length,
    failed:report.cases.filter(x => x.status === 'failed').length, errors:report.cases.filter(x => x.status === 'error').length};
  return report;
}
