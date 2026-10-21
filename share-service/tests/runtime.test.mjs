import { unzipSync } from 'fflate';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeService } from '../server/node.mjs';
import { createService } from '../server/service.mjs';
import { d1Database, r2Objects } from '../server/storage.mjs';
// Miniflare runs the actual workerd SQLite and R2 implementations. Both
// runtimes execute the same API lifecycle and exchange real backup archives.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const origin='https://runtime.test',password='integration-admin-password';
async function client(service){
  const send=async(path,method='GET',data,headers={})=>service.fetch(new Request(origin+'/api/v1/'+path,{method,headers:{Origin:origin,...headers},body:data===undefined?undefined:data instanceof Uint8Array?data:JSON.stringify(data)}));
  const login=await send('admin/login','POST',{password});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  return{send,admin:(path,method='GET',data)=>send('admin/'+path,method,data,{Cookie:cookie,'X-Share-CSRF':'1'})};
}
async function lifecycle(api){
  const {key}=await(await api.admin('publishers','POST',{name:'Runtime test'})).json(),auth={Authorization:'Bearer '+key};
  assert.equal((await api.send('me','GET',undefined,auth)).status,200);
  const stage=await(await api.send('uploads','POST',{},auth)).json();
  const asset=await(await api.send(`uploads/${stage.id}/assets`,'POST',new Uint8Array([137,80,78,71]),{...auth,'Content-Type':'image/png','X-File-Name':encodeURIComponent('runtime.png')})).json();
  const doc={format:2,title:'Runtime folder',entries:[{kind:'directory',path:'empty'},{kind:'markdown',path:'README.md',content:{markdown:`![image](${asset.url})`,inputs:{},results:[]}},{kind:'file',path:'runtime.png',asset:asset.url,mime:'image/png',size:4}],assets:[asset.id],appearance:{},expiresAt:null};
  const response=await api.send(`uploads/${stage.id}/commit`,'POST',doc,auth);assert.equal(response.status,200,await response.clone().text());const share=await response.json();
  assert.equal((await api.send('public/'+share.id)).status,200);assert.equal((await api.send(`public/${share.id}/assets/${asset.id}`)).status,200);
  const stage2=await(await api.send('uploads','POST',{shareId:share.id,version:share.version},auth)).json();
  const asset2=await(await api.send(`uploads/${stage2.id}/assets`,'POST',new Uint8Array([137,80,78,71]),{...auth,'Content-Type':'image/png','X-File-Name':'new.png'})).json();
  const updated=await api.send(`uploads/${stage2.id}/commit`,'POST',{...doc,entries:[doc.entries[0],{...doc.entries[1],content:{markdown:'# Revised',inputs:{},results:[]}},{...doc.entries[2],asset:asset2.url}],assets:[asset2.id]},auth);assert.equal(updated.status,200);assert.equal((await updated.json()).id,share.id);
  const other=await(await api.admin('publishers','POST',{name:'Other owner'})).json();assert.equal((await api.send('shares/'+share.id,'DELETE',undefined,{Authorization:'Bearer '+other.key})).status,404);
  return{share,key,auth,asset:asset2};
}
test('real workerd D1/R2 and file-backed Node SQLite share the lifecycle and migrate both directions',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'idea-share-runtime-'));
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-21',d1Databases:['DB','DB2'],r2Buckets:['BUCKET','BUCKET2']}));
  let node;
  t.after(async()=>{node?.close();await mf.dispose();await rm(dir,{recursive:true,force:true});});
  const binding=await mf.getD1Database('DB');
  const migration=await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8');
  // D1 exec expects one statement per line; use SQLite-complete statements,
  // keeping the restore trigger's internal semicolon intact.
  const triggers=[];const regular=migration.replace(/CREATE TRIGGER[\s\S]*?END;/g,sql=>{triggers.push(sql);return '';});
  const statements=[...regular.split(';').map(s=>s.trim()).filter(Boolean),...triggers];
  for(const sql of statements)await binding.prepare(sql.trim().replace(/;$/,'')).run();
  const worker=createService({db:d1Database(binding),objects:r2Objects(await mf.getR2Bucket('BUCKET')),adminPassword:password});
  await mkdir(join(dir,'dist'));
  await writeFile(join(dir,'dist','index.html'),'<main>Share reader</main>');
  node=await nodeService({dataDir:dir,password,distDir:join(dir,'dist')});
  const workerClient=await client(worker),nodeClient=await client(node);
  const a=await lifecycle(workerClient);
  const page=await node.fetch(new Request(origin+'/share/'+a.share.id));
  assert.equal(page.status,200);assert.match(page.headers.get('content-type'),/text\/html/);
  assert.match(page.headers.get('cache-control'),/no-store/);assert.equal(await page.text(),'<main>Share reader</main>');
  assert.equal((await node.fetch(new Request(origin+'/share/'+a.share.id,{method:'HEAD'}))).status,200);
  const archive=new Uint8Array(await(await workerClient.admin('backup')).arrayBuffer());
  const imported=await nodeClient.admin('restore','POST',archive);assert.equal(imported.status,200,await imported.clone().text());assert.equal((await nodeClient.send('public/'+a.share.id)).status,200);assert.equal((await(await nodeClient.send('public/'+a.share.id)).json()).document.format,2);assert.equal((await nodeClient.send(`public/${a.share.id}/assets/${a.asset.id}`)).status,200);
  const binding2=await mf.getD1Database('DB2');for(const sql of statements)await binding2.prepare(sql.trim().replace(/;$/,'')).run();
  const worker2=createService({db:d1Database(binding2),objects:r2Objects(await mf.getR2Bucket('BUCKET2')),adminPassword:password});
  const workerClient2=await client(worker2);const reverse=new Uint8Array(await(await nodeClient.admin('backup')).arrayBuffer());
  const job=await(await workerClient2.admin('restore/start','POST')).json(),files=unzipSync(reverse);
  for(const [name,bytes]of Object.entries(files))if(name!=='manifest.json')assert.equal((await workerClient2.admin(`restore/${job.id}/${name}`,'PUT',bytes)).status,200);
  const reverseResult=await workerClient2.admin(`restore/${job.id}/commit`,'POST',JSON.parse(new TextDecoder().decode(files['manifest.json'])));assert.equal(reverseResult.status,200,await reverseResult.clone().text());assert.equal((await workerClient2.send('public/'+a.share.id)).status,200);assert.equal((await workerClient2.send(`public/${a.share.id}/assets/${a.asset.id}`)).status,200);
  // Cancellation is enforced by the actual adapters on the migrated data.
  assert.equal((await nodeClient.send('shares/'+a.share.id,'DELETE',undefined,a.auth)).status,200);assert.equal((await nodeClient.send('public/'+a.share.id)).status,404);
  // A day after revocation, cleanup deletes the record and its R2 objects.
  assert.equal((await workerClient2.send('shares/'+a.share.id,'DELETE',undefined,a.auth)).status,200);
  const {stage_id:stageId}=await binding2.prepare('SELECT stage_id FROM shares WHERE id=?').bind(a.share.id).first();
  await binding2.prepare('UPDATE shares SET updated_at=? WHERE id=?').bind(Date.now()-2*86400000,a.share.id).run();
  await worker2.cleanup();const bucket2=await mf.getR2Bucket('BUCKET2');
  assert.equal(await binding2.prepare('SELECT id FROM shares WHERE id=?').bind(a.share.id).first(),null);
  assert.equal(await bucket2.get(`documents/${stageId}`),null);assert.equal(await bucket2.get(`assets/${a.asset.id}`),null);
  const secondDir=await mkdtemp(join(tmpdir(),'idea-share-node-'));const second=await nodeService({dataDir:secondDir,password,distDir:join(secondDir,'dist')});
  t.after(async()=>{second.close();await rm(secondDir,{recursive:true,force:true});});
  await lifecycle(await client(second));
});
