// Run `npm run dev -- --cors` in a browser, or use a native test window with ?nativeRoot=...&report=...
import React from 'react';
import { createRoot } from 'react-dom/client';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { undo, redo } from '@codemirror/commands';
import '../src/styles/globals.css';
import fixtureHtml from './preview-fixtures/index.html?raw';

const params = new URLSearchParams(location.search);
const native = isTauri();
const fixtureRoot = params.get('nativeRoot') ?? '/fixtures';
const htmlPath = `${fixtureRoot}/index.html`;
const result = document.getElementById('test-result')!;
const host = document.getElementById('test-editor')!;
const delay = (ms:number) => new Promise(resolve => setTimeout(resolve,ms));
const passed:string[] = [];
const html = fixtureHtml;
if (native && params.get('report')) await invoke('write_file', { path: params.get('report'), content: 'STARTED native preview regression' });
let sessionClosed = 0, sessionCreated = 0;
const disk = new Map([[htmlPath, html]]);
if (!native) {
  mockWindows('main');
  mockIPC((cmd, args) => {
    if(cmd === 'read_file') return disk.get(String(args?.path)) ?? '';
    if(cmd === 'write_file') { disk.set(String(args?.path), String(args?.content)); return; }
    if(cmd === 'file_stat') return [1, disk.get(String(args?.path))?.length ?? 0];
    if(cmd === 'sync_config_load') return '{}';
    if(cmd === 'git_proxy_load') return '';
    if(cmd === 'create_preview_session') { sessionCreated++; return { sessionId:'test', baseUrl:`${location.origin}/tests/preview-fixtures/` }; }
    if(cmd === 'close_preview_session') { sessionClosed++; return; }
    return null;
  }, { shouldMockEvents:true });
}
function check(value:unknown, message:string):asserts value { if(!value) throw Error(message); }
async function until(predicate:()=>unknown, label:string) {
  for(let i=0;i<150;i++) { if(predicate()) return; await delay(30); }
  throw Error(`Timed out: ${label}`);
}
try {
  const { useAppStore } = await import('../src/store/useAppStore');
  const { FilePreviewEditor } = await import('../src/components/Editor/FilePreviewEditor');
  const { filePreviewKind } = await import('../src/lib/filePreview');
  const { getActiveView, getSearchView } = await import('../src/lib/codemirror/activeView');
  const { runScopeHandlers } = await import('@codemirror/view');
  const { closeSearchPanel } = await import('@codemirror/search');
  useAppStore.setState({ workspacePath: native ? fixtureRoot : null, refreshTree:async()=>{} });
  function Fixture() {
    const path = useAppStore(s=>s.activeFilePath);
    const docKey = useAppStore(s=>s.docKey);
    return path ? <FilePreviewEditor key={docKey} path={path} kind={filePreviewKind(path)!}/> : null;
  }
  const root = createRoot(host);
  const click = (text:string) => {
    const el = [...host.querySelectorAll('button')].find(b=>b.textContent === text || b.getAttribute('aria-label') === text);
    check(el, `missing button ${text}`); el.click();
  };
  const replace = (text:string) => {
    const view = getActiveView(); check(view, 'active source editor');
    view.dispatch({changes:{from:0,to:view.state.doc.length,insert:text}}); return view;
  };
  function checkFormattedSearch(term: string, original: string) {
    const view = getSearchView(); check(view && !getActiveView(), 'preview is only the search target');
    const key = (letter: string, alt = false) => new KeyboardEvent('keydown', {
      key: letter, code: 'Key' + letter.toUpperCase(), bubbles: true, cancelable: true,
      metaKey: /Mac|iP(hone|ad)/.test(navigator.platform), ctrlKey: !/Mac|iP(hone|ad)/.test(navigator.platform), altKey: alt,
    });
    check(runScopeHandlers(view, key('f'), 'search-open'), 'global find opens formatted view');
    const field = view.dom.querySelector<HTMLInputElement>('input[placeholder="查找"]');
    check(field && document.activeElement === field, 'find field receives focus');
    field.value = term; field.dispatchEvent(new Event('input', { bubbles: true }));
    check(view.dom.querySelector('.cm-find-count')?.textContent?.includes('/'), 'formatted matches counted');
    const first = view.state.selection.main.from;
    view.dom.querySelector<HTMLButtonElement>('button[title="下一个 (↵)"]')!.click();
    check(view.state.selection.main.from !== first, 'next formatted match');
    view.dom.querySelector<HTMLButtonElement>('button[title="上一个 (⇧↵)"]')!.click();
    check(view.state.selection.main.from === first, 'previous formatted match');
    check(view.dom.querySelector<HTMLButtonElement>('.cm-find-mode')?.hidden, 'read-only search hides replacement toggle');
    check(runScopeHandlers(view, key('r'), 'search-open'), 'replace shortcut remains handled');
    check(view.dom.querySelector<HTMLInputElement>('input[placeholder="替换为"]')?.parentElement?.style.display === 'none', 'replacement stays hidden');
    check(useAppStore.getState().content === original && !useAppStore.getState().isDirty, 'search preserves source and dirty state');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check(!view.dom.querySelector('.cm-find-panel'), 'Escape closes search');
    click('查找'); check(view.dom.querySelector('.cm-find-panel'), 'toolbar opens search');
    closeSearchPanel(view);
    return { view, key };
  }
  let report:any = null, reports = 0;
  window.addEventListener('message', event => {
    if(event.source === host.querySelector('iframe')?.contentWindow && event.data?.type === 'preview-fixture') { report=event.data; reports++; }
  });
  await useAppStore.getState().openFile(htmlPath);
  root.render(<Fixture/>);
  await until(()=>getActiveView(), 'HTML default source');
  await delay(400);
  check(!host.querySelector('iframe') && reports===0, 'source mode mounts no iframe or scripts');
  if (!native) check(sessionCreated===0, 'source mode creates no resource session');
  check(host.querySelector('[aria-label="源码"]')?.getAttribute('aria-pressed') === 'true', 'HTML defaults to source');
  check(host.querySelector('.svg-editor-modes button')?.getAttribute('aria-label') === '源码', 'HTML source tab is first');
  click('预览');
  await until(()=>report, 'HTML assets');
  check(report.value===42 && report.classic && report.count==='1' && report.image===40 && report.color==='rgb(47, 85, 136)', JSON.stringify(report));
  check(report.parentBlocked && !report.nativeExposed, 'iframe isolation');
  check(host.querySelector('iframe')?.getAttribute('sandbox') === 'allow-scripts', 'sandbox flags');
  passed.push('HTML lazy source, scripts, modules, CSS, Unicode image and isolation');
  click('分屏'); await until(()=>getActiveView(), 'HTML source');
  const view = getActiveView()!;
  const baseline = reports;
  replace(html.replace('HTML 本地资源预览', '已实时更新'));
  await until(()=>reports>baseline, 'live reload');
  if (!native) {
    await useAppStore.getState().save();
    check(disk.get(htmlPath) === useAppStore.getState().content && !useAppStore.getState().isDirty, 'HTML save');
  }
  click('预览'); await until(()=>!getActiveView(), 'hide source');
  click('源码'); await until(()=>getActiveView(), 'show source');
  check(getActiveView()===view && undo(view), 'preserve editor undo');
  check(useAppStore.getState().content===html, 'undo source');
  await until(()=>!host.textContent?.includes('更新中'), 'settle');
  click('分屏');
  await until(()=>host.querySelector('.html-preview-container')?.getAttribute('aria-busy')==='false','reopened preview loaded');
  const beforeRefresh=reports;
  click('刷新预览'); await until(()=>reports>beforeRefresh,'manual refresh');
  replace('<h1>still visible</h1><script>throw new Error("fixture error")</script>');
  await until(()=>host.querySelector('[role="alert"]')?.textContent?.includes('fixture error'),'script error diagnostic');
  passed.push('HTML live update, refresh, undo and script diagnostics');

  // Read-only formatting never touches the source buffer or its dirty state.
  const originalJson = '{"nested":{"value":1},"big":900719925474099312345}';
  useAppStore.setState(s=>({activeFilePath:`${fixtureRoot}/test.JSON`,content:originalJson,isDirty:false,docKey:s.docKey+1}));
  const formatted = () => host.querySelector('.structured-formatted-view .cm-content');
  await until(()=>formatted()?.textContent?.includes('900719925474099312345'),'JSON formatted view');
  check(!getActiveView() && !useAppStore.getState().isDirty && useAppStore.getState().content===originalJson,'view does not edit source');
  check(formatted()?.getAttribute('contenteditable')==='false','formatted document is read-only');
  check(!host.querySelector('[aria-label="分屏"]') && !host.querySelector('[aria-label="格式化源码"]'),'only two modes; no source action in read-only mode');
  const jsonSearch = checkFormattedSearch(':', originalJson);
  useAppStore.setState({editorKeybindings:{find:'Mod-Alt-j'}});
  await delay(60);
  check(!runScopeHandlers(jsonSearch.view, jsonSearch.key('f'), 'search-open'), 'custom shortcut removes old find binding');
  check(runScopeHandlers(jsonSearch.view, jsonSearch.key('j', true), 'search-open'), 'custom find opens formatted view');
  closeSearchPanel(jsonSearch.view);
  useAppStore.setState({editorKeybindings:{}});
  await delay(60);
  click('源码'); await until(()=>getActiveView(),'JSON source');
  check(getSearchView()===getActiveView(), 'source mode restores search target');
  const jsonView=getActiveView()!;
  jsonView.dispatch({selection:{anchor:12}});
  click('格式化视图'); await until(()=>!getActiveView(),'formatted view');
  click('源码'); await until(()=>getActiveView(),'source again');
  check(getActiveView()===jsonView && jsonView.state.selection.main.anchor===12,'mode switch preserves editor and cursor');
  click('格式化源码');
  await until(()=>useAppStore.getState().content.includes('\n'),'format source');
  check(useAppStore.getState().isDirty && useAppStore.getState().content.includes('900719925474099312345'),'explicit format marks dirty and preserves number');
  check(undo(jsonView) && useAppStore.getState().content===originalJson,'single-step format undo');
  check(redo(jsonView) && useAppStore.getState().content.includes('\n'),'format redo');
  replace('{"nested":{"value":2},"big":900719925474099312345}');
  await until(()=>formatted()?.textContent?.includes('"value": 2'),'formatted view updates');
  replace('{"nested":'); await until(()=>host.querySelector('[role="alert"]'),'JSON error');
  click('格式化源码');
  check(useAppStore.getState().content==='{"nested":','invalid format leaves source intact');
  check(host.textContent?.includes('已过期') && formatted()?.textContent?.includes('900719925474099312345'),'last valid formatted view');
  replace('{"nested":{"value":3}}'); await until(()=>!host.querySelector('[role="alert"]'),'JSON recovery');
  if (!native) {
    await useAppStore.getState().save();
    check(disk.get(`${fixtureRoot}/test.JSON`) === useAppStore.getState().content && !useAppStore.getState().isDirty, 'JSON save');
    await until(()=>useAppStore.getState().diskStat, 'saved JSON stat');
    disk.set(`${fixtureRoot}/test.JSON`, '{"externalUpdate":true}');
    await useAppStore.getState().checkExternalChange();
    await until(()=>formatted()?.textContent?.includes('externalUpdate'), 'JSON external reload');
  }
  passed.push('JSON read-only formatting, explicit format, precision, undo/redo, errors, save and external reload');
  const yamlSource='# comment\nnode: &node\n    self: *node\n    n: 900719925474099312345\n---\nlist: [a, b]\n';
  useAppStore.setState(s=>({activeFilePath:`${fixtureRoot}/test.yml`,content:yamlSource,isDirty:false,docKey:s.docKey+1}));
  await until(()=>formatted()?.textContent?.includes('*node'),'YAML formatted view');
  check(formatted()?.textContent?.includes('---') && formatted()?.textContent?.includes('# comment'),'YAML documents and comments');
  check(useAppStore.getState().content===yamlSource && !useAppStore.getState().isDirty,'YAML viewing leaves source intact');
  checkFormattedSearch('node', yamlSource);
  passed.push('JSON/YAML formatted search, next/previous, read-only state, toolbar, custom shortcuts and source target');
  click('源码'); await until(()=>getActiveView(),'YAML source');
  const yamlView=getActiveView()!;
  click('格式化源码'); await until(()=>useAppStore.getState().isDirty,'YAML format');
  check(useAppStore.getState().content.includes('*node') && useAppStore.getState().content.includes('900719925474099312345'),'YAML references and precision');
  check(undo(yamlView) && useAppStore.getState().content===yamlSource,'YAML format undo');
  host.style.width='220px';
  await until(()=>host.querySelector('.preview-editor-compact'),'compact toolbar');
  check(host.scrollWidth<=host.clientWidth,'no horizontal overflow');
  passed.push('YAML formatted view, multi-documents, cyclic aliases, comments, source undo and compact layout');
  root.unmount(); await delay(50);
  check(!getSearchView(), "unmount clears search target");
  if(!native) check(sessionClosed>0,'session disposed');
  if(native) {
    const session=await invoke<any>('create_preview_session',{path:htmlPath,workspaceRoot:fixtureRoot});
    await invoke('close_preview_session',{sessionId:session.sessionId});
    const response=await fetch(`${session.baseUrl}assets/classic.js`);
    check(response.status===404,'expired native session');
    passed.push('native resource session cleanup');
  }
  result.textContent=`PASS (${passed.length} groups): ${passed.join('; ')}`;
  document.title='PASS — file preview regression';
} catch(error) {
  result.textContent=`FAIL after ${passed.join('; ')}: ${String(error)}`;
  document.title='FAIL — file preview regression'; console.error(error);
}
if(native && params.get('report')) {
  await invoke('write_file',{path:params.get('report'),content:result.textContent});
  const {getCurrentWindow}=await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}
