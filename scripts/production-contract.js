import fs from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {loadContracts,runContracts} from './production-contract-harness.js';
import {createContractAdapter} from './production-contract-adapter.js';
try {
  const {values}=parseArgs({options:{output:{type:'string'},repeats:{type:'string',default:'1'}}});
  const report=await runContracts({...await loadContracts(),adapter:createContractAdapter(),repeats:Number(values.repeats)});
  if(values.output)await fs.writeFile(values.output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({lane:report.lane,qualityEvidence:false,modelCalls:0,...report.summary}));
  if(report.summary.failed||report.summary.errors)process.exitCode=1;
} catch {console.error('Synthetic contract evaluation failed; details suppressed');process.exitCode=1;}
