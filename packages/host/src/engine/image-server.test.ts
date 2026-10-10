import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_ENGINE_SETTINGS, type LocalModel } from '@agent-nekko/shared';
import { createEngineServer, type EngineServer } from './server.js';
const dirs: string[] = [], engines: EngineServer[] = [];
afterEach(async () => { for (const s of engines.splice(0)) await s.stop(); for (const d of dirs.splice(0)) await rm(d,{recursive:true,force:true}); });
const model: LocalModel = { id:'flux',name:'sdxl-turbo',architecture:'sdxl',modality:'image',path:'/models/sdxl-turbo.gguf',sizeBytes:1,addedAt:1 };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(),'nekko-image-server-')); dirs.push(dir);
  const script=join(dir,'server.cjs');
  await writeFile(script,`const port=Number(process.argv[process.argv.indexOf('--listen-port')+1]);require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');if(q.url==='/v1/models')return s.end(JSON.stringify({data:[{id:'flux'}]}));let b='';q.on('data',c=>b+=c);q.on('end',()=>s.end(JSON.stringify({created:1,data:[{b64_json:'fixture'}],echo:JSON.parse(b),path:q.url})));}).listen(port,'127.0.0.1');`);
  const probe=createServer(); await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r)); const port=(probe.address() as {port:number}).port; await new Promise<void>(r=>probe.close(()=>r()));
  const calls: Array<{bin:string,args: readonly string[]}> = [];
  const server=createEngineServer({settings:()=>({...DEFAULT_ENGINE_SETTINGS,port}),binPath:async()=>undefined,diffusionBinPath:async()=>'sd-server',findModel:async id=>id===model.id?model:undefined,listModels:async()=>[model],getGpuStats:async()=>null,spawnFn:((bin:string,args:readonly string[])=>{calls.push({bin,args});return spawn(process.execPath,[script,...args],{stdio:['ignore','pipe','pipe']});}) as typeof spawn});
  engines.push(server); expect((await server.start()).ok).toBe(true); return {server,calls,url:`http://127.0.0.1:${port}/v1`};
}
describe('image-generation routing',()=>{
  it('JIT loads sd-server and returns its OpenAI-compatible image response',async()=>{
    const {url,calls,server}=await fixture(); const res=await fetch(`${url}/images/generations`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'flux',prompt:'cat',size:'512x512'})});
    expect(res.status).toBe(200); const body=await res.json() as {data:unknown[];path:string}; expect(body.data).toHaveLength(1); expect(body.path).toBe('/v1/images/generations'); expect(calls[0].bin).toBe('sd-server'); expect(calls[0].args).toContain('--diffusion-model'); expect(server.resident()).toHaveLength(1);
  });
  it('refuses image models on text endpoints without launching any child',async()=>{
    const {url,calls}=await fixture(); const res=await fetch(`${url}/chat/completions`,{method:'POST',body:JSON.stringify({model:'flux'})}); expect(res.status).toBe(400); expect(calls).toHaveLength(0);
  });
  it('does not pick an image child when an unnamed text request arrives',async()=>{
    const {url,server}=await fixture(); expect((await server.load('flux',{})).ok).toBe(true); const res=await fetch(`${url}/chat/completions`,{method:'POST',body:'{}'}); expect(res.status).toBe(409);
  });
});
