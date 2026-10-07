import {spawn} from 'node:child_process';
import {budgetForSignal} from './observations.js';
import {ExecutionUnknown} from './supervised-exec.js';
const pending=new WeakMap();
const failure=()=>new Error('Media process failed');
export async function settleOwnedProcesses(run){
  if(!run)return;
  await Promise.allSettled([...(pending.get(run)||[])]);
  if(run.executionUnknown)throw new ExecutionUnknown();
}
// Media helpers use the same exit contract as the SDK child. execFile's AbortError
// callback alone is not proof that a SIGTERM-ignoring child has exited.
export function ownedExec(file,args,{signal,env,timeout=60000,maxBuffer=1024*1024}={}) {
  const run=budgetForSignal(signal)?.r;
  const promise=execute(file,args,{signal,env,timeout,maxBuffer}).catch(error=>{if(error.executionUnknown&&run)run.executionUnknown=true;throw error;});
  if(run){let set=pending.get(run);if(!set)pending.set(run,set=new Set());set.add(promise);promise.then(()=>set.delete(promise),()=>set.delete(promise));}
  return promise;
}
async function execute(file,args,{signal,env,timeout,maxBuffer}) {
  signal?.throwIfAborted();
  if(!['linux','darwin'].includes(process.platform))throw failure();
  return new Promise((resolve,reject)=>{
    let child;try{child=spawn(file,args,{env,detached:true,stdio:['ignore','pipe','ignore']});}catch{reject(failure());return;}
    let terminal=false,exited=false,failed=false,bytes=0,killTimer,unknownTimer,closeTimer;const chunks=[];
    const kill=sig=>{if(!child.pid)return;try{process.kill(-child.pid,sig);}catch{try{child.kill(sig);}catch{}}};
    const finish=()=>{if(terminal)return;terminal=true;clearTimeout(deadline);clearTimeout(killTimer);clearTimeout(unknownTimer);clearTimeout(closeTimer);signal?.removeEventListener('abort',abort);kill('SIGKILL');child.stdout.destroy();if(!exited)reject(new ExecutionUnknown());else if(signal?.aborted)reject(signal.reason);else if(failed)reject(failure());else resolve({stdout:Buffer.concat(chunks).toString('utf8')});};
    const abort=()=>{kill('SIGTERM');killTimer??=setTimeout(()=>kill('SIGKILL'),250);unknownTimer??=setTimeout(finish,1750);};
    const deadline=setTimeout(()=>{failed=true;abort();},timeout);
    child.once('error',()=>{failed=true;if(!child.pid){exited=true;finish();}else abort();});
    child.once('exit',code=>{exited=true;if(code!==0)failed=true;closeTimer=setTimeout(finish,250);});
    child.once('close',finish);
    child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxBuffer){failed=true;abort();}else chunks.push(chunk);});
    child.stdout.on('error',()=>{failed=true;abort();});
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
