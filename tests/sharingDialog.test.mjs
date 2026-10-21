import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';

const {window}=new JSDOM('<!doctype html><body><div id="root"></div></body>',{url:'https://desktop.test'});
Object.assign(globalThis,{window,document:window.document,IS_REACT_ACT_ENVIRONMENT:true});
const app={activeFilePath:'/notes/other.md',content:'# Other',openSettings:async()=>{}};
const store=selector=>selector(app);store.getState=()=>app;
let config,rows,preparations,published,associations,failList=false,configChanged;
const prepared=()=>({document:{format:2,title:'Folder',appearance:{},assets:[],expiresAt:null,entries:[{kind:'directory',path:'empty'},{kind:'markdown',path:'.private.md',content:{markdown:'# Sanitized preview',inputs:{x:{value:'test'}},results:[]}}]},files:[{source:'.private.md',path:'/notes/folder/.private.md',name:'.private.md',size:42,mime:'application/octet-stream',warnings:['hidden'],reviewOnly:true}],folder:{scan:{excluded:[{path:'loop',reason:'cycle'}]}},removedComments:1,contentKey:''});
const dependencies={
  react:React,'react-dom':ReactDOM,'react/jsx-runtime':jsx,'lucide-react':icons,'@tauri-apps/plugin-opener':{openUrl:async()=>{}},
  '../i18n/core':{tr:(text,args)=>text.replace(/\{\{(\w+)\}\}/g,(_,key)=>args?.[key]??'')},'../i18n/react':{useLanguage(){}},
  '../store/useAppStore':{useAppStore:store},'../lib/clipboard':{copyText:async()=>{}},'./sharing.css':{},
  '../lib/share/client':{
    loadShareConfig:async()=>config,listShares:async()=>{if(failList)throw new Error("分享服务不可用");return rows;},watchShareConfig:async callback=>{configChanged=callback;return()=>{};},defaultShareTitle:path=>path.split('/').pop(),serviceUrl:url=>url,
    prepareFolderShare:async(...args)=>{preparations.push(args);return prepared();},
    publishShare:async(value,current,approved)=>{published.push({value,current,approved});return{id:'folder-share',title:'Folder',kind:'folder',status:'active',version:1};},
    setAssociation:async(path,id,service,kind)=>{associations.push({path,id,service,kind});config.associations[path]={id,service,kind};},
  },
};
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/ShareDialog.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>{assert.ok(dependencies[name],name);return dependencies[name];},window,document:window.document,Set,Date});
const button=label=>[...document.querySelectorAll('button')].find(button=>button.textContent===label);
const click=async element=>{assert.ok(element);await React.act(async()=>element.click());};
async function mount(failure=false){
  failList=failure;
  config={url:'https://share.test',key:'key',associations:{}};rows=[];preparations=[];published=[];associations=[];
  const root=createRoot(document.getElementById('root'));
  await React.act(async()=>root.render(jsx.jsx(exports.ShareDialog,{folderPath:'/notes/folder',onClose(){}})));
  return async()=>{await React.act(async()=>root.unmount());};
}
test('folder dialog reviews every note, exclusions and sensitive paths; options reset preview and publication binds the folder',async()=>{
  const cleanup=await mount();
  try{
    assert.ok(button('当前文件夹'));
    const options=document.querySelectorAll('.sharing-option input');assert.equal(options.length,2);assert.ok([...options].every(input=>!input.checked));
    await click(button('预览待分享内容'));
    assert.equal(preparations[0][0],'/notes/folder');assert.deepEqual(JSON.parse(JSON.stringify(preparations[0][3])),{includeHidden:false,includeSymlinks:false});
    assert.match(document.querySelector('.sharing-review').textContent,/# Sanitized preview/);
    assert.match(document.querySelector('.sharing-review').textContent,/循环符号链接/);
    assert.equal(button('发布分享').disabled,true);
    await click(options[0]);assert.ok(button('预览待分享内容'));assert.equal(document.querySelector('.sharing-review'),null);
    await click(button('预览待分享内容'));assert.equal(preparations[1][3].includeHidden,true);
    await click(document.querySelector('.sharing-confirm input'));assert.equal(button('发布分享').disabled,false);
    await click(button('发布分享'));
    assert.equal(published.length,1);assert.ok(published[0].approved.has('/notes/folder/.private.md'));
    assert.deepEqual(associations,[{path:'/notes/folder',id:'folder-share',service:'https://share.test',kind:'folder'}]);
    assert.match(document.querySelector('[role="status"]').textContent,/分享已发布/);
  }finally{await cleanup();}
});
test('folder share management offers association only for matching types',async()=>{
  const cleanup=await mount();
  try{
    rows=[{id:'note',title:'Note',kind:'note',status:'active',updatedAt:1,bytes:1},{id:'folder',title:'Folder',kind:'folder',status:'active',updatedAt:1,bytes:1}];
    await click(document.querySelector('button[title="刷新"]'));await click(button('我的分享'));
    const articles=document.querySelectorAll('.sharing-list article');
    assert.doesNotMatch(articles[0].textContent,/关联当前文件夹/);assert.match(articles[1].textContent,/关联当前文件夹/);
  }finally{await cleanup();}
});

test('a failed share list blocks preparing and publishing until a successful refresh',async()=>{
  const cleanup=await mount(true);
  try{
    assert.match(document.querySelector('[role="alert"]').textContent,/分享服务不可用/);
    assert.equal(button('预览待分享内容').disabled,true);
    await click(button('预览待分享内容'));assert.equal(preparations.length,0);
    failList=false;await click(document.querySelector('button[title="刷新"]'));
    assert.equal(document.querySelector('[role="alert"]'),null);assert.equal(button('预览待分享内容').disabled,false);
    await click(button('预览待分享内容'));await click(document.querySelector('.sharing-confirm input'));
    assert.equal(button('发布分享').disabled,false);
    failList=true;await click(document.querySelector('button[title="刷新"]'));
    assert.equal(button('发布分享').disabled,true);assert.equal(published.length,0);
  }finally{await cleanup();}
});

test('a successful background configuration refresh clears a previous loading error',async()=>{
  const cleanup=await mount(true);
  try{
    assert.ok(document.querySelector('[role="alert"]'));
    failList=false;
    await React.act(async()=>configChanged());
    assert.equal(document.querySelector('[role="alert"]'),null);
    assert.equal(button('预览待分享内容').disabled,false);
  }finally{await cleanup();}
});
