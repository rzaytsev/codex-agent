import {createConnection} from 'node:net';
import fs from 'node:fs/promises';
import {z} from 'zod';
import {isReadOnlyMount} from './isolated-research.js';
import {fetchResearchSource} from './research-fetch.js';

export const browserSocket='/run/codex-agent-browser/stdio.sock';
export const renderHtmlLimit=1536*1024;
export const renderFrameLimit=5*1024*1024;
export const pngSignature=Buffer.from('89504e470d0a1a0a','hex');
export const renderRequest=z.strictObject({
  html:z.string().max(renderHtmlLimit),
  click:z.string().trim().min(1).max(160).optional(),
  screenshot:z.boolean(),
});
const renderReply=z.strictObject({
  title:z.string().max(400), text:z.string().max(16000), controls:z.array(z.string().max(160)).max(24),
  clicked:z.boolean(), image:z.string().max(renderFrameLimit).optional(),
});

async function exchange(input,signal) {
  signal?.throwIfAborted();
  if(!isReadOnlyMount(await fs.readFile('/proc/self/mountinfo','utf8'),'/run/codex-agent-browser'))throw Error('Browser renderer mount unavailable');
  const endpoint=await fs.lstat(browserSocket);
  if(!endpoint.isSocket()||endpoint.uid!==0||(endpoint.mode&0o777)!==0o600)throw Error('Browser renderer unavailable');
  const socket=createConnection(browserSocket);
  const stop=()=>socket.destroy(signal.reason);
  signal?.addEventListener('abort',stop,{once:true});
  try {
    socket.end(JSON.stringify(input));
    if(signal?.aborted)stop();
    const chunks=[];let length=0;
    for await(const chunk of socket) {
      length+=chunk.length;
      if(length>renderFrameLimit)throw Error('Browser response too large');
      chunks.push(chunk);
    }
    signal?.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal?.removeEventListener('abort',stop);socket.destroy();
  }
}

export async function renderPublicPage(url,click,screenshot,signal,{allowedHosts,fetchSource=fetchResearchSource,render=exchange}={}) {
  const source=await fetchSource(url,signal,{allowedHosts});
  if(source.mime!=='text/html'||source.bytes.length>renderHtmlLimit)throw Error('Public HTML under 1.5 MiB required');
  const input=renderRequest.parse({html:source.bytes.toString('utf8'),click,screenshot});
  const {image,...view}=renderReply.parse(await render(input,signal));
  if(view.clicked!==Boolean(click)||Boolean(image)!==screenshot)throw Error('Browser action incomplete');
  const bytes=image?Buffer.from(image,'base64'):undefined;
  if(bytes&&(bytes.length>3*1024*1024||!bytes.subarray(0,8).equals(pngSignature)||bytes.toString('base64')!==image))throw Error('Invalid browser screenshot');
  return {view:{url:source.url,...view},bytes};
}
