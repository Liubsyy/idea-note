import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';
import { QRCodeSVG } from 'qrcode.react';
import * as icons from 'lucide-react';

const id='a'.repeat(32);
const {window}=new JSDOM('<!doctype html><body><div id="root"></div></body>',{url:`https://reader.test/share/${id}?file=notes%2Fexample.md#section`});
Object.assign(globalThis,{window,document:window.document,IS_REACT_ACT_ENVIRONMENT:true});
window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
window.HTMLDialogElement.prototype.close=function(){this.open=false;};
let initial,response,requests,qrValues;
const dependencies={
  './assets/favicon.png?inline':{default:'data:image/png;base64,'+readFileSync(new URL('../web/assets/favicon.png',import.meta.url)).toString('base64')},
  'lucide-react':icons,
  react:React,'react/jsx-runtime':jsx,
  'react-dom/client':{createRoot:()=>({render:element=>{initial=element;}})},
  'qrcode.react':{QRCodeSVG:props=>{qrValues.push(props.value);return jsx.jsx(QRCodeSVG,props);}},
  '../renderer/i18n/core':{tr:s=>s},'./FolderBrowser':{SharedViewer:()=>jsx.jsx('main',{'data-testid':'viewer'})},
  './restore':{},'./backup':{},'./style.css':{},
};
function load(path){
  const exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    exports,require:name=>{assert.ok(dependencies[name],name);return dependencies[name];},
    window,document:window.document,location:window.location,URL,File:window.File,
    fetch:async path=>{requests.push(path);return response;},
  });
  return exports;
}
dependencies['./ShareQrDialog']=load('../web/ShareQrDialog.tsx');
load('../web/main.tsx');
const click=async element=>{assert.ok(element);await React.act(async()=>element.click());};
async function mount(nextResponse){
  response=nextResponse;requests=[];qrValues=[];
  const root=createRoot(document.getElementById('root'));
  await React.act(async()=>root.render(initial));
  return async()=>{await React.act(async()=>root.unmount());};
}

for(const format of [1,2]) test(`public ${format===1?'note':'folder'} shows a QR button beside its title and opens the shared dialog`,async()=>{
  const cleanup=await mount(new Response(JSON.stringify({id,title:'Shared title',updatedAt:1,document:{format}})));
  try{
    const heading=document.querySelector('.document-heading');
    assert.equal(heading.classList.contains('folder-heading'),format===2);
    assert.equal(heading.querySelector('h1').textContent,'Shared title');
    const button=heading.querySelector('button');
    assert.equal(button.getAttribute('aria-label'),'二维码');
    assert.equal(button.textContent,'');
    assert.equal(button.getAttribute('aria-haspopup'),'dialog');
    assert.equal(button.getAttribute('aria-expanded'),'false');
    assert.equal(document.querySelector('dialog'),null);
    await click(button);
    assert.equal(button.getAttribute('aria-expanded'),'true');
    const dialog=document.querySelector('dialog');
    assert.equal(dialog.open,true);
    assert.equal(dialog.querySelector('h2').textContent,'Shared title');
    assert.equal(qrValues.at(-1),`https://reader.test/share/${id}`);
    assert.equal(dialog.querySelector('a'),null);
    assert.ok(dialog.querySelector('svg[role="img"] path'));
    const logo=dialog.querySelector('svg image');
    assert.ok(logo);
    assert.match(decodeURIComponent(logo.getAttribute('href')),/data:image\/png;base64,/);
    assert.deepEqual(requests,[`/api/v1/public/${id}`]);
    await click(dialog.querySelector('button'));
    assert.equal(document.querySelector('dialog'),null);
    assert.equal(button.getAttribute('aria-expanded'),'false');
    assert.ok(document.querySelector('[data-testid="viewer"]'));
  }finally{await cleanup();}
});

test('loading and unavailable public shares do not offer a QR code',async()=>{
  let resolveResponse;
  const cleanup=await mount(new Promise(resolve=>{resolveResponse=resolve;}));
  try{
    assert.match(document.body.textContent,/正在加载/);
    assert.equal(document.querySelector('.document-qr-button'),null);
    await React.act(async()=>resolveResponse(new Response(JSON.stringify({error:'Share unavailable'}),{status:404})));
    assert.match(document.body.textContent,/分享暂不可用/);
    assert.equal(document.querySelector('.document-qr-button'),null);
    assert.equal(document.querySelector('dialog'),null);
  }finally{await cleanup();}
});
