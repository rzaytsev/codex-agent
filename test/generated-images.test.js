import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {collectGeneratedImages,generatedImageNames} from '../src/generated-images.js';
const thread='12345678-1234-1234-1234-123456789abc';const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'generated-image-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const home=path.join(root,'codex'),workspace=path.join(root,'workspace'),dir=path.join(home,'generated_images',thread);await fs.mkdir(dir,{recursive:true});await fs.mkdir(workspace);return {root,home,workspace,dir};}
test('only current trusted thread image bytes reach workspace, without credential paths',async t=>{const {home,workspace,dir}=await fixture(t);await fs.writeFile(path.join(dir,'call.png'),png);await fs.writeFile(path.join(home,'auth.json'),'private');await fs.mkdir(path.join(home,'generated_images','other'));await fs.writeFile(path.join(home,'generated_images','other','other.png'),png);const files=await collectGeneratedImages(home,thread,workspace);assert.equal(files.length,1);assert.ok(files[0].startsWith((await fs.realpath(workspace))+'/outputs/imagegen-'));assert.deepEqual(await fs.readFile(files[0]),png);assert.deepEqual(await collectGeneratedImages(home,'../../auth',workspace),[]);});
test('symlinks, hardlinks, invalid bytes and cancellation fail before delivery',async t=>{for(const kind of ['symlink','hardlink','invalid','abort']){const {root,home,workspace,dir}=await fixture(t);const outside=path.join(root,'outside.png');await fs.writeFile(outside,png);const dest=path.join(dir,'call.png');if(kind==='symlink')await fs.symlink(outside,dest);else if(kind==='hardlink')await fs.link(outside,dest);else await fs.writeFile(dest,kind==='invalid'?'not an image':png);const c=new AbortController();if(kind==='abort')c.abort();await assert.rejects(collectGeneratedImages(home,thread,workspace,c.signal));}});

test('resumed threads only publish new generation calls, with bounded counts and bytes',async t=>{
 const {home,workspace,dir}=await fixture(t);await fs.writeFile(path.join(dir,'old.png'),png);
 const existing=await generatedImageNames(home,thread);
 assert.deepEqual(await collectGeneratedImages(home,thread,workspace,undefined,existing),[]);
 await fs.writeFile(path.join(dir,'new.png'),png);
 assert.equal((await collectGeneratedImages(home,thread,workspace,undefined,existing)).length,1);
 for(let n=0;n<4;n++)await fs.writeFile(path.join(dir,`extra-${n}.png`),png);
 await assert.rejects(collectGeneratedImages(home,thread,workspace),/Too many generated images/);
});

test('oversized files and linked output directories are rejected',async t=>{
 const {home,workspace,dir,root}=await fixture(t);const file=path.join(dir,'large.png');
 await fs.writeFile(file,png);await fs.truncate(file,16*1024*1024+1);
 await assert.rejects(collectGeneratedImages(home,thread,workspace),/Unsafe generated image/);
 await fs.rm(file);await fs.writeFile(path.join(dir,'small.png'),png);
 const outside=path.join(root,'outside');await fs.mkdir(outside);
 await fs.symlink(outside,path.join(workspace,'outputs'));
 await assert.rejects(collectGeneratedImages(home,thread,workspace),/Unsafe output directory/);
 assert.deepEqual(await fs.readdir(outside),[]);
});
