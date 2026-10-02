import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'browser-smoke-'));
const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(req.url==='/next'?'<h1>Navigation passed</h1>':'<h1>Browser ready</h1><a href="/next">Continue</a>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const clients=[];
try {
 for(let i=0;i<2;i++) {
  const client=new Client({name:'browser-smoke',version:'1.0.0'});
  const transport=new StdioClientTransport({command:'node',args:[path.resolve('node_modules/@playwright/mcp/cli.js'),'--headless','--isolated','--no-sandbox','--executable-path',process.env.BROWSER_EXECUTABLE||'/usr/bin/chromium','--output-dir',dir],cwd:dir,env:{PATH:process.env.PATH,HOME:dir}});
  await client.connect(transport);clients.push(client);
  const tools=await client.listTools();assert(tools.tools.some(t=>t.name==='browser_take_screenshot'));
  const nav=await client.callTool({name:'browser_navigate',arguments:{url:`http://127.0.0.1:${server.address().port}/`}});assert(!nav.isError);
 }
 const click=await clients[0].callTool({name:'browser_click',arguments:{element:'Continue link',target:'a'}});assert(!click.isError,JSON.stringify(click));
 const snapshot=await clients[0].callTool({name:'browser_snapshot',arguments:{}});assert(JSON.stringify(snapshot).includes('Navigation passed'));
 const independent=await clients[1].callTool({name:'browser_snapshot',arguments:{}});assert(JSON.stringify(independent).includes('Browser ready'));assert(!JSON.stringify(independent).includes('Navigation passed'));
 const screenshot=await clients[0].callTool({name:'browser_take_screenshot',arguments:{filename:'smoke.png',type:'png',fullPage:false}});assert(!screenshot.isError);
 const pixels=await fs.readFile(path.join(dir,'smoke.png'));assert(pixels.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
 console.log('Browser MCP navigation, click, screenshot and concurrent session isolation passed');
} finally {
 for(const client of clients) await client.close();
 await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});
}
