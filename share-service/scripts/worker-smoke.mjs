import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const script=await readFile(process.argv[2] || new URL('../.wrangler/test-worker/worker.js',import.meta.url),'utf8');
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-10-21',d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{ADMIN_PASSWORD:'bundled-worker-admin-password'}}));
try{
 const db=await mf.getD1Database('DB'),triggers=[];
 const sql=(await readFile(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8')).replace(/CREATE TRIGGER[\s\S]*?END;/g,trigger=>{triggers.push(trigger);return '';});
 for(const statement of [...sql.split(';').map(s=>s.trim()).filter(Boolean),...triggers])await db.prepare(statement.replace(/;$/,'')).run();
 const call=(path,method='GET',data,headers={})=>mf.dispatchFetch('http://share.test/api/v1/'+path,{method,headers:{Origin:'http://share.test',...headers},body:data===undefined?undefined:data instanceof Uint8Array?data:JSON.stringify(data)});
 const login=await call('admin/login','POST',{password:'bundled-worker-admin-password'});assert.equal(login.status,200,await login.clone().text());
 const cookie=login.headers.get('set-cookie').split(';')[0],admin={Cookie:cookie,'X-Share-CSRF':'1'};
 const keyResponse=await call('admin/publishers','POST',{name:'Bundle test'},admin);assert.equal(keyResponse.status,201);const {key}=await keyResponse.json();
 const auth={Authorization:'Bearer '+key},stage=await(await call('uploads','POST',{},auth)).json();
 const resource=await(await call(`uploads/${stage.id}/assets`,'POST',new Uint8Array([1,2,3]),{...auth,'Content-Type':'image/png','X-File-Name':'bundle.png'})).json();
 const response=await call(`uploads/${stage.id}/commit`,'POST',{format:1,title:'Bundled worker',markdown:'# Worker',assets:[resource.id],appearance:{},inputs:{},results:[],expiresAt:null},auth);assert.equal(response.status,200,await response.clone().text());const share=await response.json();
 assert.equal((await call('public/'+share.id)).status,200);assert.equal((await call(`public/${share.id}/assets/${resource.id}`)).status,200);
 const archive=await call('admin/backup','GET',undefined,admin);assert.equal(archive.status,200);assert.ok((await archive.arrayBuffer()).byteLength>100);
 assert.equal((await call('shares/'+share.id,'DELETE',undefined,auth)).status,200);assert.equal((await call('public/'+share.id)).status,404);assert.equal((await call(`public/${share.id}/assets/${resource.id}`)).status,404);
 console.log('PASS: production Worker bundle: login, key issuance, R2 upload, publication, reading, streamed backup and revocation');
}finally{await mf.dispose();}
