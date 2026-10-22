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

const {window}=new JSDOM('<!doctype html><body><div id="root"></div></body>',{url:'https://custom-share.test/admin?session=private#shares'});
Object.assign(globalThis,{window,document:window.document,IS_REACT_ACT_ENVIRONMENT:true});
// jsdom does not implement the native dialog lifecycle.
window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
window.HTMLDialogElement.prototype.close=function(){this.open=false;};
let rows,qrValues,initial,requests;
const dependencies={
  'lucide-react':icons,
  react:React,'react/jsx-runtime':jsx,
  'react-dom/client':{createRoot:()=>({render:element=>{initial=element;}})},
  'qrcode.react':{QRCodeSVG:props=>{qrValues.push(props.value);return jsx.jsx(QRCodeSVG,props);}},
  '../renderer/i18n/core':{tr:s=>s},'./FolderBrowser':{SharedViewer:()=>null},
  './restore':{restoreArchive:async()=>{}},'./backup':{downloadBackup:async()=>{}},'./style.css':{},
};
function load(path){
  const exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    exports,require:name=>{assert.ok(dependencies[name],name);return dependencies[name];},
    window,document:window.document,location:window.location,URL,File:window.File,
    fetch:async path=>{
      requests.push(path);
      const data=path.startsWith('/api/v1/admin/shares?')?rows:path==='/api/v1/admin/publishers'?[]:{shares:{count:rows.length,bytes:0},storage:{bytes:0},publishers:{count:0},audit:[]};
      return new Response(JSON.stringify(data));
    },
  });
  return exports;
}
dependencies['./ShareQrDialog']=load('../web/ShareQrDialog.tsx');
load('../web/main.tsx');
const click=async element=>{assert.ok(element);await React.act(async()=>element.click());};
const button=(label,host=document)=>[...host.querySelectorAll('button')].find(b=>b.textContent===label);
async function mount(){
  qrValues=[];requests=[];
  rows=[
    {id:'a'.repeat(32),title:'Note',kind:'note',status:'active',expiresAt:null},
    {id:'b'.repeat(32),title:'Folder',kind:'folder',status:'active',expiresAt:Date.now()+86400000},
    {id:'c'.repeat(32),title:'Hidden',status:'hidden',expiresAt:null},
    {id:'d'.repeat(32),title:'Expired',status:'active',expiresAt:Date.now()-1000},
    {id:'e'.repeat(32),title:'Revoked',status:'revoked',expiresAt:null},
  ].map(row=>({...row,version:1,bytes:42,updatedAt:1,owner:'publisher'}));
  const root=createRoot(document.getElementById('root'));
  await React.act(async()=>root.render(initial));
  return async()=>{await React.act(async()=>root.unmount());};
}

test('admin notes and folders generate local QR codes for public URLs on the current domain',async()=>{
  const cleanup=await mount();
  try{
    const tableRows=document.querySelectorAll('tbody tr');
    assert.equal(document.querySelector('dialog'),null);
    assert.ok([...tableRows].slice(2).every(row=>!button('二维码',row)));
    const initialRequests=requests.length;
    for(const [index,id] of ['a','b'].entries()){
      await click(button('二维码',tableRows[index]));
      const dialog=document.querySelector('dialog');
      const url='https://custom-share.test/share/'+id.repeat(32);
      assert.equal(dialog.open,true);
      assert.equal(dialog.getAttribute('aria-label'),'分享链接二维码');
      assert.equal(qrValues.at(-1),url);
      assert.equal(dialog.querySelector('a'),null);
      assert.equal(dialog.querySelector('svg[role="img"] title').textContent,'分享链接二维码');
      assert.ok(dialog.querySelectorAll('svg path').length>=2);
      await click(button('关闭',dialog));
      assert.equal(document.querySelector('dialog'),null);
    }
    assert.equal(requests.length,initialRequests);
  }finally{await cleanup();}
});

test('admin QR dialog closes on Escape or backdrop and disappears when a share is hidden',async()=>{
  const cleanup=await mount();
  try{
    await click(button('二维码'));
    await React.act(async()=>document.querySelector('dialog').dispatchEvent(new window.Event('cancel',{cancelable:true})));
    assert.equal(document.querySelector('dialog'),null);
    await click(button('二维码'));await click(document.querySelector('dialog'));
    assert.equal(document.querySelector('dialog'),null);
    await click(button('二维码'));
    rows=rows.map((row,index)=>index===0?{...row,status:'hidden'}:row);
    await click(button('刷新'));
    assert.equal(document.querySelector('dialog'),null);
    assert.equal(button('二维码',document.querySelector('tbody tr')),undefined);
  }finally{await cleanup();}
});
