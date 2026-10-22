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
import { QRCodeSVG } from 'qrcode.react';
import { relativePathWithinWorkspace } from '../src/lib/workspacePath.ts';

const {window}=new JSDOM('<!doctype html><body><div id="root"></div></body>',{url:'https://desktop.test'});
Object.assign(globalThis,{window,document:window.document,IS_REACT_ACT_ENVIRONMENT:true});
const app={activeFilePath:'/notes/other.md',workspacePath:'/notes',content:'# Other',openSettings:async()=>{}};
const store=selector=>selector(app);store.getState=()=>app;
let config,rows,preparations,published,associations,failList=false,configChanged,loadedPaths,qrValues;
const prepared=()=>({document:{format:2,title:'Folder',appearance:{},assets:[],expiresAt:null,entries:[{kind:'directory',path:'empty'},{kind:'markdown',path:'.private.md',content:{markdown:'# Sanitized preview',inputs:{x:{value:'test'}},results:[]}}]},files:[{source:'.private.md',path:'/notes/folder/.private.md',name:'.private.md',size:42,mime:'application/octet-stream',warnings:['hidden'],reviewOnly:true}],folder:{scan:{excluded:[{path:'loop',reason:'cycle'}]}},removedComments:1,contentKey:''});
const dependencies={
  '../assets/logo.png?inline':{default:'data:image/png;base64,'+readFileSync(new URL('../src/assets/logo.png',import.meta.url)).toString('base64')},
  '../lib/workspacePath':{relativePathWithinWorkspace},
  'qrcode.react':{QRCodeSVG:props=>{qrValues.push(props.value);return jsx.jsx(QRCodeSVG,props);}},
  react:React,'react-dom':ReactDOM,'react/jsx-runtime':jsx,'lucide-react':icons,'@tauri-apps/plugin-opener':{openUrl:async()=>{}},
  '../i18n/core':{tr:(text,args)=>text.replace(/\{\{(\w+)\}\}/g,(_,key)=>args?.[key]??'')},'../i18n/react':{useLanguage(){}},
  '../store/useAppStore':{useAppStore:store},'../lib/clipboard':{copyText:async()=>{}},'./sharing.css':{},
  '../lib/share/client':{
    loadShareConfig:async(_force,path)=>{loadedPaths.push(path);return config;},listShares:async()=>{if(failList)throw new Error("分享服务不可用");return rows;},watchShareConfig:async callback=>{configChanged=callback;return()=>{};},defaultShareTitle:path=>path.split('/').pop(),serviceUrl:url=>url,
    prepareFolderShare:async(...args)=>{preparations.push(args);return prepared();},
    publishShare:async(value,current,approved)=>{published.push({value,current,approved});return{id:'folder-share',title:'Folder',kind:'folder',status:'active',version:1};},
    setAssociation:async(path,id,service,kind)=>{associations.push({path,id,service,kind});config.associations[path]={id,service,kind};},
  },
};
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/components/ShareDialog.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:name=>{assert.ok(dependencies[name],name);return dependencies[name];},window,document:window.document,Set,Date});
const button=label=>[...document.querySelectorAll('button')].find(button=>button.textContent===label);
const click=async element=>{assert.ok(element);await React.act(async()=>element.click());};
async function mount(failure=false,folderPath='/notes/folder'){
  failList=failure;
  app.workspacePath='/notes';
  config={url:'https://share.test',key:'key',associations:{}};rows=[];preparations=[];published=[];associations=[];loadedPaths=[];qrValues=[];
  const root=createRoot(document.getElementById('root'));
  await React.act(async()=>root.render(jsx.jsx(exports.ShareDialog,{folderPath:folderPath||undefined,onClose(){}})));
  return async()=>{await React.act(async()=>root.unmount());};
}
test('folder dialog reviews every note, exclusions and sensitive paths; options reset preview and publication binds the folder',async()=>{
  const cleanup=await mount();
  try{
    assert.ok(button('当前文件夹'));assert.equal(loadedPaths[0],'/notes/folder');
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


test('a pulled relative-path binding shows the original link and updates that share',async()=>{
  const cleanup=await mount();
  try{
    config.associations['/notes/folder']={service:config.url,id:'existing-folder',kind:'folder'};
    rows=[{id:'existing-folder',title:'Original title',kind:'folder',status:'active',version:7,updatedAt:1,bytes:42}];
    await click(document.querySelector('button[title="刷新"]'));
    assert.match(document.querySelector('.sharing-link').textContent,/https:\/\/share.test\/share\/existing-folder/);
    await click(button('预览待分享内容'));await click(document.querySelector('.sharing-confirm input'));
    await click(button('更新分享'));
    assert.equal(published[0].current.id,'existing-folder');
    assert.equal(published[0].current.version,7);
  }finally{await cleanup();}
});

for (const kind of ['note','folder']) test(`${kind} shares show a local QR code for the reader link and hide it when inactive`,async()=>{
  const cleanup=await mount(false,kind==='folder'?'/notes/folder':null);
  try{
    const path=kind==='folder'?'/notes/folder':app.activeFilePath;
    config.associations[path]={service:config.url,id:'existing-share',kind};
    rows=[{id:'existing-share',title:'Shared title',kind,status:'active',version:1,updatedAt:1,bytes:42}];
    await click(document.querySelector('button[title="刷新"]'));
    assert.equal(document.querySelector('.sharing-qr'),null);
    await click(button('二维码'));
    assert.equal(button('二维码').getAttribute('aria-expanded'),'true');
    assert.equal(qrValues.at(-1),'https://share.test/share/existing-share');
    const svg=document.querySelector('.sharing-qr svg[role="img"]');
    assert.match(decodeURIComponent(svg.querySelector('image').getAttribute('href')),/data:image\/png;base64,/);
    assert.equal(svg.querySelector('title').textContent,'分享链接二维码');
    assert.ok(svg.querySelectorAll('path').length>=2);
    assert.equal(svg.querySelector('path').getAttribute('fill'),'#ffffff');
    await click(button('二维码'));
    assert.equal(document.querySelector('.sharing-qr'),null);
    await click(button('二维码'));
    rows[0]={...rows[0],status:'hidden'};
    await click(document.querySelector('button[title="刷新"]'));
    assert.equal(button('二维码'),undefined);
    assert.equal(document.querySelector('.sharing-qr'),null);
  }finally{await cleanup();}
});

test('share management generates QR codes for the selected active share and resets on service change',async()=>{
  const cleanup=await mount();
  try{
    rows=[
      {id:'first',title:'First',kind:'note',status:'active',updatedAt:1,bytes:1},
      {id:'second',title:'Second',kind:'folder',status:'active',updatedAt:1,bytes:1},
      {id:'hidden',title:'Hidden',status:'hidden',updatedAt:1,bytes:1},
      {id:'expired',title:'Expired',status:'expired',updatedAt:1,bytes:1},
      {id:'revoked',title:'Revoked',status:'revoked',updatedAt:1,bytes:1},
    ];
    await click(document.querySelector('button[title="刷新"]'));await click(button('我的分享'));
    const articles=document.querySelectorAll('.sharing-list article');
    const qrButton=article=>[...article.querySelectorAll('button')].find(b=>b.textContent==='二维码');
    assert.ok([...articles].slice(2).every(article=>!qrButton(article)));
    await click(qrButton(articles[0]));
    assert.equal(qrValues.at(-1),'https://share.test/share/first');
    await click(qrButton(articles[1]));
    assert.equal(qrValues.at(-1),'https://share.test/share/second');
    assert.equal(articles[0].querySelector('.sharing-qr'),null);
    assert.equal(document.querySelectorAll('.sharing-qr').length,1);
    config={...config,url:'https://new-share.test'};
    await React.act(async()=>configChanged());
    assert.equal(document.querySelector('.sharing-qr'),null);
    await click(qrButton(articles[1]));
    assert.equal(qrValues.at(-1),'https://new-share.test/share/second');
  }finally{await cleanup();}
});

test('my shares groups project notes and folders by local bindings and service',async()=>{
  const cleanup=await mount(false,'/notes/new-folder');
  try{
    config.associations={
      '/notes/a.md':{service:config.url,id:'note',kind:'note'},
      '/notes/folder':{service:config.url,id:'folder',kind:'folder'},
      '/notes':{service:config.url,id:'root',kind:'folder'},
      '/notes/duplicate.md':{service:config.url,id:'note'},
      '/notes-archive/a.md':{service:config.url,id:'outside'},
      '/notes/wrong-service.md':{service:'https://old-share.test',id:'wrong-service'},
    };
    rows=['outside','note','unknown','folder','wrong-service','root'].map(id=>({id,title:id,status:'active',updatedAt:1,bytes:1}));
    await click(document.querySelector('button[title="刷新"]'));await click(button('我的分享'));
    const groups=document.querySelectorAll('.sharing-group');
    assert.equal(groups.length,2);
    assert.equal(groups[0].querySelector('h3').textContent,'当前项目3');
    assert.equal(groups[1].querySelector('h3').textContent,'其他项目3');
    const titles=group=>[...group.querySelectorAll('article strong')].map(title=>title.textContent);
    assert.deepEqual(titles(groups[0]),['note','folder','root']);
    assert.deepEqual(titles(groups[1]),['outside','unknown','wrong-service']);
    // Associating another project's folder moves it into the current project.
    await click([...groups[1].querySelector('article').querySelectorAll('button')].find(b=>b.textContent==='关联当前文件夹'));
    await click(button('我的分享'));
    assert.equal(document.querySelector('.sharing-group h3').textContent,'当前项目4');
    assert.ok(titles(document.querySelector('.sharing-group')).includes('outside'));
  }finally{await cleanup();}
});

test('project grouping respects Windows separators and path boundaries',async()=>{
  const cleanup=await mount();
  try{
    app.workspacePath='D:/Notes';
    config.associations={
      'd:\\notes\\a.md':{service:config.url,id:'inside'},
      'D:/Notes-old/a.md':{service:config.url,id:'outside'},
    };
    rows=['inside','outside'].map(id=>({id,title:id,status:'active',updatedAt:1,bytes:1}));
    await click(document.querySelector('button[title="刷新"]'));await click(button('我的分享'));
    const groups=document.querySelectorAll('.sharing-group');
    assert.equal(groups[0].querySelector('article strong').textContent,'inside');
    assert.equal(groups[1].querySelector('article strong').textContent,'outside');
  }finally{await cleanup();}
});

test('empty groups remain visible and no open project puts shares under other projects',async()=>{
  const cleanup=await mount();
  try{
    await click(button('我的分享'));
    assert.equal(document.querySelectorAll('.sharing-group').length,2);
    assert.ok([...document.querySelectorAll('.sharing-group p')].every(p=>p.textContent==='暂无分享'));
    app.workspacePath=null;
    config.associations={'/notes/a.md':{service:config.url,id:'note'}};
    rows=[{id:'note',title:'Note',status:'active',updatedAt:1,bytes:1}];
    await click(document.querySelector('button[title="刷新"]'));
    const groups=document.querySelectorAll('.sharing-group');
    assert.equal(groups[0].querySelector('h3').textContent,'当前项目0');
    assert.equal(groups[1].querySelector('h3').textContent,'其他项目1');
  }finally{await cleanup();}
});

test('sharing an external folder still loads current project bindings for grouping',async()=>{
  const cleanup=await mount(false,'/external/folder');
  const originalLoad=dependencies['../lib/share/client'].loadShareConfig;
  try{
    config.associations={'/external/folder':{service:config.url,id:'external',kind:'folder'}};
    rows=['project','external'].map(id=>({id,title:id,kind:'folder',status:'active',version:1,updatedAt:1,bytes:1}));
    dependencies['../lib/share/client'].loadShareConfig=async(_force,path)=>{
      loadedPaths.push(path);
      return path==='/notes'?{...config,associations:{'/notes/folder':{service:config.url,id:'project',kind:'folder'}}}:config;
    };
    await click(document.querySelector('button[title="刷新"]'));
    assert.match(document.querySelector('.sharing-link').textContent,/share\/external/);
    await click(button('我的分享'));
    const groups=document.querySelectorAll('.sharing-group');
    assert.equal(groups[0].querySelector('article strong').textContent,'project');
    assert.equal(groups[1].querySelector('article strong').textContent,'external');
    assert.ok(loadedPaths.includes('/notes'));
  }finally{dependencies['../lib/share/client'].loadShareConfig=originalLoad;await cleanup();}
});
