import { createPortal } from "react-dom";
import { useEffect, useState } from 'react';
import { Share2, X, RefreshCw, Copy, ExternalLink } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { tr } from '../i18n/core';
import { useLanguage } from '../i18n/react';
import { useAppStore } from '../store/useAppStore';
import { copyText } from '../lib/clipboard';
import { loadShareConfig, saveShareConfig, shareRequest, listShares, revokeShare, prepareShare, prepareFolderShare, publishShare, setAssociation, watchShareConfig, serviceUrl, defaultShareTitle, type RemoteShare, type PreparedShare, type ShareConfig, type AttachmentWarning } from '../lib/share/client';
import type { NoteContent } from '../../share-service/renderer/folder';
import './sharing.css';

const size=(n:number)=>`${(n/1048576).toFixed(2)} MB`;
const warningLabel=(w:AttachmentWarning)=>w==='outside'?tr('位于工作区之外'):tr('隐藏文件或目录');
export function SharingSettings() {
  useLanguage();
  const [value,setValue]=useState<ShareConfig>({url:'',key:'',associations:{}}),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  useEffect(()=>{void loadShareConfig(true).then(setValue).catch(e=>setError(e.message));},[]);
  const act=async(test:boolean)=>{setBusy(true);setError('');setMessage('');try{
    const next={...value,url:serviceUrl(value.url.trim()),key:value.key.trim()};
    if(test){await shareRequest('me',undefined,next);setMessage(tr('连接成功，发布密钥有效'));}
    else{await saveShareConfig(next);setValue(next);setMessage(tr('分享服务设置已保存'));}
  }catch(e){setError(String(e));}finally{setBusy(false);}};
  return <section className="sharing-settings"><h2>{tr('分享服务')}</h2><p>{tr('配置自建分享服务。发布密钥由服务管理员签发，读者凭链接即可访问。')}</p><label>{tr('服务地址')}<input placeholder="https://share.example.com" value={value.url} onChange={e=>setValue({...value,url:e.target.value})} /></label><label>{tr('发布密钥')}<input type="password" autoComplete="off" placeholder="inshare_…" value={value.key} onChange={e=>setValue({...value,key:e.target.value})}/></label><p>{tr('密钥仅保存在当前设备的应用配置目录，不会写入笔记。')}</p><div className="sharing-actions"><button disabled={busy} onClick={()=>void act(true)}>{tr('检测连接')}</button><button className="sharing-primary" disabled={busy} onClick={()=>void act(false)}>{tr('保存')}</button>{value.url&&<button onClick={()=>{try{void openUrl(serviceUrl(value.url)+'/admin');}catch(e){setError(String(e));}}}>{tr('管理后台')}</button>}</div>{message&&<p role="status">{message}</p>}{error&&<p className="sharing-error" role="alert">{error}</p>}</section>;
}
export function ShareButton() {
  useLanguage();
  const [open,setOpen]=useState(false);
  return <><button className="sharing-entry" title={tr('链接分享')} onMouseDown={e=>e.stopPropagation()} onClick={()=>setOpen(true)}><Share2 size={14}/><span>{tr('分享')}</span></button>{open&&createPortal(<ShareDialog onClose={()=>setOpen(false)}/>,document.body)}</>;
}
export function ShareDialog({onClose,folderPath}:{onClose():void;folderPath?:string}) {
  useLanguage();
  const activePath=useAppStore(s=>s.activeFilePath)||'',path=folderPath||activePath,kind=folderPath?'folder':'note',content=useAppStore(s=>s.content),openSettings=useAppStore(s=>s.openSettings);
  const [config,setConfig]=useState<ShareConfig>(),[shares,setShares]=useState<RemoteShare[]>([]),[current,setCurrent]=useState<RemoteShare>(),[title,setTitle]=useState(folderPath?path.split(/[/\\]/).filter(Boolean).pop()||path:defaultShareTitle(path)),[days,setDays]=useState(0);
  const [prepared,setPrepared]=useState<PreparedShare>(),[error,setError]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[tab,setTab]=useState<'publish'|'manage'>('publish');
  const [ready,setReady]=useState(false);
  const [includeHidden,setIncludeHidden]=useState(false),[includeSymlinks,setIncludeSymlinks]=useState(false);
  const notes:({path:string;content:NoteContent})[]=prepared?(prepared.document.format===1?[{path,content:prepared.document}]:prepared.document.entries.flatMap(entry=>entry.kind==='markdown'?[{path:entry.path,content:entry.content}]:[])):[];
  // Approvals belong to one preview; preparing again starts with none.
  const [approval,setApproval]=useState<{prepared:PreparedShare;paths:ReadonlySet<string>}>();
  const approved=approval&&approval.prepared===prepared?approval.paths:new Set<string>();
  const flagged=prepared?.files.filter(f=>f.warnings.length)||[],pending=flagged.filter(f=>!approved.has(f.path)).length;
  const approve=(path:string,yes:boolean)=>{if(!prepared)return;const paths=new Set(approved);if(yes)paths.add(path);else paths.delete(path);setApproval({prepared,paths});};
  const refresh=async()=>{
    setReady(false);
    const cfg=await loadShareConfig(true);setConfig(cfg);
    if(cfg.url&&cfg.key){const rows=await listShares();setShares(rows);const binding=cfg.associations[path];setCurrent(binding?.service===cfg.url&&(binding.kind||'note')===kind?rows.find(s=>s.id===binding.id&&(!s.kind||s.kind===kind)):undefined);}
    else{setShares([]);setCurrent(undefined);}
    setReady(true);setError('');
  };
  useEffect(()=>{void refresh().catch(e=>setError(String(e)));let off:(()=>void)|undefined;void watchShareConfig(()=>void refresh().catch(e=>setError(String(e)))).then(value=>off=value);return()=>off?.();},[path]);
  useEffect(()=>{setPrepared(undefined);},[path,content,title,days,includeHidden,includeSymlinks]);
  useEffect(()=>{setTitle(folderPath?path.split(/[/\\]/).filter(Boolean).pop()||path:defaultShareTitle(path));setDays(0);},[path]);
  useEffect(()=>{if(current){setTitle(current.title);setDays(-1);}},[current?.id]);
  useEffect(()=>{const close=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!busy)onClose();};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[busy,onClose]);
  const act=async(action:()=>Promise<void>)=>{setBusy(true);setError('');setMessage('');try{await action();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const shareLink=(s:RemoteShare)=>config?serviceUrl(config.url)+'/share/'+s.id:'';
  const cancel=(s:RemoteShare)=>void act(async()=>{await revokeShare(s.id);setPrepared(undefined);await refresh();setMessage(tr('分享已取消，链接与附件已停止访问'));});
  const active=current?.status==='active';
  return <div className="sharing-overlay" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}><section role="dialog" aria-modal="true" aria-labelledby="sharing-title" className="sharing-dialog"><header><h2 id="sharing-title"><Share2 size={18}/>{tr('链接分享')}</h2><button aria-label={tr('关闭')} disabled={busy} onClick={onClose}><X size={18}/></button></header>
    <nav className="sharing-actions"><button aria-pressed={tab==='publish'} onClick={()=>setTab('publish')}>{folderPath?tr('当前文件夹'):tr('当前笔记')}</button><button aria-pressed={tab==='manage'} onClick={()=>setTab('manage')}>{tr('我的分享')}</button><button disabled={busy} onClick={()=>void act(refresh)} title={tr('刷新')}><RefreshCw size={14}/></button></nav>
    {error&&<p className="sharing-error" role="alert">{error}</p>}{message&&<p className="sharing-message" role="status">{message}</p>}
    {!config?.url||!config.key?<div className="sharing-empty"><p>{tr('请先配置分享服务地址与发布密钥')}</p><button onClick={()=>{onClose();void openSettings('sharing');}}>{tr('打开分享设置')}</button></div>:tab==='publish'?<>
      {current&&<div className="sharing-link"><strong>{current.title}</strong><small>{tr('状态')}：{current.status} · {tr('版本')} {current.version}</small><a href="#" onClick={e=>{e.preventDefault();void openUrl(shareLink(current));}}>{shareLink(current)}</a><div className="sharing-actions"><button onClick={()=>void copyText(shareLink(current))}><Copy size={13}/>{tr('复制链接')}</button><button onClick={()=>void openUrl(shareLink(current))}><ExternalLink size={13}/>{tr('打开链接')}</button>{active&&<button className="sharing-danger" disabled={busy} onClick={()=>cancel(current)}>{tr('取消分享')}</button>}</div></div>}
      <label>{tr('分享标题')}<input maxLength={300} value={title} onChange={e=>setTitle(e.target.value)} disabled={busy}/></label><label>{tr('有效期')}<select value={days} disabled={busy} onChange={e=>setDays(Number(e.target.value))}>{current&&<option value={-1}>{tr('保持原有效期')}</option>}{[0,1,7,30].map(d=><option key={d} value={d}>{d?tr('{{0}} 天',{0:d}):tr('永久')}</option>)}</select></label>
      {folderPath&&<div><label className="sharing-option"><input type="checkbox" disabled={busy} checked={includeHidden} onChange={e=>setIncludeHidden(e.target.checked)}/>{tr('包含隐藏文件和目录')}</label><label className="sharing-option"><input type="checkbox" disabled={busy} checked={includeSymlinks} onChange={e=>setIncludeSymlinks(e.target.checked)}/>{tr('包含符号链接指向的内容')}</label><p>{tr('文件夹修改后需手动更新分享，新增、修改和删除会一起更新。')}</p></div>}
      <p>{tr('修改笔记后需手动更新分享。加密内容会替换为占位，网页不会执行代码。')}</p>
      {!prepared?<button className="sharing-primary" disabled={busy||!ready||!title.trim()} onClick={()=>void act(async()=>setPrepared(folderPath?await prepareFolderShare(path,title.trim(),days,{includeHidden,includeSymlinks},current?.expiresAt):await prepareShare(path,content,title.trim(),days,current?.expiresAt)))}>{busy?tr('准备中…'):tr('预览待分享内容')}</button>:<div className="sharing-review"><h3>{tr('待分享内容')}</h3><p>{prepared.files.filter(file=>!file.reviewOnly).length} {tr('个附件')} · {size(prepared.files.reduce((n,f)=>n+f.size,0))} · {notes.reduce((sum,note)=>sum+note.content.results.length,0)} {tr('个结果快照')}</p><p>{tr('以下 Markdown 源码、附件、参数快照和结果快照都会公开，读者可查看并复制源码。')}</p>{prepared.removedComments>0&&<p>{tr('已从发布内容中移除 {{0}} 处 HTML 注释。',{0:prepared.removedComments})}</p>}{prepared.document.format===2&&<details open><summary>{tr('文件夹目录')} · {prepared.document.entries.filter(entry=>entry.kind!=='directory').length} {tr('个文件')}</summary><ul className="sharing-manifest">{prepared.document.entries.map(entry=><li key={entry.path}><code>{entry.kind==='directory'?'📁 ':'📄 '}{entry.path}</code></li>)}</ul></details>}{prepared.folder&&prepared.folder.scan.excluded.length>0&&<details><summary>{tr('已排除的项目')} · {prepared.folder.scan.excluded.length}</summary><ul>{prepared.folder.scan.excluded.map(entry=><li key={entry.path}><code>{entry.path}</code> · {exclusionLabel(entry.reason)}</li>)}</ul></details>}{notes.map(note=><NoteReview key={note.path} path={note.path} content={note.content}/>)}{flagged.length>0&&<p className="sharing-error" role="alert">{tr('{{0}} 个附件位于工作区之外或属于隐藏文件，可能包含密钥等敏感信息。请核对完整路径，逐一确认后才能发布。',{0:flagged.length})}</p>}{prepared.files.length>0&&<ul className="sharing-files">{prepared.files.map(f=><li key={f.source} className={f.warnings.length?'sharing-flagged':undefined}><code>{f.path}</code>{f.linked&&<small>{tr('经符号链接：{{0}}',{0:f.linked})}</small>}<small>{size(f.size)} · {tr('笔记中的引用')}：{f.source.replace('\0',' → ')}</small>{f.warnings.length>0&&<label className="sharing-confirm"><input type="checkbox" checked={approved.has(f.path)} disabled={busy} onChange={e=>approve(f.path,e.target.checked)}/>{f.warnings.map(warningLabel).join(' · ')} · {tr('确认上传此文件')}</label>}</li>)}</ul>}<div className="sharing-actions"><button className="sharing-primary" disabled={busy||!ready||pending>0} onClick={()=>void act(async()=>{
        if(!folderPath&&prepared.contentKey!==path+'\0'+useAppStore.getState().content)throw new Error(tr('笔记已修改，请重新预览'));
        const result=await publishShare(prepared,active?current:undefined,approved);await setAssociation(path,result.id,serviceUrl(config.url),kind);await refresh();setPrepared(undefined);setMessage(tr('分享已发布，可复制链接发送给他人'));
      })}>{busy?tr('正在上传…'):tr(active?'更新分享':'发布分享')}</button><button disabled={busy} onClick={()=>setPrepared(undefined)}>{tr('重新准备')}</button></div></div>}
      {current?.status==='hidden'&&<p className="sharing-error">{tr('当前分享已被管理员下架，请联系管理员。')}</p>}
    </>:<div className="sharing-list">{!shares.length&&<p>{tr('暂无分享')}</p>}{shares.map(s=><article key={s.id}><div><strong>{s.title}</strong><small>{s.status} · {new Date(s.updatedAt).toLocaleString()} · {size(s.bytes)}</small></div><div className="sharing-actions"><button onClick={()=>void copyText(shareLink(s))}>{tr('复制链接')}</button><button onClick={()=>void openUrl(shareLink(s))}>{tr('打开')}</button>{s.status==='active'&&<>{(!s.kind||s.kind===kind)&&<button disabled={busy} onClick={()=>void act(async()=>{await setAssociation(path,s.id,serviceUrl(config.url),kind);await refresh();setPrepared(undefined);setTab('publish');})}>{folderPath?tr('关联当前文件夹'):tr('关联当前笔记')}</button>}<button className="sharing-danger" disabled={busy} onClick={()=>cancel(s)}>{tr('取消分享')}</button></>}</div></article>)}</div>}
  </section></div>;
}

function exclusionLabel(reason:string){
  return {system:tr('系统项目'),hidden:tr('隐藏文件或目录'),symlink:tr('符号链接'),cycle:tr('循环符号链接'),special:tr('特殊文件')}[reason]||reason;
}
function NoteReview({path,content}:{path:string;content:NoteContent}){
  return <details open><summary>{path}</summary><details open><summary>Markdown</summary><pre>{content.markdown}</pre></details>
    {Object.keys(content.inputs).length>0&&<details><summary>{tr('参数快照')}</summary><pre>{JSON.stringify(content.inputs,null,2)}</pre></details>}
    {content.results.map((result,index)=><details key={index}><summary>{tr('结果快照')} {index+1} · {result.info}</summary><pre>{JSON.stringify(result.componentResult,null,2)}</pre></details>)}
  </details>;
}
