// Runs inside a credential-free, networkless, disposable container.
import {chromium} from 'playwright';
import {renderRequest,renderFrameLimit} from '../src/browser-render.js';

let browser;
try {
  const chunks=[];let length=0;
  for await(const chunk of process.stdin) {
    length+=chunk.length;
    if(length>renderFrameLimit)throw Error();
    chunks.push(chunk);
  }
  const input=renderRequest.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  browser=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage'],timeout:6000});
  const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,viewport:{width:1200,height:800}});
  const page=await context.newPage(),origin='https://page.invalid/';
  let served=false;
  await context.route('**/*',route=>{
    if(served||route.request().url()!==origin||route.request().method()!=='GET')return route.abort();
    served=true;
    return route.fulfill({contentType:'text/html; charset=utf-8',body:input.html,headers:{
      'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts",
    }});
  });
  await page.goto(origin,{waitUntil:'load',timeout:5000});
  if(input.click)await page.getByRole('button',{name:input.click,exact:true}).click({timeout:2500});
  if(page.url()!==origin)throw Error();
  const view=await page.locator('body').evaluate(body=>({
    text:body.innerText.slice(0,16000),
    title:body.ownerDocument.title.slice(0,400),
    controls:Array.from(body.querySelectorAll('button,[role="button"],summary')).slice(0,24).map(el=>(el.getAttribute('aria-label')||el.innerText||'').trim().slice(0,160)).filter(Boolean),
  }),undefined,{timeout:2500});
  const image=input.screenshot?(await page.screenshot({timeout:4000})).toString('base64'):undefined;
  process.stdout.write(JSON.stringify({...view,clicked:Boolean(input.click),image}));
} catch {
  process.exitCode=1;
} finally {await browser?.close();}
