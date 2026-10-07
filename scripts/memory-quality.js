// Deliberately outside npm test. Default execution never makes model calls.
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadSuite, runSuite } from './memory-quality-harness.js';

try {
  const {values} = parseArgs({options:{list:{type:'boolean'}, 'run-model':{type:'boolean'},
    'allow-subscription-usage':{type:'boolean'}, 'isolated-runtime':{type:'boolean'},
    'codex-home':{type:'string'}, model:{type:'string'}, effort:{type:'string',default:'low'},
    modes:{type:'string',default:'baseline,memory-only,learning-only,both'}, case:{type:'string'}, output:{type:'string'}, repeats:{type:'string',default:'1'}, 'max-calls':{type:'string',default:'100'}}});
  const suite = await loadSuite();
  if (values.list) {
    console.log(JSON.stringify({modelCalls:0, cases:suite.scenarios.map(({id,category}) => ({id,category}))}, null, 2));
  } else {
    if (!values['run-model'] || !values['allow-subscription-usage'] || !values['isolated-runtime'])
      throw Error('Opt-in required: --run-model --allow-subscription-usage --isolated-runtime. Read docs/memory-quality-evals.md first.');
    if (!values.model || !values['codex-home'] || !values.output) throw Error('Specify --model, --codex-home and --output for a subscription run');
    if (values.case) {
      suite.scenarios = suite.scenarios.filter(x => x.id === values.case);
      suite.expectations = suite.expectations.filter(x => x.id === values.case);
      if (!suite.scenarios.length) throw Error('Unknown evaluation case');
    }
    // Reserve the report destination before any costly model calls.
    const output = await fs.open(values.output, 'wx', 0o600);
    try {
      const {createAdapter} = await import('./memory-quality-adapter.js');
      const adapter = createAdapter({allowSubscriptionUsage:true, authHome:values['codex-home'], model:values.model,
        effort:values.effort, maxCalls:Number(values['max-calls'])});
      const report = await runSuite({...suite, adapter, repeats:Number(values.repeats),modes:values.modes.split(',')});
      await output.writeFile(JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({qualityEvidence:report.qualityEvidence, ...report.summary}));
      // Baseline misses are expected. Only memory-on failures/errors fail the run.
      if (report.cases.some(x => ['both','on'].includes(x.mode) && x.status !== 'passed') || report.summary.errors) process.exitCode = 1;
    } finally {await output.close();}
  }
} catch (error) {
  const safe = /^(Opt-in required|Specify --model|Unknown evaluation case|Invalid model or evaluation limits|Subscription calls require|Unsupported evaluation runtime|Invalid repeats)/;
  console.error(safe.test(error.message) ? error.message : 'Evaluation failed; private runtime details suppressed');
  process.exitCode = 1;
}
