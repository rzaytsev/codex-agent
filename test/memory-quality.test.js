import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const api = await import('../scripts/memory-quality-harness.js').catch(() => ({}));
const scenario = {id:'synthetic-case',category:'correction',stages:[{messages:[{id:'m1',conversation:'dm',role:'user',text:'Use five entries.'}],maintenance:['memory'],probes:[{id:'q1',conversation:'other',fresh:true,prompt:'How many entries?'}]}]};
const expectations = {id:scenario.id,checks:[
  {id:'answer',at:'q1',target:'answer',all:['\\bfive\\b'],none:['eight']},
  {id:'grounding',at:'q1',target:'memory',all:['five'],sources:['m1'],where:{certainty:'confirmed'},min:1,max:1}
]};
const observation = {probes:[{id:'q1',answer:'Use five entries.',memory:[{content:'Use five entries.',certainty:'confirmed',sources:['m1']}],learning:[]}],calls:1};
function required(name) {assert.equal(typeof api[name],'function',`${name} must exist`);return api[name];}

test('scoring catches wrong answers, wrong provenance and empty answers independently',()=>{
  const score=required('scoreCase');
  assert.ok(score(observation,expectations).every(m=>m.passed));
  const bad=structuredClone(observation);bad.probes[0].answer='Use eight entries.';bad.probes[0].memory[0].sources=['m9'];
  assert.deepEqual(score(bad,expectations).map(m=>m.passed),[false,false]);
  bad.probes[0].answer='';assert.equal(score(bad,{checks:[{id:'nonempty',at:'q1',target:'answer',none:['eight']} ]})[0].passed,false);
});

test('missing probes fail negative checks instead of creating a vacuous pass',()=>{
  assert.equal(required('scoreCase')({probes:[]},{checks:[{id:'forbidden',at:'q1',target:'learning',all:['unrestricted'],max:0} ]})[0].passed,false);
});

test('runner sends only model input, keeps expectations private and pairs modes',async()=>{
  const received=[];
  const report=await required('runSuite')({scenarios:[{...scenario,secretExpectedAnswer:'do not expose'}],expectations:[expectations],adapter:{name:'fake-test-only',qualityEvidence:false,run:async input=>{received.push(input);return structuredClone(observation);}},modes:['on','off'],repeats:2});
  assert.equal(received.length,4);
  assert.ok(received.every(x=>!JSON.stringify(x).includes('secretExpectedAnswer')&&!JSON.stringify(x).includes('grounding')));
  assert.equal(report.qualityEvidence,false);assert.equal(report.cases.length,4);assert.equal(report.comparisons.length,2);
  assert.match(report.provenance.scenariosSha256,/^[a-f0-9]{64}$/);
  assert.match(report.provenance.expectationsSha256,/^[a-f0-9]{64}$/);
  assert.equal(report.summary.errors,0);
});

test('runner records a safe per-case error and continues without exposing runtime errors',async()=>{
  let calls=0;
  const report=await required('runSuite')({scenarios:[scenario],expectations:[expectations],adapter:{name:'fake-test-only',qualityEvidence:false,run:async()=>{if(++calls===1)throw Error('private-path-and-credential');return observation;}},modes:['on','off']});
  assert.equal(report.cases[0].status,'error');assert.equal(report.cases[1].status,'passed');
  assert.equal(JSON.stringify(report).includes('private-path-and-credential'),false);assert.equal(report.summary.errors,1);
  assert.equal(report.comparisons[0].delta,null);
});

test('suite rejects missing, duplicate and malformed scoring definitions before calling adapters',async()=>{
  const run=required('runSuite');let calls=0;const adapter={run:async()=>{calls++;return observation;}};
  for(const gold of [[],[expectations,expectations],[{...expectations,checks:[{id:'bad',at:'q1',target:'answer',all:['[']}]}],[{...expectations,checks:[{id:'typo',at:'q1',target:'memroy',max:0}]}]]) {
    await assert.rejects(run({scenarios:[scenario],expectations:gold,adapter}));
  }
  assert.equal(calls,0);
});

test('held-out fixtures cover meaningful risk categories with source-backed record checks',async()=>{
  const load=required('loadSuite');const suite=await load();
  assert.ok(suite.scenarios.length>=8);
  for(const category of ['one-off','persistent-preference','correction','unsupported-claim','source-authority','ambiguity','unknown','cross-conversation','learning-transfer'])assert.ok(suite.scenarios.some(x=>x.category===category),category);
  assert.ok(suite.expectations.some(x=>x.checks.some(c=>c.sources?.length)));
  await required('runSuite')({...suite,adapter:{name:'fake-test-only',qualityEvidence:false,run:async()=>({probes:[],calls:0})}});
});

test('CLI defaults to zero model calls and requires explicit quota consent',()=>{
  for(const args of [[],['--run-model']]) {
    const result=spawnSync(process.execPath,['scripts/memory-quality.js',...args],{encoding:'utf8'});
    assert.notEqual(result.status,0);assert.match(result.stderr,/opt-in|subscription/i);
  }
});

const adapterApi = await import('../scripts/memory-quality-adapter.js').catch(() => ({}));
function fakeCodex(captures, toolEvent = false, respond) {
  return class {
    constructor(options) {this.options=options;}
    startThread(options) {
      const sdkOptions=this.options;
      return {runStreamed:async(input,{outputSchema,signal})=>{
        captures.push({sdkOptions,options,input,outputSchema,signal});
        const output=respond ? respond(outputSchema) : outputSchema.properties.changes ? {summary:'',changes:[{key:'entries',category:'facts',title:'Entries',content:'Use five entries.',certainty:'confirmed',sources:['history:1'],expected_revision:0,status:'active'}]} : {text:'Use five entries.',voice:false,files:[]};
        return {events:(async function*(){
          if(toolEvent)yield {type:'item.started',item:{type:'command_execution'}};
          yield {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}};
          yield {type:'turn.completed',usage:{input_tokens:3,output_tokens:4,cached_input_tokens:0}};
        })()};
      }};
    }
    resumeThread(){throw Error('Must not resume');}
  };
}

test('adapter exercises real storage and fresh answer pipeline without model calls',async()=>{
  assert.equal(typeof adapterApi.createAdapter,'function','runtime adapter must exist');
  const captures=[];const adapter=adapterApi.createAdapter({CodexClass:fakeCodex(captures),model:'synthetic-model',maxCalls:10});
  const on=await adapter.run(scenario,{memoryEnabled:true});
  assert.equal(on.probes[0].memory[0].content,'Use five entries.');
  assert.deepEqual(on.probes[0].memory[0].sources,['m1']);
  assert.equal(on.calls,2);assert.equal(on.usage.output_tokens,8);
  const off=await adapter.run(scenario,{memoryEnabled:false});assert.deepEqual(off.probes[0].memory,[]);assert.equal(off.calls,1);
  for(const call of captures) {
    assert.equal(call.options.sandboxMode,'read-only');assert.equal(call.options.webSearchMode,'disabled');
    assert.equal(call.sdkOptions.config.forced_login_method,'chatgpt');
    assert.ok(call.sdkOptions.configOverrides.includes('features.shell_tool=false'));
    assert.ok(!call.sdkOptions.configOverrides.some(x=>x.includes('mcp_servers.assistant')));
    assert.equal(call.sdkOptions.env.OPENAI_API_KEY,undefined);
    assert.equal(JSON.stringify(call.input).includes('grounding'),false);
    await assert.rejects(fs.access(call.options.workingDirectory));
  }
  const answers=captures.filter(x=>x.outputSchema.properties.text);
  assert.ok(answers.every(x=>x.input[0].text.includes('Recent conversation (source data): []')));
});

test('adapter rejects unexpected tool activity and enforces a global call budget',async()=>{
  assert.equal(typeof adapterApi.createAdapter,'function','runtime adapter must exist');
  const bad=adapterApi.createAdapter({CodexClass:fakeCodex([],true),model:'synthetic-model',maxCalls:10});
  await assert.rejects(bad.run(scenario,{memoryEnabled:true}),/Unexpected tool/);
  const capped=adapterApi.createAdapter({CodexClass:fakeCodex([]),model:'synthetic-model',maxCalls:1});
  await assert.rejects(capped.run(scenario,{memoryEnabled:true}),/call budget/);
});

test('comparison separates answer behavior from trivially absent baseline records',async()=>{
  const report=await api.runSuite({scenarios:[scenario],expectations:[expectations],adapter:{name:'fake-test-only',run:async(input,{memoryEnabled})=>memoryEnabled ? observation : {probes:[{id:'q1',answer:'Use five entries.',memory:[],learning:[]}],calls:1}}});
  assert.equal(report.comparisons[0].answers.delta,0);
  assert.equal(report.comparisons[0].records.delta,1);
});


test('fake learning review validates, transfers context and retains a rollback audit',async()=>{
  const captures=[];
  const {scenarios}=await api.loadSuite();
  const learningCase=scenarios.find(x=>x.id==='planning-lesson-rollback');
  const rule={key:'check-result',kind:'rule',target:'PLAYBOOK.md',content:'Include a verification step in planning checklists.',scope:'planning',expected_benefit:'Avoid repeated corrections.',check:'A planning checklist includes a verification step.',sources:['history:3'],expected_revision:0,status:'trial'};
  const respond=schema=>schema.properties.decisions ? {decisions:[{key:rule.key,accept:true,reason:'Synthetic test accepts supplied evidence.'}]} : schema.properties.changes ? {summary:'',changes:[rule]} : {text:'Prepare, practice, verify.',voice:false,files:[]};
  const result=await adapterApi.createAdapter({CodexClass:fakeCodex(captures,false,respond),model:'synthetic-model'}).run(learningCase,{memoryEnabled:true});
  assert.equal(result.probes[0].learning[0].status,'trial');
  assert.equal(result.probes[1].learning[0].status,'retired');
  assert.deepEqual(result.probes[1].learning[0].sources,['m3','m4']);
  const answers=captures.filter(x=>x.outputSchema.properties.text);
  assert.match(answers[0].input[0].text,/Scoped learned adaptations[^\n]+check-result/);
  assert.match(answers[1].input[0].text,/Scoped learned adaptations[^\n]+: \[\]/);
  assert.equal(captures.length,4);
});

test('negative checks cannot silently pass with a misspelled record filter',async()=>{
  await assert.rejects(api.runSuite({scenarios:[scenario],expectations:[{id:scenario.id,checks:[{id:'bad-filter',at:'q1',target:'memory',where:{sttaus:'active'},max:0}]}],adapter:{run:async()=>observation}}),/filter/);
});

test('ordinary cross-chat probes include only that conversation recent history',async()=>{
  const captures=[];
  const input={id:'local-history',stages:[{messages:[{id:'a',role:'user',conversation:'project-a',text:'SOURCE-A-CANARY'},{id:'b',role:'user',conversation:'project-b',text:'SOURCE-B-CANARY'}],maintenance:[],probes:[{id:'q',conversation:'project-b',fresh:false,prompt:'What did I just say?'}]}]};
  await adapterApi.createAdapter({CodexClass:fakeCodex(captures),model:'synthetic-model'}).run(input,{memoryEnabled:true});
  assert.match(captures[0].input[0].text,/SOURCE-B-CANARY/);
  assert.doesNotMatch(captures[0].input[0].text,/SOURCE-A-CANARY/);
});

test('ambiguity scoring requires each project/person/day association',async()=>{
  const {expectations:gold}=await api.loadSuite();
  const expected=gold.find(x=>x.id==='ambiguous-rowan');
  const record=content=>({content,status:'active',sources:['m1']});
  const larch=record('Larch Rowan wants a Tuesday review.');
  const cedar=record('Cedar Rowan wants a Friday review.');
  const score=memory=>api.scoreCase({probes:[{id:'which',answer:'Which Rowan do you mean?',memory,learning:[]}]},expected);
  assert.equal(score([larch]).every(x=>x.passed),false,'Losing Cedar must fail');
  assert.equal(score([cedar]).every(x=>x.passed),false,'Losing Larch must fail');
  assert.equal(score([record('Larch Rowan wants a Friday review.'),record('Cedar Rowan wants a Tuesday review.')]).every(x=>x.passed),false,'Swapped days must fail');
  assert.equal(score([larch,cedar]).every(x=>x.passed),true,'Separate correct records must pass');
  assert.equal(score([record('Larch Rowan wants Tuesday. Cedar Rowan wants Friday.')]).every(x=>x.passed),true,'Combined correct records must pass');
  assert.equal(score([record('Larch Rowan wants Friday. Cedar Rowan wants Tuesday.')]).every(x=>x.passed),false,'Combined swapped associations must fail');
});

test('comparison denominators and unscored counts survive an error in either arm',async()=>{
  for(const errorMode of ['on','off']) {
    const report=await api.runSuite({scenarios:[scenario],expectations:[expectations],adapter:{name:'fake-test-only',run:async(input,{memoryEnabled})=>{
      if((memoryEnabled?'on':'off')===errorMode)throw Error('private-runtime-detail');
      return observation;
    }}});
    const comparison=report.comparisons[0];
    assert.equal(comparison.total,2);assert.equal(comparison.answers.total,1);assert.equal(comparison.records.total,1);
    assert.equal(comparison.delta,null);assert.equal(comparison.answers.delta,null);
    const failedArm=report.cases.find(x=>x.mode===errorMode), completedArm=report.cases.find(x=>x.mode!==errorMode);
    assert.deepEqual(failedArm.metricCounts,{passed:0,failed:0,unscored:2});
    assert.deepEqual(completedArm.metricCounts,{passed:2,failed:0,unscored:0});
    assert.equal(failedArm.metrics.length,2);assert.ok(failedArm.metrics.every(x=>x.passed===null));
    assert.deepEqual(comparison[`${errorMode}Counts`],{passed:0,failed:0,unscored:2});
    assert.deepEqual(comparison.answers[`${errorMode}Counts`],{passed:0,failed:0,unscored:1});
  }
});

test('provenance hashes all assembled-profile templates and actual per-turn inputs',async()=>{
  const captures=[];const adapter=adapterApi.createAdapter({CodexClass:fakeCodex(captures),model:'synthetic-model'});
  const {createHash}=await import('node:crypto');const digest=value=>createHash('sha256').update(value).digest('hex');
  for(const name of ['AGENTS.md','SOUL.md','USER.md','MEMORY.md','LEARNING.md','LOCATION.md','TOOLS.md','SKILLS.md','TELEGRAM-READ.md']) {
    assert.equal(adapter.runtime.sourceSha256[`templates/${name}`],digest(await fs.readFile(`templates/${name}`)),name);
  }
  const result=await adapter.run(scenario,{memoryEnabled:true});
  assert.equal(result.promptInputs.length,captures.length);
  for(const [index,call] of captures.entries()) {
    const hashes=result.promptInputs[index];
    assert.equal(hashes.developerInstructionsSha256,digest(call.sdkOptions.config.developer_instructions));
    assert.equal(hashes.inputSha256,digest(JSON.stringify(call.input)));
    assert.equal(hashes.outputSchemaSha256,digest(JSON.stringify(call.outputSchema)));
    for(const name of ['AGENTS.md','SOUL.md','USER.md'])assert.match(hashes.profilesSha256[name],/^[a-f0-9]{64}$/);
  }
});

test('later probe failure preserves safe quota accounting and completed synthetic observations',async()=>{
  const input=structuredClone(scenario);input.stages[0].probes.push({...input.stages[0].probes[0],id:'q2'});
  const gold=structuredClone(expectations);gold.checks.push({...gold.checks[0],id:'second-answer',at:'q2'});
  let responses=0;
  const respond=schema=>{
    if(++responses===3)throw Error('private-error-do-not-publish');
    return schema.properties.changes ? {summary:'',changes:[]} : {text:'Use five entries.',voice:false,files:[]};
  };
  const adapter=adapterApi.createAdapter({CodexClass:fakeCodex([],false,respond),model:'synthetic-model'});
  const report=await api.runSuite({scenarios:[input],expectations:[gold],adapter,modes:['on']});
  assert.equal(report.cases[0].status,'error');
  assert.equal(report.cases[0].observation.calls,3);
  assert.equal(report.cases[0].observation.usage.output_tokens,8);
  assert.equal(report.cases[0].observation.probes.length,1);
  assert.equal(report.cases[0].observation.probes[0].id,'q1');
  assert.equal(JSON.stringify(report).includes('private-error-do-not-publish'),false);
  assert.deepEqual(report.cases[0].metricCounts,{passed:0,failed:0,unscored:3});
});


test('completed evaluation does not abort SDK streams after their cleanup',async()=>{
  const captures=[];
  const adapter=adapterApi.createAdapter({CodexClass:fakeCodex(captures),model:'synthetic-model'});
  await adapter.run(scenario,{memoryEnabled:true});
  assert.equal(captures.length,2);
  assert.ok(captures.every(call=>!call.signal.aborted));
});
