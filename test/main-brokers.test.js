import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Service} from '../src/service.js';
import {reviewedActionBundle,validateAction} from '../src/action-registry.js';
import {mapsLookup,readPublicPage} from '../src/main-brokers.js';

const brokerNames = options=>reviewedActionBundle(options).map(a=>a.name).filter(n=>['maps_nearby','maps_route','browser_read'].includes(n));
const origin={latitude:40,longitude:-3};
const destination={latitude:41,longitude:-3};
const route={origin,destination,mode:'WALK'};

test('only an enabled normal main turn sees broker tools',()=>{
  const brokers={maps:true,browser:true};
  assert.deepEqual(brokerNames({brokers}),['maps_nearby','maps_route','browser_read']);
  for(const scope of [{},{brokers,group:true},{brokers,worker:true},{brokers,memoryReview:true},{brokers,toolScope:'read'}])assert.deepEqual(brokerNames(scope),[]);
  assert.throws(()=>config({ISOLATED_MAIN_CHAT:'true'}),/requires isolated/);
  assert.throws(()=>config({BROKER_GOOGLE_MAPS:'true'}),/credential unavailable/);
  assert.throws(()=>validateAction({},'maps_route',{...route,url:'https://example.test'}),/Invalid maps_route/);
});

test('broker rejects a stale turn or different actor before a provider request',async t=>{
  const cfg=config({TELEGRAM_ALLOWED_USER_IDS:'123',BROKER_GOOGLE_MAPS:'true',GOOGLE_MAPS_API_KEY:'synthetic'});
  const store=new Store(':memory:');t.after(()=>store.db.close());
  const service=new Service(cfg,store,{},{});
  store.ingest(1,'123',{text:'Synthetic route'});
  const token=service.capability('123',false,false,undefined,{actorId:'123',inputId:1});
  const cap=service.capabilities.get(token);
  service.mainInput=1;
  await assert.rejects(service.tool(cap,'maps_route',route),/Active private chat required/);
  service.mainBusy=true;
  await assert.rejects(service.tool(cap,'maps_route',route),/Active private chat required/);
  store.prepare("UPDATE inputs SET state='processing' WHERE $scope AND id=1").run();
  await assert.rejects(service.tool({...cap,actorId:'321'},'maps_route',route),/Active private chat required/);
  await assert.rejects(service.tool({...cap,inputId:2},'maps_route',route),/Active private chat required/);
  store.rotateSession('123');
  await assert.rejects(service.tool(cap,'maps_route',route),/Conversation capability revoked/);
});

test('Maps sends only the permitted parameters to fixed endpoints without following redirects',async()=>{
  const signal=AbortSignal.timeout(1000),requests=[];
  const request=async(url,opts)=>{requests.push({url,...opts});return Response.json(url.includes('computeRoutes')?{routes:[{duration:'25s',distanceMeters:34}]}:{places:[{id:'demo'}]});};
  assert.deepEqual(await mapsLookup('maps_route',route,'synthetic',signal,request),{routes:[{duration:'25s',distanceMeters:34}]});
  assert.deepEqual(await mapsLookup('maps_nearby',{center:origin,radius_m:50,limit:2,types:['cafe']},'synthetic',signal,request),{places:[{id:'demo'}]});
  assert.deepEqual(requests.map(r=>r.url),['https://routes.googleapis.com/directions/v2:computeRoutes','https://places.googleapis.com/v1/places:searchNearby']);
  assert.deepEqual(requests.map(r=>JSON.parse(r.body)),[{origin:{location:{latLng:origin}},destination:{location:{latLng:destination}},travelMode:'WALK'},{maxResultCount:2,locationRestriction:{circle:{center:origin,radius:50}},includedTypes:['cafe']}]);
  assert.ok(requests.every(r=>r.method==='POST'&&r.redirect==='error'&&r.headers['x-goog-api-key']==='synthetic'&&r.signal===signal));
  await assert.rejects(mapsLookup('maps_route',route,'synthetic',signal,async()=>Response.json({error:'private provider error'},{status:403})),/^Error: Maps lookup unavailable$/);
});

test('public browser read extracts visible text and uses the configured egress policy',async()=>{
  const url='https://example.com/reference',allowedHosts=new Set(['example.com']),signal=AbortSignal.timeout(5000);
  const fetchSource=async(actual,actualSignal,options)=>{
    assert.equal(actual,url);assert.equal(actualSignal,signal);assert.equal(options.allowedHosts,allowedHosts);
    return {url,mime:'text/html',bytes:Buffer.from('<html><head><title>Sample page</title></head><body><p>Visible fixture</p><script>PRIVATE_SCRIPT</script></body></html>')};
  };
  const result=await readPublicPage(url,signal,{allowedHosts,fetchSource});
  assert.equal(result.url,url);assert.equal(result.title,'Sample page');assert.match(result.text,/Visible fixture/);assert.doesNotMatch(result.text,/PRIVATE_SCRIPT/);
  await assert.rejects(readPublicPage(url,signal,{allowedHosts:new Set(['other.example.com'])}),/allowlist|allowed/i);
  await assert.rejects(readPublicPage(url,signal,{fetchSource:async()=>({mime:'application/pdf'})}),/Public text page required/);
});

test('fresh main turns read only their current session while explicit history remains available',t=>{
  const store=new Store(':memory:');t.after(()=>store.db.close());store.bindConversation('123');
  store.history('123','user','Previous session marker');
  assert.equal(store.search('123','',0,{currentSession:true}).length,1);
  store.rotateSession('123');
  store.history('123','user','Active session marker');
  assert.deepEqual(store.search('123','',0,{currentSession:true}).map(row=>row.text),['Active session marker']);
  assert.equal(store.search('123','Previous session marker').length,1);
});
