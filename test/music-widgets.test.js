import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {responsePayloads} from '../src/presentation.js';

const root=path.resolve('shared-skill/music-assistant');
const names=['melody','intervals','scale','chords','harmony'];
function generate(name,output,extra=[]) {
  const source=name.endsWith('.json')?name:path.join(root,'templates',name+'.json');
  const result=spawnSync('python3',[path.join(root,'scripts/widget.py'),source,'--agent-requests','--out',output,...extra],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
}

test('all music lesson templates satisfy the actual final presentation normalizer',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'music-widget-contract-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  for(const name of names) {
    const output=path.join(directory,name);generate(name,output);
    const response=JSON.parse(await fs.readFile(path.join(output,'response.json'),'utf8'));
    const payload=responsePayloads(response)[0];
    assert.equal(payload.type,'widget',name+' was downgraded to text fallback');
    assert.equal(payload.actions.length,1);
    assert.equal(typeof payload.state,'string');
    assert.equal(JSON.parse(payload.state).step,0);
    assert.equal(response.files.length,0);
    assert.equal(responsePayloads(response,{widgets:false})[0].text,response.text);
  }
});

test('music widgets render at phone widths and handle offered requests plus revisioned state',
  {skip:process.env.MUSIC_WIDGET_BROWSER!=='1',timeout:120000},async t=>{
  const {chromium}=await import('playwright');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'music-widget-browser-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
  t.after(()=>browser.close());
  const artifacts=process.env.MUSIC_WIDGET_ARTIFACTS?path.resolve(process.env.MUSIC_WIDGET_ARTIFACTS):null;
  if(artifacts)await fs.mkdir(artifacts,{recursive:true});
  for(const name of names) {
    const output=path.join(directory,name);generate(name,output);
    for(const theme of ['light','dark']) {
      const page=await browser.newPage({viewport:{width:320,height:560},colorScheme:theme});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.route('https://**/*',route=>route.abort());
      await page.addInitScript(()=>{
        window.calls=[];window.nextAnswer='accepted';window.events={};window.pendingAnswer=null;
        window.TelegramWidget={chatData:JSON.stringify({revision:0,status:'ready',data:{step:0,show_harmony:true},reply:''}),
          ready(){window.readyCalled=true;},onEvent(name,handler){window.events[name]=handler;},
          request(id){window.calls.push(id);return new Promise((resolve,reject)=>{window.pendingAnswer={resolve,reject};});}};
      });
      await page.goto(pathToFileURL(path.join(output,'widget.html')).href);
      if(theme==='dark')await page.addStyleTag({content:':root{--tg-theme-bg-color:#17212b;--tg-theme-text-color:#eef2f6;--tg-theme-hint-color:#9dafbe;--tg-theme-button-color:#6ab3f3;--tg-theme-button-text-color:#101b26}'});
      assert.equal(await page.evaluate(()=>window.calls.length),0,'No requests on startup');
      const initial=await page.locator('#explanation').textContent();
      await page.locator('#next').click();
      assert.notEqual(await page.locator('#explanation').textContent(),initial);
      await page.locator('#prev').click();
      assert.equal(await page.locator('#explanation').textContent(),initial);
      if(name==='harmony') {
        await page.locator('#toggle').click();
        assert.equal(await page.locator('#h0_0').evaluate(el=>el.style.display),'none');
        await page.locator('#toggle').click();
        assert.notEqual(await page.locator('#h0_0').evaluate(el=>el.style.display),'none');
      }
      const dimensions=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));
      assert.ok(dimensions.width<=320,name+' overflowed the phone width');
      assert.ok(dimensions.height<=560,name+' exceeded Telegram height');
      if(artifacts)await page.screenshot({path:path.join(artifacts,name+'-'+theme+'.png'),fullPage:true});
      await page.locator('#a0').click();
      assert.ok(await page.locator('#a0').isDisabled());
      await page.evaluate(()=>window.pendingAnswer.resolve({result:JSON.stringify({accepted:true})}));
      await page.waitForFunction(()=>document.getElementById('status').textContent.includes('queued'));
      await page.evaluate(()=>{TelegramWidget.chatData=JSON.stringify({revision:2,status:'completed',data:{step:1,show_harmony:true},reply:'A concise answer.'});events.chatDataChanged();});
      assert.ok(!(await page.locator('#a0').isDisabled()));
      assert.equal(await page.locator('#reply').textContent(),'A concise answer.');
      const step=await page.locator('#counter').textContent();
      await page.evaluate(()=>{TelegramWidget.chatData=JSON.stringify({revision:1,status:'working',data:{step:0},reply:'old'});events.chatDataChanged();});
      assert.equal(await page.locator('#counter').textContent(),step,'Old revision regressed the selected step');
      assert.equal(await page.locator('#reply').textContent(),'A concise answer.');
      await page.locator('#next').click();
      const localStep=await page.locator('#counter').textContent();
      await page.evaluate(()=>{TelegramWidget.chatData=JSON.stringify({revision:3,status:'working',data:{step:1,show_harmony:true},reply:''});events.chatDataChanged();});
      assert.equal(await page.locator('#counter').textContent(),localStep,'Status-only changes reset local navigation');
      await page.evaluate(()=>{TelegramWidget.chatData=JSON.stringify({revision:4,status:'completed',data:{step:1,show_harmony:true},reply:''});events.chatDataChanged();});
      await page.locator('#a0').click();
      await page.evaluate(()=>{TelegramWidget.chatData=JSON.stringify({revision:5,status:'completed',data:{step:1,show_harmony:true},reply:'<b>A literal reply</b>'});events.chatDataChanged();pendingAnswer.resolve({result:JSON.stringify({accepted:true})});});
      await page.waitForFunction(()=>!document.getElementById('a0').disabled);
      assert.match(await page.locator('#status').textContent(),/finished/,'Late acceptance regressed live completion');
      assert.equal(await page.locator('#reply').textContent(),'<b>A literal reply</b>');
      assert.equal(await page.locator('#reply b').count(),0,'Reply markup executed');
      for(const error of ['busy','expired','rate_limited']) {
        await page.locator('#a0').click();
        await page.evaluate(error=>pendingAnswer.resolve({result:JSON.stringify({accepted:false,error})}),error);
        await page.waitForFunction(()=>!document.getElementById('a0').disabled);
        assert.ok((await page.locator('#status').textContent()).length>5);
      }
      await page.locator('#a0').click();
      await page.evaluate(()=>pendingAnswer.reject(new Error('synthetic bridge rejection')));
      await page.waitForFunction(()=>!document.getElementById('a0').disabled);
      assert.match(await page.locator('#status').textContent(),/failed/);
      assert.deepEqual(errors,[],name+' produced browser errors');
      await page.close();
    }
  }
  for(const mode of ['absent','no_methods','throwing_methods']) {
    const page=await browser.newPage({viewport:{width:320,height:560}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(mode=>{
      if(mode==='absent')return;
      window.TelegramWidget={chatData:'not valid JSON'};
      if(mode==='throwing_methods') {
        window.TelegramWidget.onEvent=()=>{throw new Error('synthetic event registration failure');};
        window.TelegramWidget.ready=()=>{window.readyAttempted=true;throw new Error('synthetic ready failure');};
      }
    },mode);
    await page.goto(pathToFileURL(path.join(directory,'harmony/widget.html')).href);
    assert.ok(await page.locator('#a0').isDisabled());
    const initial=await page.locator('#explanation').textContent();
    await page.locator('#next').click();
    assert.notEqual(await page.locator('#explanation').textContent(),initial);
    await page.locator('#toggle').click();
    assert.equal(await page.locator('#h1_0').evaluate(el=>el.style.display),'none');
    if(mode==='throwing_methods')assert.equal(await page.evaluate(()=>window.readyAttempted),true);
    assert.deepEqual(errors,[],mode+' broke local controls');
    await page.close();
  }
  const russian=JSON.parse(await fs.readFile(path.join(root,'templates/harmony.json'),'utf8'));
  Object.assign(russian,{lang:'ru',title:'Второй голос терциями',context:'Учебная фраза в до мажоре · время в долях',
    caption:'Учебный вариант: к C4–D4–E4–F4 добавлены E4–F4–G4–A4. Терции чередуются: 4, 3, 3, 4 полутона. Проверьте аккорды и диапазон. Аудио и MIDI — отдельные файлы.'});
  const comments=['C4 + E4: большая терция, четыре полутона. Проверьте, подходит ли E к аккорду.',
    'D4 + F4: малая терция, три полутона. Сдвиг на четыре полутона дал бы F# вне до мажора.',
    'E4 + G4: малая терция. Ноты гаммы ещё не гарантируют согласия с аккомпанементом.',
    'F4 + A4: большая терция. Послушайте фразу целиком и проверьте диапазон.'];
  russian.notes.forEach((note,i)=>note.comment=comments[i]);
  russian.actions[0].label='Спросить агента о втором голосе';
  const input=path.join(directory,'harmony-ru.json');await fs.writeFile(input,JSON.stringify(russian));
  const output=path.join(directory,'harmony-ru');generate(input,output);
  for(const width of [320,375]) {
    const page=await browser.newPage({viewport:{width,height:560}});
    await page.addInitScript(()=>{window.TelegramWidget={chatData:JSON.stringify({revision:0,status:'completed',data:{step:0},reply:'Проверьте аккорды и диапазон. '.repeat(7)}),request(){throw new Error('No request expected');}};});
    await page.goto(pathToFileURL(path.join(output,'widget.html')).href);
    assert.equal(await page.locator('html').getAttribute('lang'),'ru');
    await page.locator('#next').click();
    assert.match(await page.locator('#explanation').textContent(),/малая терция/);
    const dimensions=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}));
    assert.ok(dimensions.width<=width,'Russian lesson overflowed width');
    assert.ok(dimensions.height<=560,'Russian lesson exceeded Telegram height');
    if(artifacts)await page.screenshot({path:path.join(artifacts,'harmony-ru-'+width+'.png'),fullPage:true});
    await page.close();
  }
});
