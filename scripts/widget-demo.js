// Operator-only live demo. No service initialization/recovery, model call or poller.
// --send queues one widget for the configured owner's existing default chat.
// --status UUID prints content-free receipts for that widget only.
import path from 'node:path';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {responsePayloads} from '../src/presentation.js';
const cfg=config(),args=process.argv.slice(2);assert.ok(cfg.owner&&cfg.token,'Configured owner and bot required');
assert.ok(args.includes('--send')!==args.includes('--status'),'Choose --send or --status ID');
const store=new Store(path.join(cfg.workspace,'state','assistant.sqlite'));
try {
 const conversation=store.db.prepare("SELECT * FROM conversations WHERE owner=? AND kind='dm' AND state='active'").get(cfg.owner);assert.ok(conversation,'Existing owner DM required');
 store.bindConversation(cfg.owner);
 if(args.includes('--status')) {
  const id=args[args.indexOf('--status')+1];
  const row=store.prepare('SELECT id,status,revision,input_id,outbox_id,message_id FROM telegram_widgets WHERE $scope AND owner=? AND id=?').get(cfg.owner,id);
  if(!row){console.log(JSON.stringify({registered:false}));}
  else {
   const queries=store.db.prepare('SELECT count(*) AS n FROM telegram_widget_queries WHERE widget_id=?').get(id).n;
   const input=row.input_id?store.prepare('SELECT state FROM inputs WHERE $scope AND id=? AND user=?').get(row.input_id,cfg.owner):null;
   const edits=store.prepare("SELECT state,count(*) AS n FROM outbox WHERE $scope AND json_extract(payload,'$.type')='widget-state' AND json_extract(payload,'$.widgetId')=? GROUP BY state").all(id);
   console.log(JSON.stringify({registered:true,id:row.id,status:row.status,revision:row.revision,message_id:row.message_id,queries,input_state:input?.state,edits}));
  }
 } else {
  const html=`<!DOCTYPE html><html><head><style>body{font:14px/1.45 system-ui;color:var(--tg-theme-text-color);padding:8px}h2{font-size:21px;margin:4px 0}p{margin:10px 0}.muted{color:var(--tg-theme-hint-color)}button{display:block;width:100%;margin:8px 0;padding:12px;border:0;border-radius:10px;background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color);font:inherit}#reply{padding:12px;background:var(--tg-theme-secondary-bg-color);border-radius:10px}</style></head><body><h2>Ask your agent from a widget</h2><p class="muted">A button sends its offered question to the agent. Live status and a reply preview appear here.</p><button id="jitter">Explain retry jitter</button><button id="cap">Why cap the delay?</button><p id="status">Ready</p><p id="focus" class="muted"></p><p id="reply">Choose a question.</p><script>try{var W=window.TelegramWidget;var latest=-1,buttons=[document.getElementById('jitter'),document.getElementById('cap')];function render(){var s={};try{s=JSON.parse(W.chatData||'{}')}catch(e){}if((s.revision||0)<latest)return;latest=s.revision||0;document.getElementById('status').textContent='Agent: '+(s.status||'ready');document.getElementById('focus').textContent=(s.data||{}).focus||'';document.getElementById('reply').textContent=s.reply||'The full answer also arrives in chat.';var busy=s.status==='queued'||s.status==='working'||s.status==='cancel_requested';buttons.forEach(function(b){b.disabled=busy})}buttons.forEach(function(b){b.addEventListener('click',function(){buttons.forEach(function(x){x.disabled=true});document.getElementById('status').textContent='Sending to agent…';W.request(b.id).then(function(a){var r=JSON.parse(a.result||'{}');document.getElementById('status').textContent=r.accepted?'Request queued':('Not accepted: '+r.error);if(!r.accepted)buttons.forEach(function(x){x.disabled=false})},function(e){document.getElementById('status').textContent='Request error: '+e.code;buttons.forEach(function(x){x.disabled=false})})})});if(W&&typeof W.onEvent==='function')W.onEvent('chatDataChanged',render);render();if(W&&typeof W.ready==='function')W.ready();}catch(e){try{document.getElementById('status').textContent='Widget initialization: '+String(e.message||e)}catch(ignore){}}</script></body></html>`;
  const actions=[{id:'jitter',label:'Explain retry jitter',prompt:'Explain exponential backoff with jitter in two short sentences. First call widget_read for the Widget ID in this event, then widget_update using the fresh revision and state {"focus":"Jitter explained"}. Answer directly, without delegation, file creation or external tools.'},{id:'cap',label:'Why cap the delay?',prompt:'Explain why exponential backoff needs a maximum delay in two short sentences. First call widget_read for this event widget, then widget_update with fresh revision and state {"focus":"Delay cap explained"}. Answer directly without delegation or external tools.'}];
  const payloads=responsePayloads({text:'Callback demo: “Explain retry jitter” or “Why cap the delay?” sends a question to the agent. The widget shows live queued/working/completed status and a reply preview; the full answer arrives in chat.',presentation:{kind:'widget',content:html,actions,state:'{"focus":"Choose a question"}'}});
  assert.equal(payloads[0]?.type,'widget');assert.ok(payloads[0].widgetId);
  store.transaction(()=>{store.enqueue(cfg.owner,payloads[0]);store.history(cfg.owner,'assistant','A callback demonstration offers two explanation requests: retry jitter and a maximum retry delay.');});
  console.log(JSON.stringify({queued:true,widget_id:payloads[0].widgetId}));
 }
} catch {console.error('Widget demo failed; private details suppressed');process.exitCode=1;}
finally {store.db.close();}
