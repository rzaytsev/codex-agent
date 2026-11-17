import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const SOURCE_MAX_BYTES=8*1024*1024;
const reservedV4=new net.BlockList();
for(const [address,prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3],
])reservedV4.addSubnet(address,prefix,'ipv4');
const reservedV6=new net.BlockList();
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]])reservedV6.addSubnet(address,prefix,'ipv6');
const hostKey=hostname=>hostname.toLowerCase().replace(/\.$/,'');
export function researchAllowedHosts(value='') {
  if(!value.trim())return null;
  const hosts=value.split(',').map(part=>hostKey(part.trim()));
  if(hosts.some(host=>host.length>253||!host.includes('.')||net.isIP(host)||
    !host.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))throw new Error('Invalid RESEARCH_ALLOWED_HOSTS');
  return new Set(hosts);
}
export function publicAddress(address) {
  const family=net.isIP(address);
  if(family===4)return !reservedV4.check(address,'ipv4');
  // Exclude non-global allocations and transition/documentation ranges.
  return family===6&&/^[23][0-9a-f]{3}:/i.test(address)&&!reservedV6.check(address,'ipv6');
}
export function sourceUrl(value) {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port))||url.hostname.endsWith('.local')||url.hostname.endsWith('.localhost')||url.hostname==='localhost')throw new Error('Public source URL required');
  url.hash='';return url.href;
}
// Resolve and pin a public address for every hop. No ambient credentials/cookies,
// proxy grants or automatic redirects; reject internal destinations before I/O.
export async function fetchResearchSource(value,signal,{lookup=dns.lookup,request,allowedHosts}={}) {
  let current=sourceUrl(value);
  for(let hop=0;hop<5;hop++) {
    signal?.throwIfAborted();const url=new URL(current),host=url.hostname.replace(/^\[|\]$/g,'');
    if(allowedHosts&&!allowedHosts.has(hostKey(host)))throw new Error('Research source host is outside the allowlist');
    const addresses=net.isIP(host)?[{address:host,family:net.isIP(host)}]:await lookup(host,{all:true,verbatim:true});
    signal?.throwIfAborted();
    if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('Public source URL required');
    const selected=addresses[0];
    const response=await new Promise((resolve,reject)=>{
      const call=request||(url.protocol==='https:'?https.request:http.request);
      const req=call(url,{method:'GET',signal,headers:{'user-agent':'CodexPersonalAssistantResearch/1.0','accept':'text/html,application/pdf,text/plain,application/json,application/xml'},lookup:(_host,options,callback)=>callback(null,options?.all?[selected]:selected.address,selected.family)},res=>{
        if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){res.resume();resolve({redirect:new URL(res.headers.location,url).href});return;}
        if(res.statusCode!==200){res.resume();reject(new Error('Source unavailable'));return;}
        const parts=[];let size=0;
        res.on('data',part=>{size+=part.length;if(size>SOURCE_MAX_BYTES){res.destroy();reject(new Error('Source too large'));}else parts.push(part);});
        res.on('end',()=>resolve({url:current,mime:String(res.headers['content-type']||'text/plain').split(';')[0].toLowerCase(),bytes:Buffer.concat(parts)}));
        res.on('error',()=>reject(new Error('Source unavailable')));
      });
      req.setTimeout(45000,()=>req.destroy(new Error('Source timeout')));
      req.on('error',()=>reject(signal?.aborted?signal.reason:new Error('Source unavailable')));req.end();
    });
    if(!response.redirect)return response;
    current=sourceUrl(response.redirect);
  }
  throw new Error('Source redirect limit');
}
