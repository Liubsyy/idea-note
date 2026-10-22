import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { sqliteDatabase, d1Database } from '../server/storage.mjs';
import { createService } from '../server/service.mjs';
const origin='https://share.test', password='test-admin-password-very-long';
const sample=(assets=[])=>({format:1,title:'Example',markdown:'# Hello\n\nWorld',expiresAt:null,assets,appearance:{},inputs:{},results:[]});
async function fixture(adapter='sqlite') {
  const sqlite=new DatabaseSync(':memory:');for(const file of ['0001_initial.sql','0002_share_kind.sql'])sqlite.exec(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const raw=sqliteDatabase(sqlite), map=new Map();
  const objects={put:async(k,b)=>map.set(k,{bytes:new Uint8Array(b),uploaded:Date.now()}),get:async k=>map.get(k)?.bytes||null,delete:async k=>map.delete(k),list:async()=>[...map].map(([key,o])=>({key,uploaded:o.uploaded}))};
  const db=adapter==='d1'?d1Database({prepare(sql){return{bind(...args){return {first:()=>raw.get(sql,args),all:async()=>({results:await raw.all(sql,args)}),run:async()=>({meta:await raw.run(sql,args)}),sql,args};}};},batch:async statements=>statements.every(s=>s.sql.startsWith('SELECT')) ? Promise.all(statements.map(async s=>({results:await raw.all(s.sql,s.args)}))) : (await raw.batch(statements.map(s=>[s.sql,s.args]))).map(meta=>({meta}))}):raw;
  const service=createService({db,objects,adminPassword:password});
  const request=(path,method='GET',data,headers={})=>service.fetch(new Request(origin+'/api/v1/'+path,{method,headers:{Origin:origin,...(data && !(data instanceof Uint8Array)?{'Content-Type':'application/json'}:{}),...headers},body:data===undefined?undefined:data instanceof Uint8Array?data:JSON.stringify(data)}));
  const login=await request('admin/login','POST',{password});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const admin=(path,method='GET',data)=>request('admin/'+path,method,data,{Cookie:cookie,'X-Share-CSRF':'1'});
  const create=async(name='Publisher')=>{const result=await admin('publishers','POST',{name});assert.equal(result.status,201);return result.json();};
  const publish=async(key,old,doc=sample())=>{
    const auth={Authorization:'Bearer '+key};
    const stageResponse=await request('uploads','POST',{shareId:old?.id,version:old?.version},auth);assert.equal(stageResponse.status,201);const stage=await stageResponse.json();
    const result=await request(`uploads/${stage.id}/commit`,'POST',doc,auth);return {result,stage};
  };
  return{sqlite,db:raw,map,objects,service,request,admin,create,publish,cookie};
}
for(const adapter of ['sqlite','d1'])test(`${adapter}: publish, anonymous read, update same link, revoke document and assets`,async()=>{
  const f=await fixture(adapter), p=await f.create(),auth={Authorization:'Bearer '+p.key};
  const stage=await (await f.request('uploads','POST',{},auth)).json();
  const assetResponse=await f.request(`uploads/${stage.id}/assets`,'POST',new Uint8Array([1,2,3]),{...auth,'Content-Type':'image/png','X-File-Name':encodeURIComponent('图片.png')});assert.equal(assetResponse.status,201);const asset=await assetResponse.json();
  const published=await f.request(`uploads/${stage.id}/commit`,'POST',sample([asset.id]),auth);assert.equal(published.status,200);const first=await published.json();
  assert.equal((await f.request('public/'+first.id)).status,200);assert.equal((await f.request(`public/${first.id}/assets/${asset.id}`)).status,200);
  // Readers never learn the publisher; the publisher and the admin still do.
  assert.equal(Object.hasOwn(await(await f.request('public/'+first.id)).json(),'owner'),false);assert.equal(first.owner,p.id);
  assert.equal((await(await f.admin('shares')).json())[0].owner,p.id);assert.equal(first.kind,'note');assert.equal((await(await f.admin('shares')).json())[0].kind,'note');
  const {result}=await f.publish(p.key,first,{...sample(),markdown:'# Updated'});assert.equal(result.status,200);const updated=await result.json();assert.equal(updated.id,first.id);assert.equal(updated.version,2);
  assert.equal((await f.request(`public/${first.id}/assets/${asset.id}`)).status,404);
  assert.equal((await (await f.request('public/'+first.id)).json()).document.markdown,'# Updated');
  assert.equal((await f.request('shares/'+first.id,'DELETE',undefined,auth)).status,200);const gone=await f.request('public/'+first.id);assert.equal(gone.status,404);assert.match(gone.headers.get('cache-control'),/no-store/);
  f.sqlite.close();
});
test('ownership, disabled keys, reset preserves owner and existing public links',async()=>{
  const f=await fixture(),p=await f.create(),other=await f.create('Other');const {result}=await f.publish(p.key);const s=await result.json();
  assert.equal((await f.request('me')).status,401);assert.equal((await f.request('shares/'+s.id,'DELETE',undefined,{Authorization:'Bearer '+other.key})).status,404);
  let rows=await (await f.admin('publishers')).json();const own=rows.find(r=>r.id===p.id);
  assert.equal((await f.admin('publishers/'+p.id,'PUT',{...own,enabled:false})).status,200);
  assert.equal((await f.request('me','GET',undefined,{Authorization:'Bearer '+p.key})).status,401);assert.equal((await f.request('public/'+s.id)).status,200);
  await f.admin('publishers/'+p.id,'PUT',{...own,enabled:true});const reset=await(await f.admin(`publishers/${p.id}/reset`,'POST')).json();assert.equal((await f.request('shares','GET',undefined,{Authorization:'Bearer '+reset.key})).status,200);assert.equal((await f.request('me','GET',undefined,{Authorization:'Bearer '+p.key})).status,401);
  f.sqlite.close();
});
test('quotas and optimistic concurrency prevent overwrites; failed uploads preserve old content',async()=>{
  const f=await fixture(),p=await f.create(),auth={Authorization:'Bearer '+p.key};const {result}=await f.publish(p.key);const s=await result.json();
  const own=(await(await f.admin('publishers')).json())[0];await f.admin('publishers/'+p.id,'PUT',{...own,maxShares:1,maxBytes:1024*1024});
  const denied=await f.publish(p.key);assert.equal(denied.result.status,409);
  const a=await(await f.request('uploads','POST',{shareId:s.id,version:s.version},auth)).json(),b=await(await f.request('uploads','POST',{shareId:s.id,version:s.version},auth)).json();
  assert.equal((await f.request(`uploads/${a.id}/commit`,'POST',{...sample(),markdown:'winner'},auth)).status,200);
  assert.equal((await f.request(`uploads/${b.id}/commit`,'POST',{...sample(),markdown:'loser'},auth)).status,409);
  assert.equal((await(await f.request('public/'+s.id)).json()).document.markdown,'winner');
  f.sqlite.close();
});
test('expiry, moderation, service switches, session CSRF and login rate limiting',async()=>{
  const f=await fixture(),p=await f.create();const s=await(await f.publish(p.key)).result.json();
  await f.admin('shares/'+s.id,'PUT',{status:'hidden'});assert.equal((await f.request('public/'+s.id)).status,404);
  await f.admin('shares/'+s.id,'PUT',{status:'active'});assert.equal((await f.request('public/'+s.id)).status,200);
  await f.db.run('UPDATE shares SET expires_at=? WHERE id=?',[Date.now()-1,s.id]);assert.equal((await f.request('public/'+s.id)).status,404);
  const settings=(await(await f.admin('overview')).json()).settings;await f.admin('settings','PUT',{...settings,allowCreate:false,allowUpdate:false,allowRead:false});
  assert.equal((await f.request('uploads','POST',{}, {Authorization:'Bearer '+p.key})).status,503);
  assert.equal((await f.request('shares/'+s.id,'DELETE',undefined,{Authorization:'Bearer '+p.key})).status,200);
  assert.equal((await f.request('admin/settings','PUT',settings,{Cookie:f.cookie})).status,403);
  for(let i=0;i<10;i++)await f.request('admin/login','POST',{password:'bad'});
  assert.equal((await f.request('admin/login','POST',{password})).status,429);
  await f.admin('logout','POST');assert.equal((await f.admin('overview')).status,401);
  f.sqlite.close();
});
test('asset manifests, document format, encrypted content and executable attachments',async()=>{
  const f=await fixture(),p=await f.create(),auth={Authorization:'Bearer '+p.key};
  const stage=await(await f.request('uploads','POST',{},auth)).json();
  assert.equal((await f.request(`uploads/${stage.id}/commit`,'POST',sample(['0'.repeat(32)]),auth)).status,400);
  assert.equal((await f.request(`uploads/${stage.id}/commit`,'POST',{...sample(),markdown:'```secret {v=1}\nCIPHER\n```'},auth)).status,400);
  const asset=await(await f.request(`uploads/${stage.id}/assets`,'POST',new TextEncoder().encode('<script>alert(1)</script>'),{...auth,'Content-Type':'text/html','X-File-Name':'evil.html'})).json();
  const share=await(await f.request(`uploads/${stage.id}/commit`,'POST',sample([asset.id]),auth)).json();
  const file=await f.request(`public/${share.id}/assets/${asset.id}`);assert.equal(file.headers.get('content-type'),'application/octet-stream');assert.match(file.headers.get('content-disposition'),/attachment/);
  assert.equal((await f.request('public/../assets/evil')).status,401);
  assert.equal((await f.request('public/invalid')).status,404);
  f.sqlite.close();
});
test('backup moves SQLite to the D1 adapter and back, preserving key and links',async()=>{
  const source=await fixture(),p=await source.create();const s=await(await source.publish(p.key)).result.json();
  const backup=await source.admin('backup');assert.equal(backup.status,200);const bytes=new Uint8Array(await backup.arrayBuffer());
  const target=await fixture('d1');const restored=await target.admin('restore','POST',bytes);assert.equal(restored.status,200,await restored.clone().text());
  assert.equal((await target.request('public/'+s.id)).status,200);assert.equal((await target.request('me','GET',undefined,{Authorization:'Bearer '+p.key})).status,200);
  assert.equal((await target.admin('restore','POST',bytes)).status,409);
  const back=await fixture();const second=new Uint8Array(await(await target.admin('backup')).arrayBuffer());assert.equal((await back.admin('restore','POST',second)).status,200);assert.equal((await back.request('public/'+s.id)).status,200);
  source.sqlite.close();target.sqlite.close();back.sqlite.close();
});
test('cleanup removes old unreferenced resources and administrator-deleted shares',async()=>{
  const f=await fixture(),p=await f.create();const {result,stage}=await f.publish(p.key);const s=await result.json();
  const abandoned=await(await f.request('uploads','POST',{}, {Authorization:'Bearer '+p.key})).json();await f.db.run('UPDATE stages SET created_at=0 WHERE id=?',[abandoned.id]);await f.objects.put(`documents/${abandoned.id}`,new Uint8Array([1]));
  await f.service.cleanup();assert.equal(await f.objects.get(`documents/${abandoned.id}`),null);assert.ok(await f.objects.get(`documents/${stage.id}`));
  await f.admin('shares/'+s.id,'DELETE');await f.db.run('UPDATE stages SET created_at=0 WHERE id=?',[stage.id]);await f.service.cleanup();assert.equal(await f.objects.get(`documents/${stage.id}`),null);f.sqlite.close();
});
for(const adapter of ['sqlite','d1'])test(`${adapter}: cleanup purges shares a day after revocation or expiry; recent and hidden ones remain`,async()=>{
  const f=await fixture(adapter),p=await f.create(),auth={Authorization:'Bearer '+p.key},day=86400000;
  const publishWithAsset=async()=>{
    const stage=await(await f.request('uploads','POST',{},auth)).json();
    const asset=await(await f.request(`uploads/${stage.id}/assets`,'POST',new Uint8Array([1,2,3]),{...auth,'Content-Type':'image/png','X-File-Name':'a.png'})).json();
    const share=await(await f.request(`uploads/${stage.id}/commit`,'POST',sample([asset.id]),auth)).json();
    return{share,stage:stage.id,keys:[`documents/${stage.id}`,`assets/${asset.id}`]};
  };
  const revokedOld=await publishWithAsset(),revokedNew=await publishWithAsset(),expiredOld=await publishWithAsset(),expiredNew=await publishWithAsset(),hidden=await publishWithAsset(),active=await publishWithAsset();
  for(const s of [revokedOld,revokedNew])assert.equal((await f.request('shares/'+s.share.id,'DELETE',undefined,auth)).status,200);
  await f.admin('shares/'+hidden.share.id,'PUT',{status:'hidden'});
  await f.db.run('UPDATE shares SET updated_at=? WHERE id IN (?,?)',[Date.now()-2*day,revokedOld.share.id,hidden.share.id]);
  await f.db.run('UPDATE shares SET expires_at=? WHERE id=?',[Date.now()-2*day,expiredOld.share.id]);
  await f.db.run('UPDATE shares SET expires_at=? WHERE id=?',[Date.now()-3600000,expiredNew.share.id]);
  await f.service.cleanup();
  for(const s of [revokedOld,expiredOld]){
    assert.equal(await f.db.get('SELECT id FROM shares WHERE id=?',[s.share.id]),null);
    assert.equal(await f.db.get('SELECT id FROM stages WHERE id=?',[s.stage]),null);
    assert.equal(await f.db.get('SELECT id FROM assets WHERE stage_id=?',[s.stage]),null);
    for(const key of s.keys)assert.equal(await f.objects.get(key),null,key);
    assert.ok(await f.db.get("SELECT id FROM audit WHERE actor='system' AND action='share.purge' AND target=?",[s.share.id]));
  }
  for(const s of [revokedNew,expiredNew,hidden,active])for(const key of s.keys)assert.ok(await f.objects.get(key),key);
  // Purged shares no longer count against the publisher's quota.
  assert.deepEqual((await(await f.request('shares','GET',undefined,auth)).json()).map(s=>s.id).sort(),[revokedNew,expiredNew,hidden,active].map(s=>s.share.id).sort());
  // Within the grace period an administrator can still restore a revocation,
  // and the publisher can still extend an expired share.
  assert.equal((await f.admin('shares/'+revokedNew.share.id,'PUT',{status:'active'})).status,200);assert.equal((await f.request('public/'+revokedNew.share.id)).status,200);
  const current=await f.db.get('SELECT version FROM shares WHERE id=?',[expiredNew.share.id]);
  assert.equal((await f.publish(p.key,{id:expiredNew.share.id,version:current.version},{...sample(),expiresAt:Date.now()+day})).result.status,200);
  assert.equal((await f.request('public/'+expiredNew.share.id)).status,200);
  f.sqlite.close();
});
test('admin preview page can be framed by the console but loads no external images',async()=>{
  const f=await fixture(),csp=async path=>(await f.service.fetch(new Request(origin+path))).headers.get('content-security-policy');
  const preview=await csp('/admin/preview/'+'a'.repeat(32));
  assert.match(preview,/frame-ancestors 'self'/);assert.match(preview,/img-src 'self' data: blob:;/);assert.match(preview,/script-src 'self';/);
  assert.match(await csp('/admin'),/frame-ancestors 'none'/);
  assert.match(await csp('/share/'+'a'.repeat(32)),/img-src 'self' https: http:/);
  f.sqlite.close();
});

test('chunked restore publishes metadata only after every object arrives and remains exportable',async()=>{
  const {unzipSync}=await import('fflate');
  const source=await fixture(),p=await source.create(),auth={Authorization:'Bearer '+p.key};
  const stage=await(await source.request('uploads','POST',{},auth)).json();
  const asset=await(await source.request(`uploads/${stage.id}/assets`,'POST',new Uint8Array([1,2,3]),{...auth,'X-File-Name':'test.png','Content-Type':'image/png'})).json();
  const share=await(await source.request(`uploads/${stage.id}/commit`,'POST',sample([asset.id]),auth)).json();
  const files=unzipSync(new Uint8Array(await(await source.admin('backup')).arrayBuffer()));
  const target=await fixture(),job=await(await target.admin('restore/start','POST')).json();
  assert.equal((await target.admin('publishers','POST',{name:'Race'})).status,409);
  const manifest=JSON.parse(new TextDecoder().decode(files['manifest.json']));
  assert.equal((await target.admin(`restore/${job.id}/commit`,'POST',manifest)).status,400);
  for(const [name,bytes]of Object.entries(files))if(name!=='manifest.json')assert.equal((await target.admin(`restore/${job.id}/${name}`,'PUT',bytes)).status,200);
  const committed=await target.admin(`restore/${job.id}/commit`,'POST',manifest);assert.equal(committed.status,200,await committed.clone().text());
  assert.equal((await target.request('public/'+share.id)).status,200);assert.equal((await target.request(`public/${share.id}/assets/${asset.id}`)).status,200);
  const second=await fixture(),archive=new Uint8Array(await(await target.admin('backup')).arrayBuffer());assert.equal((await second.admin('restore','POST',archive)).status,200);
  assert.equal((await second.request(`public/${share.id}/assets/${asset.id}`)).status,200);
  source.sqlite.close();target.sqlite.close();second.sqlite.close();
});
test('aborting a restore removes staging objects and allows a fresh restore',async()=>{
  const f=await fixture(),job=await(await f.admin('restore/start','POST')).json();
  assert.equal((await f.admin('restore/start','POST')).status,409);
  assert.equal((await f.admin(`restore/${job.id}/objects/assets/${'a'.repeat(32)}`,'PUT',new Uint8Array([1]))).status,200);
  assert.equal((await f.admin(`restore/${job.id}`,'DELETE')).status,200);
  assert.equal((await f.admin('restore/start','POST')).status,201);assert.equal(f.map.size,0);f.sqlite.close();
});

test('bounded restore abort releases the gate and cleanup reclaims deferred objects',async()=>{
  const f=await fixture(),job=await(await f.admin('restore/start','POST')).json();
  for(const char of ['a','b','c'])assert.equal((await f.admin(`restore/${job.id}/objects/assets/${char.repeat(32)}`,'PUT',new Uint8Array([1]))).status,200);
  const limited=createService({db:f.db,objects:f.objects,adminPassword:password,cleanupObjectLimit:1});
  const response=await limited.fetch(new Request(`${origin}/api/v1/admin/restore/${job.id}`,{method:'DELETE',headers:{Origin:origin,Cookie:f.cookie,'X-Share-CSRF':'1'}}));
  assert.equal(response.status,200);assert.equal(f.map.size,2);
  assert.equal((await f.admin('restore/start','POST')).status,201);
  for(const value of f.map.values())value.uploaded=0;
  await limited.cleanup();assert.equal(f.map.size,1);
  await limited.cleanup();assert.equal(f.map.size,0);f.sqlite.close();
});

for(const adapter of ['sqlite','d1'])test(`${adapter}: folder validation, ownership, type compatibility, quotas and backup`,async()=>{
  const f=await fixture(adapter),p=await f.create(),auth={Authorization:'Bearer '+p.key};
  const stage=await(await f.request('uploads','POST',{},auth)).json();
  const uploaded=await(await f.request(`uploads/${stage.id}/assets`,'POST',new Uint8Array([1,2,3]),{...auth,'Content-Type':'image/png','X-File-Name':'pic.png'})).json();
  const note={markdown:'# Readme',inputs:{},results:[]};
  const doc={format:2,title:'Folder',assets:[uploaded.id],expiresAt:null,appearance:{},entries:[{kind:'directory',path:'empty'},{kind:'directory',path:'sub'},{kind:'markdown',path:'README.md',content:note},{kind:'markdown',path:'sub/笔记.md',content:note},{kind:'file',path:'pic.png',asset:uploaded.url,mime:'image/png',size:3}]};
  const commit=value=>f.request(`uploads/${stage.id}/commit`,'POST',value,auth);
  for(const path of ['../escape.md','/absolute','a//b','a/./b','a/../b','C:\\private','a\u0000b'])assert.equal((await commit({...doc,entries:[{kind:'directory',path}]})).status,400,path);
  assert.equal((await commit({...doc,entries:[doc.entries[0],doc.entries[0]]})).status,400);
  assert.equal((await commit({...doc,entries:[doc.entries[3]]})).status,400);
  assert.equal((await commit({...doc,entries:[{kind:'file',path:'pic.png',asset:'/api/v1/public/'+ 'f'.repeat(32)+'/assets/'+uploaded.id,mime:'image/png',size:3}]})).status,400);
  assert.equal((await commit({...doc,entries:[{...doc.entries[4],size:4}]})).status,400);
  assert.equal((await commit({...doc,entries:[{kind:'markdown',path:'private.md',content:{...note,markdown:'```secret\nCIPHER\n```'}}]})).status,400);
  const result=await commit(doc);assert.equal(result.status,200,await result.clone().text());const share=await result.json();
  assert.equal(share.kind,'folder');assert.equal((await(await f.request('shares','GET',undefined,auth)).json())[0].id,share.id);
  const other=await f.create('Other');assert.equal((await f.request(`shares/${share.id}/document`,'GET',undefined,{Authorization:'Bearer '+other.key})).status,404);
  assert.equal((await(await f.request(`shares/${share.id}/document`,'GET',undefined,auth)).json()).document.format,2);
  const mismatch=await f.publish(p.key,share,sample());assert.equal(mismatch.result.status,409);
  const badVersion=await f.request('uploads','POST',{shareId:share.id,version:0},auth);assert.equal(badVersion.status,409);
  const target=await fixture(adapter==='sqlite'?'d1':'sqlite');
  assert.equal((await target.admin('restore','POST',new Uint8Array(await(await f.admin('backup')).arrayBuffer()))).status,200);
  const restored=(await(await target.request('public/'+share.id)).json()).document;assert.deepEqual(restored,doc);
  // Backups carry no kind; the admin list fills it in from the document once.
  assert.equal((await target.db.get('SELECT kind FROM shares WHERE id=?',[share.id])).kind,null);
  assert.equal((await(await target.admin('shares')).json())[0].kind,'folder');assert.equal((await target.db.get('SELECT kind FROM shares WHERE id=?',[share.id])).kind,'folder');
  assert.equal((await target.request(`public/${share.id}/assets/${uploaded.id}`)).status,200);
  const settings=(await(await f.admin('overview')).json()).settings;await f.admin('settings','PUT',{...settings,maxAssetBytes:1,maxShareBytes:1});
  const limited=await f.publish(p.key,share,{...doc,assets:[],entries:[]});assert.equal(limited.result.status,413);
  assert.deepEqual((await(await f.request('public/'+share.id)).json()).document,doc);
  await f.admin(`shares/${share.id}`,'PUT',{status:'hidden'});assert.equal((await f.request('public/'+share.id)).status,404);assert.equal((await f.request(`public/${share.id}/assets/${uploaded.id}`)).status,404);
  await f.admin(`shares/${share.id}`,'PUT',{status:'active'});await f.db.run('UPDATE shares SET expires_at=? WHERE id=?',[Date.now()-1,share.id]);assert.equal((await f.request('public/'+share.id)).status,404);
  target.sqlite.close();f.sqlite.close();
});
