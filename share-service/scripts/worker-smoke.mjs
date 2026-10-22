import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fakeB2} from '../tests/helpers/b2.mjs';
const script=await readFile(process.argv[2] || new URL('../.wrangler/test-worker/worker.js',import.meta.url),'utf8');
const backend=fakeB2();
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-10-21',d1Databases:['DB'],bindings:{ADMIN_PASSWORD:'bundled-worker-admin-password',...backend.config},outboundService:async request=>backend.fetch(new Request(request.url,{method:request.method,headers:request.headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer()}))}));
try{
 const db=await mf.getD1Database('DB'),triggers=[];
 const sql=(await Promise.all(['0001_initial.sql','0002_share_kind.sql'].map(file=>readFile(new URL('../migrations/'+file,import.meta.url),'utf8')))).join('\n').replace(/CREATE TRIGGER[\s\S]*?END;/g,trigger=>{triggers.push(trigger);return '';});
 for(const statement of [...sql.split(';').map(s=>s.trim()).filter(Boolean),...triggers])await db.prepare(statement.replace(/;$/,'')).run();
 const call=(path,method='GET',data,headers={})=>mf.dispatchFetch('http://share.test/api/v1/'+path,{method,headers:{Origin:'http://share.test',...headers},body:data===undefined?undefined:data instanceof Uint8Array?data:JSON.stringify(data)});
 const login=await call('admin/login','POST',{password:'bundled-worker-admin-password'});assert.equal(login.status,200,await login.clone().text());
 const cookie=login.headers.get('set-cookie').split(';')[0],admin={Cookie:cookie,'X-Share-CSRF':'1'};
 const keyResponse=await call('admin/publishers','POST',{name:'Bundle test'},admin);assert.equal(keyResponse.status,201);const {key}=await keyResponse.json();
 const auth={Authorization:'Bearer '+key},stage=await(await call('uploads','POST',{},auth)).json();
 const upload=await call(`uploads/${stage.id}/assets`,'POST',new Uint8Array([1,2,3]),{...auth,'Content-Type':'image/png','X-File-Name':'bundle.png'});assert.equal(upload.status,201,await upload.clone().text());const resource=await upload.json();
 const response=await call(`uploads/${stage.id}/commit`,'POST',{format:1,title:'Bundled worker',markdown:'# Worker',assets:[resource.id],appearance:{},inputs:{},results:[],expiresAt:null},auth);assert.equal(response.status,200,await response.clone().text());const share=await response.json();
 assert.equal((await call('public/'+share.id)).status,200);assert.equal((await call(`public/${share.id}/assets/${resource.id}`)).status,200);
 const archive=await call('admin/backup','GET',undefined,admin);assert.equal(archive.status,200);assert.ok((await archive.arrayBuffer()).byteLength>100);
 const snapshot=await call('admin/backup/manifest','GET',undefined,admin);assert.equal(snapshot.status,200);const backup=await snapshot.json();assert.equal(backup.objects.length,2);
 for(const object of backup.objects){const response=await call('admin/backup/objects/'+object.storageKey,'GET',undefined,admin);assert.equal(response.status,200);assert.ok((await response.arrayBuffer()).byteLength>0);}
 assert.equal((await call('shares/'+share.id,'DELETE',undefined,auth)).status,200);assert.equal((await call('public/'+share.id)).status,404);assert.equal((await call(`public/${share.id}/assets/${resource.id}`)).status,404);
 assert.ok(backend.requests.some(request=>request.operation==='b2_upload_file'));
 console.log('PASS: production Worker bundle: login, key issuance, private B2 upload, reading, streamed/incremental backup and revocation');
}finally{await mf.dispose();}
