import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { assistantMcp } from './mcp-tools.js';
import { AdmissionConflict } from './store.js';
const server=assistantMcp({worker:process.env.ASSISTANT_WORKER==='true',memoryReview:process.env.ASSISTANT_MEMORY_REVIEW==='true',invoke:async(name,args)=>{
  const response=await fetch(`http://127.0.0.1:${process.env.ASSISTANT_PORT||8765}/tool`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.ASSISTANT_CAPABILITY}`},body:JSON.stringify({name,args}),signal:AbortSignal.timeout(name==='send_voice'?150000:15000)});
  if(response.status===409)throw new AdmissionConflict();
  if(!response.ok)throw new Error('Tool denied');return response.json();
}});
await server.connect(new StdioServerTransport());
