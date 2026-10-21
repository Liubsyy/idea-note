import { syntaxTree } from '@codemirror/language';
import { resourceReferences } from './snapshot';
import { renderRuntime } from './runtime';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { GFM } from '@lezer/markdown';
import { configureRenderRuntime } from './runtime';
import { livePreview, syntaxParseDriver, defaultComponentFoldEffects } from './lib/codemirror/livePreview';
import { tablePreview } from './lib/codemirror/tablePreview';
import { htmlPreview } from './lib/codemirror/htmlPreview';
import { detailsBlock } from './lib/codemirror/detailsBlock';
import { inlineMath, mathBlock } from './lib/codemirror/math';
import { mermaidBlock } from './lib/codemirror/diagram';
import { paragraphSoftWrap } from './lib/codemirror/paragraphWrap';
import { inputBlock } from './lib/codemirror/inputBlock';
import { resultBlock } from './lib/codemirror/resultBlock';
import { cmTheme, cmHighlighting } from './lib/codemirror/theme';
import { useRunStore, runKey, type RunRecord } from './store/useRunStore';
import { useInputStore } from './store/useInputStore';
import { fenceLang, type CodeRunner } from './lib/codeRun/runners';
import type { InputValue } from './lib/inputs/schema';
import './lib/codemirror/editor.css';

export interface ShareDocument {
  format: 1;
  title: string;
  markdown: string;
  expiresAt: number | null;
  assets: string[];
  appearance: Record<string, string>;
  inputs: Record<string, Record<string, InputValue>>;
  results: Array<Pick<RunRecord, 'code' | 'info' | 'componentResult' | 'inputs' | 'inputSummary' | 'ms'>>;
}
export function mountShareViewer(host: HTMLElement, document: ShareDocument, shareId: string, adminPreview = false, navigate?: (path: string, hash: string) => void) {
  const filePath = 'shared';
  const runners: CodeRunner[] = document.results.map(r => ({ lang: fenceLang(r.info), aliases: [], enabled: true, command: '', args: [], ext: '', env: {}, timeoutMs: 0 }));
  const state = { activeFilePath: filePath, codeRunConfig: { enabled: true, confirmEveryRun: true, fontSize: 13, maxOutputKb: 200, runners }, runPanelOpen: false, toggleRunPanel() {}, showToast() {} };
  const allowedAsset = (src: string) => {
    if (new RegExp(`^/api/v1/public/${shareId}/assets/[a-f0-9]{32}(?:[?#].*)?$`).test(src)) return adminPreview ? src.replace(`/public/${shareId}/`, `/admin/shares/${shareId}/`) : src;
    return /^(?:https?:\/\/|data:image\/(?:png|jpeg|gif|webp|avif);base64,)/i.test(src) ? src : '';
  };
  host.classList.toggle('dark',document.appearance['--share-color-scheme']==='dark');
  configureRenderRuntime({ untrustedContent: true, isDark: () => document.appearance['--share-color-scheme']==='dark', resolveResource: allowedAsset, openLink: url => {
    let link:URL;try{link=new URL(url,window.location.href);}catch{return;}
    if(navigate&&link.origin===location.origin&&link.pathname===`/share/${shareId}`){navigate(link.searchParams.get('file')||'',link.hash);return;}
    const resource = allowedAsset(url); if (resource || /^(?:https?:|mailto:|#)/i.test(url)) window.open(resource || url, '_blank', 'noopener,noreferrer'); }, app: { getState: () => state, subscribe: () => () => {} } });
  useRunStore.setState({ records: document.results.map((result, index) => ({ ...result, key: runKey(filePath, result.code), runId: index + 1, filePath, lang: result.info.split(/\s/)[0], firstLine: '', command: '', status: 'done', exitCode: 0, segs: [], bytes: 0, truncated: false, startedAt: 0, error: null, collapsed: false, declaredOut: null, protocolError: null })) });
  useInputStore.setState({ values: Object.fromEntries(Object.entries(document.inputs).map(([key, value]) => [`${filePath} ${key}`, value])) });
  for (const [key, value] of Object.entries(document.appearance)) {
    if (/^--[a-z0-9-]+$/.test(key) && typeof value === 'string' && value.length < 500 && !/url\s*\(|[{};@]|expression\s*\(/i.test(value)) host.style.setProperty(key, value);
  }
  host.classList.add('cm-host');
  const view = new EditorView({ parent: host, state: EditorState.create({ doc: document.markdown, extensions: [
    EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping,
    markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [GFM, inlineMath, detailsBlock] }),
    syntaxParseDriver, livePreview, paragraphSoftWrap, tablePreview, htmlPreview, mathBlock, mermaidBlock, inputBlock, resultBlock, cmTheme, cmHighlighting,
  ] }) });
  // Shared pages are read-only: an ordinary click follows links, including
  // file chips whose desktop interaction otherwise only selects their source.
  const followLink=(event:MouseEvent)=>{
    if(event.button!==0||!(event.target instanceof Element))return false;
    const element=event.target.closest('[data-href],a[href],[data-resource-from],.cm-md-link');
    if(!element)return false;
    let url=element.getAttribute('data-href')||element.getAttribute('href');
    if(!url&&element.hasAttribute('data-resource-from')){
      const from=Number(element.getAttribute('data-resource-from')),to=Number(element.getAttribute('data-resource-to'));
      url=resourceReferences(view.state.sliceDoc(from,to))[0]?.source||element.querySelector('img')?.getAttribute('src')||null;
    }
    if(!url&&element.classList.contains('cm-md-link')){
      const pos=view.posAtDOM(element);
      for(let node=syntaxTree(view.state).resolveInner(pos,1);node;){
        if(node.name==='Link'||node.name==='Autolink'){
          const urls=node.getChildren('URL'),destination=urls.find(url=>url.prevSibling?.name==='LinkMark'&&view.state.sliceDoc(url.prevSibling.from,url.prevSibling.to)==='(')||urls[0];
          url=destination?view.state.sliceDoc(destination.from,destination.to):null;break;
        }
        if(!node.parent)break;node=node.parent;
      }
    }
    if(url){event.preventDefault();event.stopPropagation();renderRuntime.openLink(url);return true;}
    return false;
  };
  let openedOnPress=false;
  const press=(event:MouseEvent)=>{openedOnPress=followLink(event);};
  const click=(event:MouseEvent)=>{if(openedOnPress){openedOnPress=false;event.preventDefault();event.stopPropagation();}else followLink(event);};
  host.addEventListener('mousedown',press,true);
  host.addEventListener('click',click,true);
  view.dispatch({ effects: defaultComponentFoldEffects(view.state) });
  return () => { host.removeEventListener('mousedown',press,true); host.removeEventListener('click',click,true); view.destroy(); useRunStore.setState({ records: [] }); useInputStore.setState({ values: {} }); };
}
