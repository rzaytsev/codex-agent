import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Locations, LOCATION_TTL_MS, LOCATION_HEADING } from '../src/location.js';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Service } from '../src/service.js';

async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'location-test-'));
 const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',WORKSPACE_DIR:dir,PROACTIVE_ENABLED:'false'});
 const store=new Store(path.join(dir,'test.sqlite'));
 const service=new Service(cfg,store,{}, {run:async()=>{throw new Error('Location must not invoke model');}});
 await service.init();
 t.after(async()=>{store.db.close();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,store,service,locations:service.locations};
}
const message=(now,id=1)=>({message_id:id,date:Math.floor(now/1000),from:{id:123},chat:{id:123,type:'private'},location:{latitude:41,longitude:2,horizontal_accuracy:10}});

test('temporary wins for less than 12 hours, then default; persistence and owner isolation',async t=>{
 const {locations,dir}=await fixture(t),now=Date.parse('2026-09-30T12:00:00Z');
 assert.equal(locations.get('123',now).source,null);
 locations.setDefault('123',{latitude:40,longitude:-3,label:'usual'},now);
 locations.receive('123',message(now),now);
 assert.equal(locations.get('123',now+LOCATION_TTL_MS-1).source,'temporary');
 assert.equal(locations.get('123',now+LOCATION_TTL_MS).source,'default');
 assert.equal(locations.get('123',now+LOCATION_TTL_MS).location.latitude,40);
 assert.equal(new Locations(dir).get('123',now).location.latitude,41);
 assert.equal(locations.get('456',now).source,null);
 assert.equal((await fs.stat(locations.file('123'))).mode & 0o777,0o600);
 locations.clear('123');assert.equal(locations.get('123',now).source,'default');
});
test('stale queued pins do not become fresh on receipt; invalid or older updates preserve data',async t=>{
 const {locations}=await fixture(t),now=Date.parse('2026-09-30T12:00:00Z');
 locations.receive('123',message(now-LOCATION_TTL_MS),now);
 assert.equal(locations.get('123',now).source,null);
 locations.receive('123',message(now,2),now);
 assert.equal(locations.receive('123',message(now-1000,3),now),false);
 assert.equal(locations.receive('123',message(now,1),now),false);
 const before=locations.read('123');
 assert.throws(()=>locations.receive('123',{...message(now),location:{latitude:91,longitude:2}},now));
 assert.throws(()=>locations.setDefault('123',{latitude:40,longitude:'2'},now));
 assert.throws(()=>locations.receive('123',message(now+600000),now));
 assert.deepEqual(locations.read('123'),before);
 assert.equal(locations.promote('123',now+LOCATION_TTL_MS),false);
});
test('authorized location intake and live edits persist without model; duplicates and outsiders cannot alter it',async t=>{
 const {service,store,locations}=await fixture(t),now=Date.now();
 const first={update_id:1,message:message(now)};
 assert.equal(service.ingest({...first,message:{...first.message,from:{id:999},chat:{id:999,type:'private'}}}),false);
 assert.equal(service.ingest(first),true);assert.equal(service.ingest(first),false);
 assert.equal(store.db.prepare('SELECT state FROM inputs WHERE id=1').get().state,'done');
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,1);
 const edited={...message(now),edit_date:Math.floor(now/1000),location:{latitude:42,longitude:3}};
 assert.equal(service.ingest({update_id:2,edited_message:edited}),true);
 assert.equal(locations.read('123').temporary.latitude,42);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM outbox').get().n,1);
 const command={...message(now),location:undefined,text:'/location default'};
 assert.equal(service.ingest({update_id:3,message:command}),true);
 assert.equal(locations.read('123').default.latitude,42);
 assert.equal(service.ingest({update_id:4,message:{...message(now),forward_origin:{type:'hidden_user'}}}),true);
 assert.equal(locations.read('123').temporary.latitude,42);
 assert.equal(service.ingest({update_id:5,edited_message:{...command,text:'edited text'}}),false);
 await assert.rejects(service.tool({user:'456',worker:true},'location_set_default',{latitude:0,longitude:0}));
 await assert.rejects(service.tool({user:'456',worker:true},'location_get'));
 await assert.rejects(service.tool({user:'999'},'location_get'));
});
test('existing workspace instructions are preserved and location rules added once',async t=>{
 const {dir,service}=await fixture(t),file=path.join(dir,'AGENTS.md');
 await fs.writeFile(file,'My custom instructions\n');await service.init();await service.init();
 const text=await fs.readFile(file,'utf8');
 assert(text.startsWith('My custom instructions\n'));
 assert.equal(text.split(LOCATION_HEADING).length,2);
});
