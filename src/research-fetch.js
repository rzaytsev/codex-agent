import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const SOURCE_MAX_BYTES=8*1024*1024;
export function publicAddress(address) {
  if(net.isIP(address)===4) {
    const [a,b]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));
  }
  // Restrict IPv6 to global unicast; mapped, loopback, link-local and ULA fail.
  return net.isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address)&&!/^2001:(?:db8|0):/i.test(address);
}
export function sourceUrl(value) {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||(url.port&&!['80','443'].includes(url.port))||url.hostname.endsWith('.local')||url.hostname.endsWith('.localhost')||url.hostname==='localhost')throw new Error('Public source URL required');
  url.hash='';return url.href;
}
// Resolve and pin a public address for every hop. No ambient credentials/cookies,
// proxy grants or automatic redirects; reject internal destinations before I/O.
export async function fetchResearchSource(value,signal,{lookup=dns.lookup,request}={}) {
  let current=sourceUrl(value);
  for(let hop=0;hop<5;hop++) {
    signal?.throwIfAborted();const url=new URL(current),host=url.hostname.replace(/^\[|\]$/g,'');
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
