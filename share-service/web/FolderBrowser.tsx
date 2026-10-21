import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, File, FileText, Folder, Download, Menu } from 'lucide-react';
import { mountShareViewer, type ShareDocument } from '../renderer/viewer';
import { defaultFolderFile, folderFileUrl, imageMime, textFile, type FolderDocument, type FolderEntry, type ShareSnapshot } from '../renderer/folder';
import { tr } from '../renderer/i18n/core';

function NoteViewer({ document, shareId, adminPreview, navigate }: { document: ShareDocument; shareId: string; adminPreview: boolean; navigate?: (path:string,hash:string)=>void }) {
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>ref.current?mountShareViewer(ref.current,document,shareId,adminPreview,navigate):undefined,[document,shareId,adminPreview,navigate]);
  return <div ref={ref} className="document" />;
}
export function SharedViewer({ document, shareId, adminPreview=false }: {document:ShareSnapshot;shareId:string;adminPreview?:boolean}) {
  return document.format===1?<NoteViewer document={document} shareId={shareId} adminPreview={adminPreview}/>:<FolderBrowser document={document} shareId={shareId} adminPreview={adminPreview}/>;
}
function FolderBrowser({document,shareId,adminPreview}:{document:FolderDocument;shareId:string;adminPreview:boolean}) {
  const readSelection=()=>new URLSearchParams(location.search).get('file')??defaultFolderFile(document)??'';
  const [selected,setSelected]=useState(readSelection),[expanded,setExpanded]=useState<Set<string>>(new Set()),[open,setOpen]=useState(false);
  const navigate=useCallback((path:string,hash='')=>{
    const url=new URL(location.href);url.searchParams.set('file',path);url.hash=hash;
    history.pushState(null,'',url);setSelected(path);setOpen(false);
  },[]);
  useEffect(()=>{const pop=()=>{setSelected(readSelection());setOpen(false);};window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[document]);
  useEffect(()=>{setExpanded(previous=>{const next=new Set(previous),parts=selected.split('/');for(let i=1;i<parts.length;i++)next.add(parts.slice(0,i).join('/'));return next;});},[selected]);
  const entry=document.entries.find(entry=>entry.path===selected);
  const note=useMemo<ShareDocument|undefined>(()=>entry?.kind==='markdown'?{format:1,title:entry.path,...entry.content,appearance:document.appearance,assets:document.assets,expiresAt:document.expiresAt}:undefined,[entry,document]);
  const children=useMemo(()=>{
    const groups=new Map<string,FolderEntry[]>();
    for(const entry of document.entries){const parent=entry.path.split('/').slice(0,-1).join('/');const rows=groups.get(parent)||[];rows.push(entry);groups.set(parent,rows);}
    for(const rows of groups.values())rows.sort((a,b)=>Number(b.kind==='directory')-Number(a.kind==='directory')||(a.path.toLowerCase()<b.path.toLowerCase()?-1:a.path.toLowerCase()>b.path.toLowerCase()?1:(a.path<b.path?-1:a.path>b.path?1:0)));
    return groups;
  },[document]);
  function rows(parent:string,depth=0):React.ReactNode {
    return (children.get(parent)||[]).map(item=>item.kind==='directory'?<li key={item.path}>
      <button className="folder-row" style={{paddingLeft:12+depth*16}} aria-expanded={expanded.has(item.path)} onClick={()=>setExpanded(previous=>{const next=new Set(previous);if(next.has(item.path))next.delete(item.path);else next.add(item.path);return next;})}>
        {expanded.has(item.path)?<ChevronDown size={14}/>:<ChevronRight size={14}/>}<Folder size={16}/><span>{item.path.split('/').pop()}</span>
      </button>{expanded.has(item.path)&&<ul>{children.get(item.path)?.length?rows(item.path,depth+1):<li className="folder-empty">{tr('此文件夹为空')}</li>}</ul>}
    </li>:<li key={item.path}><a className={`folder-row ${selected===item.path?'selected':''}`} style={{paddingLeft:30+depth*16}} aria-current={selected===item.path?'page':undefined} href={folderFileUrl(shareId,item.path)} onClick={event=>{if(event.button||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();navigate(item.path);}}>{item.kind==='markdown'?<FileText size={16}/>:<File size={16}/>}<span>{item.path.split('/').pop()}</span></a></li>);
  }
  const noFiles=!document.entries.some(entry=>entry.kind!=='directory');
  return <div className="folder-browser">
    <button className="folder-toggle" aria-expanded={open} aria-controls="share-directory" onClick={()=>setOpen(!open)}><Menu size={16}/>{tr('目录')}</button>
    <aside id="share-directory" className={`folder-sidebar ${open?'open':''}`}><strong>{document.title}</strong><nav aria-label={tr('文件夹目录')}><ul>{rows('')}</ul></nav></aside>
    <main className="folder-content"><div className="folder-breadcrumb">{selected||document.title}</div>
      {note?<NoteViewer document={note} shareId={shareId} adminPreview={adminPreview} navigate={navigate}/>:entry?.kind==='file'?<AssetViewer key={entry.path} entry={entry} shareId={shareId} adminPreview={adminPreview}/>:<div className="empty"><p>{tr(noFiles?'此文件夹为空':'文件不存在')}</p></div>}
    </main>
  </div>;
}
function AssetViewer({entry,shareId,adminPreview}:{entry:Extract<FolderEntry,{kind:'file'}>;shareId:string;adminPreview:boolean}) {
  const url=adminPreview?entry.asset.replace(`/public/${shareId}/`,`/admin/shares/${shareId}/`):entry.asset;
  const [text,setText]=useState<string>(),[error,setError]=useState('');
  const image=imageMime(entry.mime),isText=!image&&textFile(entry.path);
  useEffect(()=>{
    if(!isText)return;
    const controller=new AbortController();
    void fetch(url,{signal:controller.signal}).then(async response=>{
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const bytes=new Uint8Array(await response.arrayBuffer());
      const bom=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':null;
      if(!bom&&bytes.slice(0,8192).includes(0))throw new Error(tr('此文件无法作为文本预览，请下载查看'));
      let decoded:string;
      try{decoded=new TextDecoder(bom||'utf-8',{fatal:true}).decode(bytes);}catch{decoded=new TextDecoder('gb18030').decode(bytes);}
      if(!controller.signal.aborted)setText(decoded);
    }).catch(error=>{if(!controller.signal.aborted)setError(String(error.message));});
    return()=>controller.abort();
  },[url,isText]);
  return <section className="shared-asset"><div className="asset-toolbar"><span>{(entry.size/1024).toFixed(1)} KB</span><a className="button" href={url} download={entry.path.split('/').pop()}><Download size={15}/>{tr('下载文件')}</a></div>
    {image?<img src={url} alt={entry.path}/>:isText?error?<p role="alert" className="error">{error}</p>:text===undefined?<p>{tr('正在加载…')}</p>:<pre>{text}</pre>:<p>{tr('此文件暂不支持预览，请下载查看')}</p>}
  </section>;
}
