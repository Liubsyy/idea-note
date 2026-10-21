import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';

const {window}=new JSDOM('<!doctype html><body><div id="root"></div></body>',{url:'https://share.test/share/'+'a'.repeat(32)});
Object.assign(globalThis,{window,document:window.document,IS_REACT_ACT_ENVIRONMENT:true});
const load=(path,dependencies,globals={})=>{
  const exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>{assert.ok(dependencies[name],name);return dependencies[name];},...globals});
  return exports;
};
const folder=load('../renderer/folder.ts',{});
const id='a'.repeat(32),asset='/api/v1/public/'+id+'/assets/'+'b'.repeat(32);
const note=(path,markdown=path)=>({kind:'markdown',path,content:{markdown,inputs:{},results:[]}});
const snapshot={format:2,title:'Project',appearance:{},assets:['b'.repeat(32)],expiresAt:null,entries:[{kind:'directory',path:'sub'},{kind:'directory',path:'empty'},note('sub/笔记.md'),note('README.md'),{kind:'file',path:'unsafe.html',asset,mime:'application/octet-stream',size:10},{kind:'file',path:'pic.svg',asset,mime:'image/svg+xml',size:10},{kind:'file',path:'archive.zip',asset,mime:'application/octet-stream',size:10}]};
let mounts=[],destroyed=0,fetches=[];
const {SharedViewer}=load('../web/FolderBrowser.tsx',{
  react:React,'react/jsx-runtime':jsx,'lucide-react':icons,'../renderer/folder':folder,'../renderer/i18n/core':{tr:s=>s},
  '../renderer/viewer':{mountShareViewer(host,document,id,admin,navigate){mounts.push({document,id,admin,navigate});host.textContent=document.markdown;return()=>{destroyed++;host.textContent='';};}},
},{window,location:window.location,history:window.history,URL,URLSearchParams,TextDecoder,AbortController,fetch:async url=>{fetches.push(url);return new Response('<script>window.evil=true</script>');}});
const click=async element=>{assert.ok(element);await React.act(async()=>element.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true})));};
const link=label=>[...document.querySelectorAll('.folder-row')].find(e=>e.textContent===label);
async function render(data=snapshot,query='',adminPreview=false){
  window.history.replaceState(null,'','/share/'+id+query);mounts=[];destroyed=0;fetches=[];
  const root=createRoot(document.getElementById('root'));
  await React.act(async()=>root.render(jsx.jsx(SharedViewer,{document:data,shareId:id,adminPreview})));
  return async()=>{await React.act(async()=>root.unmount());};
}

test('folder reference resolution preserves Unicode, encodings, anchors and root boundaries',()=>{
  assert.deepEqual(JSON.parse(JSON.stringify(folder.folderReference('sub/note.md','../图%20片.png#view'))),{path:'图 片.png',suffix:'#view'});
  for(const source of ['../../private.md','https://example.com','javascript:alert(1)','/absolute.md','C:\\private.md','#local'])assert.equal(folder.folderReference('sub/note.md',source),null);
  assert.equal(folder.defaultFolderFile(snapshot),'README.md');
  assert.equal(folder.defaultFolderFile({...snapshot,entries:[note('sub/a.md'),{kind:'file',path:'file.zip'}]}),'sub/a.md');
  assert.equal(folder.defaultFolderFile({...snapshot,entries:[]}),undefined);
});

test('folder navigation opens README, expands paths, updates URLs, handles history and destroys old note viewers',async()=>{
  const cleanup=await render();
  try{
    assert.equal(mounts.at(-1).document.markdown,'README.md');
    assert.equal(link('README.md').getAttribute('aria-current'),'page');
    await click(link('sub'));await click(link('笔记.md'));
    assert.equal(new URLSearchParams(locationOf().search).get('file'),'sub/笔记.md');
    assert.equal(mounts.at(-1).document.markdown,'sub/笔记.md');assert.equal(destroyed,1);
    await React.act(async()=>mounts.at(-1).navigate('README.md','#intro'));
    assert.equal(window.location.hash,'#intro');assert.equal(mounts.at(-1).document.markdown,'README.md');
    window.history.replaceState(null,'','?file=sub%2F%E7%AC%94%E8%AE%B0.md');
    await React.act(async()=>window.dispatchEvent(new window.PopStateEvent('popstate')));
    assert.equal(mounts.at(-1).document.markdown,'sub/笔记.md');
    await click(document.querySelector('.folder-toggle'));assert.ok(document.querySelector('.folder-sidebar.open'));
    await click(link('README.md'));assert.equal(document.querySelector('.folder-sidebar.open'),null);
  }finally{await cleanup();}
});
const locationOf=()=>window.location;

test('direct links, missing files, empty folders, image preview, escaped text and download fallback',async()=>{
  let cleanup=await render(snapshot,'?file=sub%2F%E7%AC%94%E8%AE%B0.md');
  assert.equal(link('sub').getAttribute('aria-expanded'),'true');assert.equal(mounts.at(-1).document.markdown,'sub/笔记.md');await cleanup();
  cleanup=await render(snapshot,'?file=../private');assert.match(document.querySelector('.folder-content').textContent,/文件不存在/);assert.ok(link('README.md'));await cleanup();
  cleanup=await render({...snapshot,entries:[{kind:'directory',path:'empty'}]});assert.match(document.querySelector('.folder-content').textContent,/此文件夹为空/);await click(link('empty'));assert.ok(document.querySelector('.folder-empty'));await cleanup();
  cleanup=await render(snapshot,'?file=pic.svg');assert.equal(document.querySelector('.shared-asset img').getAttribute('src'),asset);await cleanup();
  cleanup=await render(snapshot,'?file=unsafe.html');assert.match(document.querySelector('.shared-asset pre').textContent,/<script>/);assert.equal(document.querySelector('.shared-asset script'),null);assert.equal(window.evil,undefined);await cleanup();
  cleanup=await render(snapshot,'?file=archive.zip');assert.match(document.querySelector('.shared-asset').textContent,/不支持预览/);assert.equal(document.querySelector('a[download]').getAttribute('href'),asset);await cleanup();
});

test('administrator folder previews use protected resource URLs and legacy notes still mount',async()=>{
  let cleanup=await render(snapshot,'?file=unsafe.html',true);
  assert.equal(fetches[0],asset.replace('/public/'+id+'/', '/admin/shares/'+id+'/'));
  assert.equal(document.querySelector('a[download]').getAttribute('href'),fetches[0]);await cleanup();
  const old={format:1,title:'Legacy',markdown:'# Old',inputs:{},results:[],assets:[],appearance:{},expiresAt:null};
  cleanup=await render(old);assert.equal(document.querySelector('.folder-sidebar'),null);assert.equal(mounts.at(-1).document,old);await cleanup();
});
