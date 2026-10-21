import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { DatabaseSync } from 'node:sqlite';
import { Text } from '@codemirror/state';
import { createService } from '../share-service/server/service.mjs';
import { sqliteDatabase } from '../share-service/server/storage.mjs';
import * as folder from '../share-service/renderer/folder.ts';
import * as snapshot from '../share-service/renderer/snapshot.ts';
import * as fence from '../share-service/renderer/lib/codeRun/fenceAttrs.ts';
import * as sharedSources from '../share-service/renderer/lib/inputs/sources.ts';

// Values built inside the vm context carry its prototypes; compare them as plain data.
const plain=value=>JSON.parse(JSON.stringify(value));
const fs={dirname:p=>p.slice(0,p.lastIndexOf('/')),basename:p=>p.slice(p.lastIndexOf('/')+1)};
function load(path,dependencies,globals={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>{assert.ok(dependencies[name],name);return dependencies[name];},...globals});
  return exports;
}
// The desktop resolvePath/isInside, so path checks run against the real rules.
const sources=load('../src/lib/inputs/sources.ts',{'../../../share-service/renderer/lib/inputs/sources.ts':sharedSources,'../../i18n/core.ts':{tr:s=>s},'../fs':{...fs,readFile:async()=>''}});
// `links` maps symlink paths to their targets, like the native canonicalize.
function loadClient({app,runs={records:[]},files,links=new Map(),config,service,scan}) {
  const invoke=async(command,args)=>{
    if(command==='share_folder_scan')return structuredClone(typeof scan==='function'?scan(args):scan);
    if(command==='share_association_set'){config.associations[args.path]={id:args.id,service:args.service,kind:args.kind};return;}
    if(command==='share_config_load')return JSON.stringify(config);
    if(command==='share_resource_stat'){const path=links.get(args.path)??args.path;assert.ok(files.has(path),'must exist');return{size:files.get(path).length,path,root:links.get(args.root)??args.root};}
    if(command==='share_resource_read'){assert.ok(!links.has(args.path),'reads only reviewed real paths');return Array.from(files.get(args.path));}
    throw new Error('Unexpected native command '+command);
  };
  return load('../src/lib/share/client.ts',{
    '../../i18n/core':{tr:(text,args)=>text.replace(/\{\{(\w+)\}\}/g,(_,key)=>args?.[key]??'')},'@tauri-apps/api/core':{invoke},'@tauri-apps/api/event':{emit:async()=>{},listen:async()=>()=>{}},
    '../ai/http':{fetch:(url,init)=>service.fetch(new Request(url,init))},'../fs':fs,
    '../../store/useAppStore':{useAppStore:{getState:()=>app},editorFontStack:()=>'-apple-system,sans-serif'},
    '../../store/useRunStore':{useRunStore:{getState:()=>runs}},'../../store/useInputStore':{useInputStore:{getState:()=>({values:{}})}},
    '../inputs/sources':sources,'@codemirror/state':{Text},'../codeRun/fenceAttrs':fence,'../../../share-service/renderer/snapshot':snapshot,'../../../share-service/renderer/folder':folder,
  },{URL,Request,TextEncoder,Uint8Array,structuredClone,Map,Set,Date,document:{documentElement:{classList:{contains:()=>false}}},getComputedStyle:()=>({getPropertyValue:()=>''})});
}
async function shareService() {
  const sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../share-service/migrations/0001_initial.sql',import.meta.url),'utf8'));
  const objects=new Map(),service=createService({db:sqliteDatabase(sqlite),adminPassword:'desktop-integration-password',objects:{put:async(k,b)=>objects.set(k,new Uint8Array(b)),get:async k=>objects.get(k)||null,delete:async k=>objects.delete(k),list:async()=>[]}});
  const send=(path,method='GET',data,headers={})=>service.fetch(new Request('https://share.test/api/v1/'+path,{method,headers:{Origin:'https://share.test',...headers},body:data===undefined?undefined:JSON.stringify(data)}));
  const login=await send('admin/login','POST',{password:'desktop-integration-password'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const owner=await(await send('admin/publishers','POST',{name:'Desktop'},{Cookie:cookie,'X-Share-CSRF':'1'})).json();
  return {sqlite,service,send,config:{url:'https://share.test',key:owner.key,associations:{}}};
}

test('desktop publication redacts secrets, uploads native attachments, updates and cancels through the real service',async()=>{
  const {sqlite,service,send,config}=await shareService();
  const content='# Note\n\n![picture](assets/test.png)\n\n```secret {v=1,key=k1,id=b1}\nCIPHER\n```\n\n```node\nconsole.log(42)\n```';
  const app={activeFilePath:'/notes/note.md',workspacePath:'/notes',content,editorFontFamily:''},runs={records:[{filePath:'/notes/note.md',status:'done',exitCode:0,code:'console.log(42)',info:'node',componentResult:{type:'json',data:{answer:42}},inputs:{privateMetadata:'not included'},inputSummary:'',ms:1},{filePath:'/notes/other.md',status:'done',exitCode:0,code:'console.log(42)',info:'node',componentResult:{type:'text',data:'OTHER NOTE'},ms:1}]};
  const files=new Map([['/notes/assets/test.png',new Uint8Array([137,80,78,71])]]);
  const exports=loadClient({app,runs,files,config,service});
  const prepared=await exports.prepareShare(app.activeFilePath,content,'Desktop test',0);
  assert.ok(!JSON.stringify(prepared.document).includes('CIPHER'));assert.ok(!JSON.stringify(prepared.document).includes('/notes/'));assert.ok(!JSON.stringify(prepared.document).includes('privateMetadata'));assert.equal(prepared.document.results.length,1);assert.equal(prepared.files.length,1);
  assert.deepEqual(plain(prepared.files[0].warnings),[]);
  const first=await exports.publishShare(prepared);assert.equal(first.version,1);
  const publicDoc=await(await send('public/'+first.id)).json();assert.ok(publicDoc.document.markdown.includes('/api/v1/public/'+first.id+'/assets/'));assert.equal(publicDoc.document.assets.length,1);assert.equal((await service.fetch(new Request('https://share.test'+publicDoc.document.markdown.match(/\]\((\/api[^)]+)\)/)[1]))).status,200);
  const changed=await exports.prepareShare(app.activeFilePath,'# Updated','Desktop test',0);
  const updated=await exports.publishShare(changed,first);assert.equal(updated.id,first.id);assert.equal(updated.version,2);
  await exports.revokeShare(first.id);assert.equal((await send('public/'+first.id)).status,404);
  await assert.rejects(()=>exports.prepareShare(app.activeFilePath,'![missing](none.png)','Broken',0));
  sqlite.close();
});

test('attachment warnings flag paths outside the workspace and hidden files or folders',()=>{
  const {attachmentWarnings}=loadClient({app:{},files:new Map()});
  assert.deepEqual(plain(attachmentWarnings('/notes','/notes/assets/a.png')),[]);
  assert.deepEqual(plain(attachmentWarnings('/notes/','/notes/assets/a.png')),[]);
  assert.deepEqual(plain(attachmentWarnings('/notes','/notes-archive/a.png')),['outside']);
  assert.deepEqual(plain(attachmentWarnings('/notes','/Users/me/.ssh/id_rsa')),['outside','hidden']);
  assert.deepEqual(plain(attachmentWarnings('/notes','/notes/.env')),['hidden']);
  assert.deepEqual(plain(attachmentWarnings('/notes','/notes/.git/config')),['hidden']);
  assert.deepEqual(plain(attachmentWarnings('/notes','/notes/assets/.private/a.png')),['hidden']);
  // Only the part below the workspace counts: a workspace inside a dot folder is not itself hidden.
  assert.deepEqual(plain(attachmentWarnings('/Users/me/.notes','/Users/me/.notes/a.png')),[]);
  assert.deepEqual(plain(attachmentWarnings('C:\\Notes','C:/Notes/img/a.png')),[]);
  assert.deepEqual(plain(attachmentWarnings('C:\\Notes','C:/Users/me/.aws/credentials')),['outside','hidden']);
});

test('preparation resolves ../, absolute and encoded references, skips unused definitions and comments, and publishing needs approval',async()=>{
  const {sqlite,service,send,config}=await shareService();
  const note='/work/notes/sub/note.md';
  const content=['# Shared','![ok](../assets/ok.png)','![up](../../secret.png)','![abs](/Users/me/.ssh/id_rsa)','[env](../.env)','![encoded](..%2F..%2F..%2Fescaped.png)','','[orphan]: ../../../.aws/credentials','','<!-- ![hidden](../assets/comment.png) private reviewer note -->'].join('\n');
  const bytes=new Uint8Array([1,2,3]),files=new Map(['/work/notes/assets/ok.png','/work/secret.png','/Users/me/.ssh/id_rsa','/work/notes/.env','/escaped.png','/Users/me/.aws/credentials','/work/notes/assets/comment.png'].map(p=>[p,bytes]));
  const app={activeFilePath:note,workspacePath:'/work/notes',content,editorFontFamily:''};
  const exports=loadClient({app,files,config,service});
  const prepared=await exports.prepareShare(note,content,'Paths',0);
  assert.deepEqual(plain(Object.fromEntries(prepared.files.map(f=>[f.path,f.warnings]))),{
    '/work/notes/assets/ok.png':[],'/work/secret.png':['outside'],'/Users/me/.ssh/id_rsa':['outside','hidden'],'/work/notes/.env':['hidden'],'/escaped.png':['outside'],
  });
  assert.equal(prepared.removedComments,1);assert.ok(!prepared.document.markdown.includes('private reviewer note'));
  await assert.rejects(()=>exports.publishShare(prepared),/\/work\/secret\.png/);
  await assert.rejects(()=>exports.publishShare(prepared,undefined,new Set(['/work/secret.png','/Users/me/.ssh/id_rsa','/work/notes/.env'])),/\/escaped\.png/);
  const published=await exports.publishShare(prepared,undefined,new Set(prepared.files.filter(f=>f.warnings.length).map(f=>f.path)));
  const publicDoc=await(await send('public/'+published.id)).json();assert.equal(publicDoc.document.assets.length,5);
  // Without a workspace the note's own folder is the boundary.
  const loose=loadClient({app:{...app,workspacePath:null},files,config,service});
  assert.deepEqual(plain((await loose.prepareShare(note,'![a](../assets/ok.png)','Loose',0)).files.map(f=>f.warnings)),[['outside']]);
  sqlite.close();
});

test('symlinks are checked by the file they point to, and linked workspaces are not flagged',async()=>{
  const {sqlite,service,send,config}=await shareService();
  const note='/work/notes/note.md',content='![a](img.png)\n\n![b](assets/b.png)';
  const files=new Map([['/Users/me/.ssh/id_rsa',new Uint8Array([7])],['/Volumes/data/notes/assets/b.png',new Uint8Array([8])]]);
  const links=new Map([['/work/notes/img.png','/Users/me/.ssh/id_rsa'],['/work/notes/assets/b.png','/Volumes/data/notes/assets/b.png'],['/work/notes','/Volumes/data/notes']]);
  const app={activeFilePath:note,workspacePath:'/work/notes',content,editorFontFamily:''};
  const exports=loadClient({app,files,links,config,service});
  const prepared=await exports.prepareShare(note,content,'Links',0);
  assert.deepEqual(plain(prepared.files.map(f=>({path:f.path,linked:f.linked,name:f.name,warnings:f.warnings}))),[
    {path:'/Users/me/.ssh/id_rsa',linked:'/work/notes/img.png',name:'id_rsa',warnings:['outside','hidden']},
    {path:'/Volumes/data/notes/assets/b.png',linked:'/work/notes/assets/b.png',name:'b.png',warnings:[]},
  ]);
  await assert.rejects(()=>exports.publishShare(prepared),/\/Users\/me\/\.ssh\/id_rsa/);
  const published=await exports.publishShare(prepared,undefined,new Set(['/Users/me/.ssh/id_rsa']));
  assert.equal((await(await send('public/'+published.id)).json()).document.assets.length,2);
  sqlite.close();
});

const nativeFile=(relative,text,extra={})=>({kind:'file',relative,path:'/notes/'+relative,real:'/notes/'+relative,warnings:[],bytes:[...new TextEncoder().encode(text)],text:/\.(md|markdown)$/i.test(relative)?text:null,...extra});
const nativeDir=relative=>({kind:'directory',relative,path:'/notes/'+relative,real:'/notes/'+relative,warnings:[]});
test('folder snapshots publish nested notes, deduplicate attachments, rewrite scoped links and keep raw Markdown private',async()=>{
  const {sqlite,service,send,config}=await shareService();
  const secret='```secret {v=1,key=k1,id=b1}\nPRIVATE_CIPHER\n```';
  const entries=[nativeDir('assets'),nativeFile('assets/图 1.png','PNG'),nativeDir('empty'),nativeDir('sub'),nativeFile('sub/readme.md','[home](../README.md#intro)\n![picture](../assets/图%201.png)\n[excluded](../.env)'),nativeFile('sub/same.txt','second'),nativeFile('README.md','# On disk'),nativeFile('same.txt','first'),nativeFile('alias.png','PNG',{real:'/notes/assets/图 1.png'})];
  const scan={entries,excluded:[{path:'.env',reason:'hidden'}]},files=new Map(entries.filter(e=>e.bytes).map(e=>[e.real,new Uint8Array(e.bytes)]));
  const app={activeFilePath:'/notes/README.md',workspacePath:'/notes',editorFontFamily:'',content:'# Current buffer\n\n[other](sub/readme.md)\n[download](same.txt)\n<!-- PRIVATE_COMMENT -->\n'+secret};
  const client=loadClient({app,files,config,service,scan});
  const prepared=await client.prepareFolderShare('/notes','Folder',0,{includeHidden:false,includeSymlinks:false});
  assert.equal(prepared.document.format,2);assert.equal(prepared.document.entries.length,entries.length);
  assert.ok(prepared.document.entries.find(e=>e.path==='README.md').content.markdown.includes('Current buffer'));
  assert.doesNotMatch(JSON.stringify(prepared.document),/PRIVATE_CIPHER|PRIVATE_COMMENT|\/notes\//);
  assert.ok(prepared.files.every(file=>!file.source.endsWith('.md')));
  const share=await client.publishShare(prepared);assert.equal(share.kind,'folder');
  const result=await(await send('public/'+share.id)).json(),doc=result.document;
  assert.equal(doc.assets.length,3); // one image, two distinct same.txt files
  const nested=doc.entries.find(e=>e.path==='sub/readme.md').content.markdown;
  assert.ok(nested.includes(`/share/${share.id}?file=README.md#intro`));
  assert.ok(nested.includes(doc.entries.find(e=>e.path==='assets/图 1.png').asset));
  assert.ok(nested.includes(`?file=.env`));
  assert.equal(doc.entries.find(e=>e.path==='alias.png').asset,doc.entries.find(e=>e.path==='assets/图 1.png').asset);
  assert.notEqual(doc.entries.find(e=>e.path==='same.txt').asset,doc.entries.find(e=>e.path==='sub/same.txt').asset);
  await client.setAssociation('/notes',share.id,config.url,'folder');assert.equal(config.associations['/notes'].kind,'folder');assert.equal((await client.listShares())[0].kind,'folder');
  await assert.rejects(()=>client.setAssociation('/notes/note.md',share.id,config.url,'note'),/类型/);
  assert.equal((await send(`public/${share.id}/assets/${doc.assets[0]}`)).status,200);
  await client.revokeShare(share.id);assert.equal((await send('public/'+share.id)).status,404);
  assert.equal((await send(`public/${share.id}/assets/${doc.assets[0]}`)).status,404);
  sqlite.close();
});

test('folder publication requires sensitive Markdown approval and refuses changed files, additions or active buffers',async()=>{
  const {sqlite,service,config}=await shareService();
  let scan={entries:[nativeFile('.private.md','# private',{warnings:['hidden']}),nativeFile('README.md','# Readme'),nativeFile('a.txt','old')],excluded:[]};
  const files=new Map(scan.entries.map(e=>[e.real,new Uint8Array(e.bytes)]));
  const app={activeFilePath:'/notes/README.md',workspacePath:'/notes',editorFontFamily:'',content:'# Buffer'};
  const client=loadClient({app,files,config,service,scan:()=>scan});
  const prepare=()=>client.prepareFolderShare('/notes','Folder',0,{includeHidden:true,includeSymlinks:false});
  const prepared=await prepare();
  await assert.rejects(()=>client.publishShare(prepared),/\.private.md/);
  const approved=new Set(['/notes/.private.md']);
  scan.entries[2].bytes=[1,2,3];
  await assert.rejects(()=>client.publishShare(prepared,undefined,approved),/重新预览/);
  scan.entries[2]=nativeFile('a.txt','old');scan.entries.push(nativeFile('added.txt','new'));
  await assert.rejects(()=>client.publishShare(prepared,undefined,approved),/重新预览/);
  scan.entries.pop();app.content='# Changed';
  await assert.rejects(()=>client.publishShare(prepared,undefined,approved),/重新预览/);
  app.content='# Buffer';
  const first=await client.publishShare(prepared,undefined,approved);
  scan.entries=scan.entries.filter(entry=>entry.relative!=='a.txt');
  const updated=await client.publishShare(await prepare(),first,approved);
  assert.equal(updated.id,first.id);assert.equal(updated.version,2);
  const doc=(await(await service.fetch(new Request(config.url+'/api/v1/public/'+first.id))).json()).document;
  assert.ok(!doc.entries.some(entry=>entry.path==='a.txt'));
  sqlite.close();
});

test('folder resources outside the selected root require review, stay frozen, and respect limits',async()=>{
  const {sqlite,service,config}=await shareService();
  const scan={entries:[nativeFile('README.md','![external](../external.png)')],excluded:[]};
  const files=new Map([['/external.png',new Uint8Array([1,2,3])]]);
  const app={activeFilePath:null,workspacePath:'/notes',editorFontFamily:'',content:''};
  const client=loadClient({app,files,config,service,scan});
  const prepared=await client.prepareFolderShare('/notes','Folder',0,{includeHidden:false,includeSymlinks:false});
  assert.deepEqual(plain(prepared.files[0].warnings),['outside']);
  await assert.rejects(()=>client.publishShare(prepared),/external.png/);
  files.set('/external.png',new Uint8Array([4,5,6]));
  await assert.rejects(()=>client.publishShare(prepared,undefined,new Set(['/external.png'])),/重新预览/);
  files.set('/external.png',new Uint8Array([1,2,3]));
  const share=await client.publishShare(prepared,undefined,new Set(['/external.png']));
  const doc=(await(await service.fetch(new Request(config.url+'/api/v1/public/'+share.id))).json()).document;
  assert.match(doc.entries[0].content.markdown,/\/api\/v1\/public\//);
  sqlite.prepare('INSERT OR REPLACE INTO settings(id,json) VALUES(1,?)').run(JSON.stringify({maxAssetBytes:2}));
  await assert.rejects(()=>client.prepareFolderShare('/notes','Too large',0,{includeHidden:false,includeSymlinks:false}),/单附件/);
  const emptyClient=loadClient({app,files,config,service,scan:{entries:[],excluded:[]}});
  const empty=await emptyClient.prepareFolderShare('/notes','Empty',0,{includeHidden:false,includeSymlinks:false});
  assert.equal(empty.document.entries.length,0);
  assert.equal((await emptyClient.publishShare(empty)).kind,'folder');
  sqlite.close();
});

test('sharing parses response text without WebKit Response.json and reports non-JSON and network failures clearly',async()=>{
  const config={url:'http://localhost:8787',key:'inshare_test',associations:{}};
  const make=fetch=>loadClient({app:{},files:new Map(),config,service:{fetch}});
  const browserJson=make(async()=>({ok:true,status:200,text:async()=>'[]',json:async()=>{throw new SyntaxError('The string did not match the expected pattern.');}}));
  assert.deepEqual(plain(await browserJson.listShares()),[]);
  for(const status of [200,404,502]){
    const html=make(async()=>new Response('<html>private proxy details</html>',{status,headers:{'Content-Type':'text/html'}}));
    await assert.rejects(()=>html.listShares(),error=>{
      assert.match(error.message,/非 JSON/);assert.ok(error.message.includes(String(status)));assert.doesNotMatch(error.message,/private proxy details|SyntaxError/);return true;
    });
  }
  const offline=make(async()=>{throw new SyntaxError('The string did not match the expected pattern.');});
  await assert.rejects(()=>offline.listShares(),error=>{assert.match(error.message,/无法连接分享服务/);assert.ok(error.message.includes(config.url));assert.doesNotMatch(error.message,/inshare_test|SyntaxError/);return true;});
  const interrupted=make(async()=>({status:200,ok:true,text:async()=>{throw new TypeError('stream failed');}}));
  await assert.rejects(()=>interrupted.listShares(),/读取分享服务响应失败/);
  const denied=make(async()=>new Response(JSON.stringify({error:'Invalid publishing key'}),{status:401}));
  await assert.rejects(()=>denied.listShares(),/Invalid publishing key/);
});

test('sharing rejects malformed service settings and unexpected list responses before enabling publication',async()=>{
  let requests=0;
  const config={url:'http://localhost:8787',key:'inshare_test',associations:{}};
  const client=loadClient({app:{},files:new Map(),config,service:{fetch:async()=>{requests++;return new Response('[]');}}});
  for(const url of ['not a url','https://example.com/admin','https://user:pass@example.com','file:///notes','http://example.com'])assert.throws(()=>client.serviceUrl(url),/分享服务地址必须/);
  assert.equal(client.serviceUrl('  http://localhost:8787  '),'http://localhost:8787');
  config.key='bad\nkey';await assert.rejects(()=>client.listShares(),/发布密钥格式/);assert.equal(requests,0);
  config.key='发布密钥';await client.loadShareConfig(true);await assert.rejects(()=>client.listShares(),/发布密钥格式/);assert.equal(requests,0);
  config.key='inshare_test';config.url='invalid';await client.loadShareConfig(true);await assert.rejects(()=>client.listShares(),/分享服务地址必须/);assert.equal(requests,0);
  for(const value of [{ok:true},null,[null],[{id:'id',title:'bad'}]]){
    const invalid=loadClient({app:{},files:new Map(),config:{url:'http://localhost:8787',key:'test',associations:{}},service:{fetch:async()=>new Response(JSON.stringify(value))}});
    await assert.rejects(()=>invalid.listShares(),/分享列表格式不正确/);
  }
});
