import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
const load=(path,dependencies,globals={})=>{
  const exports={};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:name=>{assert.ok(name in dependencies,name);return dependencies[name];},...globals});return exports;
};
const runtime=load('../renderer/runtime.ts',{});
const snapshot=await import('../renderer/snapshot.ts');
const id='a'.repeat(32),asset=`/api/v1/public/${id}/assets/${'b'.repeat(32)}`;
const {window}=new JSDOM('<!doctype html><body></body>',{url:`https://share.test/share/${id}`});
const record={markdown:`[Next](/share/${id}?file=sub%2Fnote.md)`,title:'Readme',format:1,appearance:{},assets:[],expiresAt:null,results:[],inputs:{}};
let selected=0,destroyed=0;
class View {
  static editable={of:()=>[]};static lineWrapping=[];
  constructor({parent,state}){
    this.state=state;this.dom=window.document.createElement('div');parent.append(this.dom);
    const chip=window.document.createElement('span');chip.className='resource';chip.setAttribute('data-resource-from','0');chip.setAttribute('data-resource-to',String(record.markdown.length));chip.textContent='Next';
    // Desktop widgets replace their DOM when selection changes on mousedown.
    chip.addEventListener('mousedown',()=>{selected++;chip.remove();});this.dom.append(chip);
  }
  dispatch(){}posAtDOM(){return 0;}destroy(){destroyed++;this.dom.remove();}
}
const deps={
  '@codemirror/language':{syntaxTree:()=>({resolveInner:()=>({name:'',parent:null})})},'./snapshot':snapshot,'./runtime':runtime,
  '@codemirror/state':{EditorState:{readOnly:{of:()=>[]},create:config=>({sliceDoc:(from,to)=>config.doc.slice(from,to)})}},'@codemirror/view':{EditorView:View},
  '@codemirror/lang-markdown':{markdown:()=>[],markdownLanguage:{}},'@codemirror/language-data':{languages:[]},'@lezer/markdown':{GFM:[]},
  './lib/codemirror/livePreview':{livePreview:[],syntaxParseDriver:[],defaultComponentFoldEffects:()=>[]},
  './lib/codemirror/tablePreview':{tablePreview:[]},'./lib/codemirror/htmlPreview':{htmlPreview:[]},'./lib/codemirror/detailsBlock':{detailsBlock:[]},'./lib/codemirror/math':{inlineMath:[],mathBlock:[]},'./lib/codemirror/diagram':{mermaidBlock:[]},'./lib/codemirror/paragraphWrap':{paragraphSoftWrap:[]},'./lib/codemirror/inputBlock':{inputBlock:[]},'./lib/codemirror/resultBlock':{resultBlock:[]},'./lib/codemirror/theme':{cmTheme:[],cmHighlighting:[]},
  './store/useRunStore':{useRunStore:{setState(){}},runKey:()=>''},'./store/useInputStore':{useInputStore:{setState(){}}},'./lib/codeRun/runners':{fenceLang:()=>''},'./lib/codemirror/editor.css':{},
};
const {mountShareViewer}=load('../renderer/viewer.ts',deps,{window,location:window.location,Element:window.Element,URL,RegExp});
test('shared link navigation intercepts mousedown before desktop widgets replace their DOM and opens once',()=>{
  const host=window.document.createElement('div');window.document.body.append(host);const paths=[];
  const cleanup=mountShareViewer(host,record,id,false,(...args)=>paths.push(args));
  const chip=host.querySelector('.resource');
  chip.dispatchEvent(new window.MouseEvent('mousedown',{bubbles:true,cancelable:true}));
  chip.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true}));
  assert.equal(selected,0);assert.deepEqual(paths,[['sub/note.md','']]);
  assert.equal(runtime.renderRuntime.resolveResource(asset+'#view'),asset+'#view');
  assert.equal(runtime.renderRuntime.resolveResource('/api/v1/public/'+ 'f'.repeat(32)+'/assets/'+ 'b'.repeat(32)), '');
  assert.doesNotThrow(()=>runtime.renderRuntime.openLink('http://['));
  cleanup();assert.equal(destroyed,1);host.remove();
});
test('administrator viewer keeps anchor suffixes when mapping assets to protected routes',()=>{
  const host=window.document.createElement('div');const cleanup=mountShareViewer(host,record,id,true);
  assert.equal(runtime.renderRuntime.resolveResource(asset+'#view'),asset.replace('/public/'+id+'/','/admin/shares/'+id+'/')+'#view');
  cleanup();
});
