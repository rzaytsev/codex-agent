import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { actionRegistry, validateAction } from './action-registry.js';
import { AdmissionConflict } from './store.js';
export function assistantMcp({group=false,worker=false,memoryReview=false,toolScope='conversation',invoke}) {
 const server=new McpServer({name:'personal-assistant',version:'0.1.0'});
 const cap={worker,memoryReview,toolScope};
 for(const action of actionRegistry.values()) {
  const role=memoryReview?'curator':worker?'worker':'main';
  if(!action.roles.includes(role)||!action.scopes.includes(toolScope)||group&&action.dmOnly)continue;
  server.registerTool(action.name,{description:action.description,inputSchema:action.schema},async(args)=>{
   try {const checked=validateAction(cap,action.name,args);const result=await invoke(action.name,checked.args);return {content:[{type:'text',text:JSON.stringify(result)}],isError:false};}
   catch(e) {return {content:[{type:'text',text:e instanceof AdmissionConflict?'Admission conflict: key already identifies different intent. Reconcile the original task/schedule; use a new key only for a deliberately new request.':'Assistant service unavailable or tool denied'}],isError:true};}
  });
 }
 return server;
}
