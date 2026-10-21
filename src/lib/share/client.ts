import { tr } from '../../i18n/core';
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { fetch as nativeFetch } from '../ai/http';
import { basename, dirname } from '../fs';
import { useAppStore } from '../../store/useAppStore';
import { editorFontStack } from '../../store/useAppStore';
import { useRunStore } from '../../store/useRunStore';
import { useInputStore } from '../../store/useInputStore';
import { scanInputBlocks, resolvePath, isInside } from '../inputs/sources';
import { Text } from '@codemirror/state';
import { openingFenceOf, isCloseFenceFor } from '../codeRun/fenceAttrs';
import { redactSecrets, stripHtmlComments, resourceReferences, replaceResources } from '../../../share-service/renderer/snapshot';
import type { ShareDocument } from '../../../share-service/renderer/viewer';
import { folderReference, folderFileUrl, type FolderDocument, type ShareSnapshot } from '../../../share-service/renderer/folder';
import type { ComponentResult } from '../codeRun/resultProtocol';

export interface ShareConfig { url: string; key: string; associations: Record<string, { service: string; id: string; kind?: 'note' | 'folder' }> }
export interface RemoteShare { id: string; title: string; status: string; version: number; bytes: number; expiresAt: number | null; updatedAt: number; kind?: 'note' | 'folder' }
export type AttachmentWarning = 'outside' | 'hidden';
// `path` is the real file after symlinks; `linked` is the path the note names when it differs.
export interface PreparedShare { document: ShareSnapshot; folder?: PreparedFolder; files: { source: string; path: string; linked?: string; name: string; size: number; mime: string; warnings: AttachmentWarning[]; bytes?: number[]; reviewOnly?: boolean }[]; removedComments: number; contentKey: string }
const CONFIG_EVENT='idea-note-share-config';
let config: ShareConfig | null=null;
let saving=Promise.resolve();
export async function loadShareConfig(force=false):Promise<ShareConfig> {
  if(config&&!force)return config;
  const data=JSON.parse(await invoke<string>('share_config_load'));
  return config={url:data.url||'',key:data.key||'',associations:data.associations||{}};
}
export async function saveShareConfig(value:ShareConfig):Promise<void> {
  // Native save merges per-path updates under a lock; another window cannot
  // overwrite associations while settings changes the service credentials.
  saving=saving.catch(()=>{}).then(async()=>{
    await invoke('share_config_save',{json:JSON.stringify(value)}); config=value; await emit(CONFIG_EVENT);
  });
  return saving;
}
export async function setAssociation(path:string,id:string,service:string,kind:'note'|'folder'='note') {
  const remote=await shareRequest<{document:ShareSnapshot}>(`shares/${id}/document`);
  if((remote.document.format===2?'folder':'note')!==kind)throw new Error(tr('分享类型不匹配'));
  await invoke('share_association_set',{path,id,service,kind}); await loadShareConfig(true); await emit(CONFIG_EVENT);
}
export async function remapShareAssociations(from:string,to:string) { await invoke('share_associations_remap',{from,to}); config=null; await emit(CONFIG_EVENT); }
export async function watchShareConfig(callback:()=>void) {return listen(CONFIG_EVENT,()=>{config=null;callback();});}
const invalidServiceUrl=()=>new Error(tr('分享服务地址必须是 HTTPS 根地址（本地开发可使用 HTTP）'));
export function serviceUrl(value:string) {
  let url:URL;
  try{url=new URL(value.trim());}catch{throw invalidServiceUrl();}
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||(!['https:'].includes(url.protocol)&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw invalidServiceUrl();
  return url.origin;
}
export async function shareRequest<T>(path:string,init?:RequestInit,provided?:ShareConfig):Promise<T> {
  const settings=provided||await loadShareConfig();
  if(!settings.url||!settings.key)throw new Error(tr('请先在设置中配置分享服务地址与发布密钥'));
  const origin=serviceUrl(settings.url),key=settings.key.trim();
  if(!key||!/^[\x21-\x7e]+$/.test(key))throw new Error(tr('发布密钥格式不正确，请重新复制完整密钥'));
  let response:Response;
  try{
    response=await nativeFetch(origin+'/api/v1/'+path,{method:init?.method||'GET',headers:{Authorization:`Bearer ${key}`,...(init?.headers as Record<string,string>||{})},body:init?.body});
  }catch{
    throw new Error(tr('无法连接分享服务（{{0}}），请确认服务已启动且地址可访问。',{0:origin}));
  }
  let body:string;
  try{body=await response.text();}catch{
    throw new Error(tr('读取分享服务响应失败（HTTP {{0}}），请检查连接后重试。',{0:response.status}));
  }
  // Parse text explicitly so empty or proxy HTML responses get actionable
  // errors instead of platform-specific Response.json() SyntaxErrors.
  let data:unknown;
  try{data=JSON.parse(body);}catch{
    throw new Error(tr('分享服务返回了非 JSON 响应（HTTP {{0}}），请检查服务地址和反向代理配置。',{0:response.status}));
  }
  if(!response.ok){
    const message=data&&typeof data==='object'&&'error' in data&&typeof data.error==='string'?data.error:`HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}
export async function listShares():Promise<RemoteShare[]> {
  const rows=await shareRequest<RemoteShare[]>('shares'),config=await loadShareConfig();
  if(!Array.isArray(rows)||rows.some(share=>!share||typeof share.id!=='string'||typeof share.title!=='string'||typeof share.status!=='string'||!Number.isFinite(share.version)||!Number.isFinite(share.bytes)||!Number.isFinite(share.updatedAt)))throw new Error(tr('分享服务返回的分享列表格式不正确，请确认服务地址和版本。'));
  return rows.map(share=>{
    const binding=Object.values(config.associations).find(binding=>binding.service===config.url&&binding.id===share.id);
    return {...share,kind:share.kind||(binding?(binding.kind||'note'):undefined)};
  });
}
export const revokeShare=(id:string)=>shareRequest(`shares/${id}`,{method:'DELETE'});
export const mimeOf=(name:string)=>({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',svg:'image/svg+xml',webp:'image/webp',avif:'image/avif',bmp:'image/bmp',pdf:'application/pdf'}[name.split('.').pop()?.toLowerCase()||'']||'application/octet-stream');
const APPEARANCE_KEYS=['--bg','--bg-elev','--text','--text-muted','--border','--accent','--heading','--hover','--selection','--editor-font-family','--editor-font-size','--editor-font-weight','--editor-strong-font-weight','--editor-line-height','--editor-heading-scale','--inline-code-bg','--text-soft','--active','--code-bg','--code-text','--shadow'];
function codeBodies(markdown:string) {
  const doc=Text.of(markdown.split('\n')),out=new Set<string>();
  for(let i=1;i<=doc.lines;i++){
    const opening=openingFenceOf(doc.line(i).text);if(!opening)continue;
    let end=i+1;while(end<=doc.lines&&!isCloseFenceFor(doc.line(end).text,opening))end++;
    if(end<=doc.lines&&end>i+1)out.add(doc.sliceString(doc.line(i+1).from,doc.line(end-1).to)); i=end;
  }
  return out;
}
// A note or template from someone else can reference ~/.ssh or a workspace
// .env; such attachments need the user's explicit approval before upload.
export function attachmentWarnings(root:string,target:string):AttachmentWarning[] {
  const inside=isInside(root,target),base=(resolvePath(null,root)||root).replace(/\/$/,'');
  const warnings:AttachmentWarning[]=inside?[]:['outside'];
  if((inside?target.slice(base.length):target).split('/').some(segment=>segment.startsWith('.')))warnings.push('hidden');
  return warnings;
}
export async function prepareShare(path:string,content:string,title:string,days:number,existingExpiry:number|null=null,collectFiles=true):Promise<PreparedShare> {
  const {markdown,removed}=stripHtmlComments(redactSecrets(content)),doc=Text.of(markdown.split('\n')),bodies=codeBodies(markdown);
  const state=useAppStore.getState(),css=getComputedStyle(document.documentElement),root=state.workspacePath??dirname(path);
  const appearance=Object.fromEntries(APPEARANCE_KEYS.map(k=>[k,css.getPropertyValue(k).trim()]).filter(([,v])=>v));
  appearance['--editor-font-family']=editorFontStack(state.editorFontFamily);
  appearance['--share-color-scheme']=document.documentElement.classList.contains('dark')?'dark':'light';
  const fileValues: {source:string;name:string}[]=[];
  const inputs=Object.fromEntries(scanInputBlocks(doc).map(block=>{
    const overrides=useInputStore.getState().values[`${path} ${block.id}`]||{};
    return [block.id,Object.fromEntries(block.schema.fields.map(field=>{
      const value=overrides[field.name]??field.value;
      if(field.type==='file'&&typeof value==='string') { const name=basename(value);fileValues.push({source:value,name});return[field.name,name]; }
      return[field.name,value];
    }))];
  }));
  const results=useRunStore.getState().records.filter(r=>r.filePath===path&&r.status==='done'&&r.exitCode===0&&r.componentResult&&bodies.has(r.code)).map(r=>({code:r.code,info:r.info,componentResult:structuredClone(r.componentResult),inputs:null,inputSummary:fileValues.reduce((summary,file)=>file.source?summary.split(file.source).join(file.name):summary,r.inputSummary),ms:r.ms}));
  const snapshot:ShareDocument={format:1,title,markdown,expiresAt:days<0?existingExpiry:(days?Date.now()+days*86400000:null),assets:[],appearance,inputs,results};
  if(!collectFiles)return {document:snapshot,files:[],removedComments:removed,contentKey:path+'\0'+content};
  const refs=resourceReferences(markdown).map(r=>r.source);
  for(const result of results) {
    const value=result.componentResult;
    if(value?.type==='image') refs.push(...(Array.isArray(value.data)?value.data:[value.data]));
    if(value?.type==='markdown'||value?.type==='html')refs.push(...resourceReferences(String(value.data)).map(r=>r.source));
  }
  const files:PreparedShare['files']=[];
  for(const source of new Set(refs)){
    if(/^(https?:|data:|#|mailto:)/i.test(source))continue;
    if(/^(asset:|tauri:|blob:|javascript:)/i.test(source)||source.includes('asset.localhost'))throw new Error(`无法分享临时或应用资源，请改用本地文件引用：${source}`);
    let decoded=source;try{decoded=decodeURIComponent(source);}catch{/* retain literal percent */}
    if (/\.(?:md|markdown)(?:[#?].*)?$/i.test(decoded)) throw new Error(`本地笔记链接不会自动分享，请替换为该笔记的分享链接：${source}`);
    const target=resolvePath(path,decoded);if(!target)throw new Error(`无法解析附件：${source}`);
    // Check both the named path and the real file: a workspace link can point
    // at ~/.ssh, and a linked workspace must not flag its own files.
    const stats=await invoke<{size:number;path:string;root:string}>('share_resource_stat',{path:target,root});
    const real=resolvePath(null,stats.path)||stats.path,found=[...attachmentWarnings(root,target),...attachmentWarnings(resolvePath(null,stats.root)||stats.root,real)];
    const warnings=(['outside','hidden'] as const).filter(w=>found.includes(w));
    files.push({source,path:stats.path,...(real!==target?{linked:target}:{}),name:basename(real),size:stats.size,mime:mimeOf(real),warnings});
  }
  return {document:snapshot,files,removedComments:removed,contentKey:path+'\0'+content};
}
export async function publishShare(prepared:PreparedShare,current?:RemoteShare,approved:ReadonlySet<string>=new Set()):Promise<RemoteShare> {
  const unapproved=prepared.files.find(f=>f.warnings.length&&!approved.has(f.path));
  if(unapproved)throw new Error(`附件位于工作区之外或为隐藏文件，需确认后才能上传：${unapproved.path}`);
  if(prepared.folder)await validateFolderPreview(prepared);
  const stage=await shareRequest<{id:string;shareId:string}>('uploads',{method:'POST',body:JSON.stringify({shareId:current?.id,version:current?.version}),headers:{'Content-Type':'application/json'}});
  const urls=new Map<string,string>(),assets:string[]=[],uploaded=new Map<string,string>();
  for(const file of prepared.files){
    if(file.reviewOnly)continue;
    const existing=uploaded.get(file.path+'\0'+file.mime);if(existing){urls.set(file.source,existing);continue;}
    const bytes=file.bytes??await invoke<number[]>('share_resource_read',{path:file.path});
    const asset=await shareRequest<{id:string;url:string}>(`uploads/${stage.id}/assets`,{method:'POST',body:new Uint8Array(bytes),headers:{'Content-Type':file.mime,'X-File-Name':encodeURIComponent(file.name)}});
    assets.push(asset.id);urls.set(file.source,asset.url);uploaded.set(file.path+'\0'+file.mime,asset.url);
  }
  const snapshot=structuredClone(prepared.document);
  snapshot.assets=assets;
  const rewrite=(note:Pick<ShareDocument,'markdown'|'results'>,mapping:Map<string,string>)=>{
  note.markdown=replaceResources(note.markdown,resourceReferences(note.markdown),mapping);
  for(const result of note.results){
    const value=result.componentResult as ComponentResult;
    if(value.type==='image')value.data=Array.isArray(value.data)?value.data.map(src=>mapping.get(src)||src):(mapping.get(value.data)||value.data);
    if(value.type==='markdown'||value.type==='html')value.data=replaceResources(String(value.data),resourceReferences(String(value.data)),mapping);
  }
  };
  if(snapshot.format===1)rewrite(snapshot,urls);
  else {
    const entries=new Map(snapshot.entries.map(entry=>[entry.path,entry]));
    for(const entry of snapshot.entries){
      if(entry.kind==='file')entry.asset=urls.get(entry.asset)!;
    }
    for(const entry of snapshot.entries){
      if(entry.kind!=='markdown')continue;
      const mapping=new Map<string,string>();
      for(const source of noteReferences(entry.content)){
        const target=folderReference(entry.path,source),found=target&&entries.get(target.path);
        const external=urls.get(`${entry.path}\0${source}`);
        mapping.set(source,external||(found?.kind==='file'?found.asset+(target?.suffix||''):folderFileUrl(stage.shareId,target?.path||'__unavailable__',target?.suffix)));
      }
      rewrite(entry.content,mapping);
    }
  }
  if(new TextEncoder().encode(JSON.stringify(snapshot)).length>5*1048576)throw new Error(tr('分享正文超过 5 MB'));
  return shareRequest<RemoteShare>(`uploads/${stage.id}/commit`,{method:'POST',body:JSON.stringify(snapshot),headers:{'Content-Type':'application/json'}});
}
export const defaultShareTitle=(path:string)=>basename(path).replace(/\.(md|markdown)$/i,'');

export interface FolderOptions { includeHidden: boolean; includeSymlinks: boolean }
interface ScanEntry { kind:'file'|'directory'; relative:string; path:string; real:string; warnings:AttachmentWarning[]; bytes?:number[]; text?:string|null }
interface FolderScan { entries:ScanEntry[]; excluded:{path:string;reason:string}[] }
interface PreparedFolder { path:string; options:FolderOptions; scan:FolderScan; active?:{path:string;content:string} }
const scanFolder=(path:string,options:FolderOptions)=>invoke<FolderScan>('share_folder_scan',{path,...options});
function noteReferences(note:Pick<ShareDocument,'markdown'|'results'>) {
  const refs=resourceReferences(note.markdown).map(r=>r.source);
  for(const result of note.results){
    const value=result.componentResult;
    if(value?.type==='image')refs.push(...(Array.isArray(value.data)?value.data:[value.data]));
    if(value?.type==='markdown'||value?.type==='html')refs.push(...resourceReferences(String(value.data)).map(r=>r.source));
  }
  return [...new Set(refs)].filter(source=>! /^(https?:|data:|#|mailto:)/i.test(source));
}
export async function prepareFolderShare(path:string,title:string,days:number,options:FolderOptions,existingExpiry:number|null=null):Promise<PreparedShare> {
  const scan=await scanFolder(path,options),state=useAppStore.getState();
  const first=await prepareShare(path+'/README.md','',title,days,existingExpiry,false);
  const document:FolderDocument={format:2,title,expiresAt:first.document.expiresAt,appearance:first.document.appearance,assets:[],entries:[]};
  const prepared:PreparedShare={document,files:[],removedComments:0,contentKey:'',folder:{path,options:{...options},scan}};
  const byName=new Map(scan.entries.map(entry=>[entry.relative,entry]));
  const names=new Set(byName.keys());
  for(const entry of scan.entries){
    if(entry.kind==='directory')document.entries.push({kind:'directory',path:entry.relative});
    else if(/\.(md|markdown)$/i.test(entry.relative)){
      const content=state.activeFilePath===entry.path?state.content:entry.text!;
      if(state.activeFilePath===entry.path)prepared.folder!.active={path:entry.path,content};
      const note=await prepareShare(entry.path,content,basename(entry.relative),days,existingExpiry,false);
      if(note.document.format!==1)throw new Error('Invalid note');
      const {markdown,inputs,results}=note.document;
      document.entries.push({kind:'markdown',path:entry.relative,content:{markdown,inputs,results}});
      prepared.removedComments+=note.removedComments;
    } else document.entries.push({kind:'file',path:entry.relative,asset:entry.relative,mime:mimeOf(entry.relative),size:entry.bytes!.length});
    // Include Markdown and directories in sensitive-path review without uploading their raw bytes.
    const reviewOnly=entry.kind==='directory'||/\.(md|markdown)$/i.test(entry.relative);
    if(!reviewOnly||entry.warnings.length)prepared.files.push({source:entry.relative,path:entry.real,linked:entry.path!==entry.real?entry.path:undefined,name:basename(entry.relative),mime:mimeOf(entry.relative),size:entry.bytes?.length||0,warnings:entry.warnings,bytes:reviewOnly?undefined:entry.bytes,reviewOnly});
  }
  for(const entry of document.entries){
    if(entry.kind!=='markdown')continue;
    const original=byName.get(entry.path)!;
    for(const source of noteReferences(entry.content)){
      const target=folderReference(entry.path,source);
      if(target&&names.has(target.path))continue;
      let decoded=source.split(/[?#]/)[0];try{decoded=decodeURIComponent(decoded);}catch{/* literal */}
      const absolute=resolvePath(original.path,decoded);
      // Missing/excluded entries inside the root remain unavailable; never implicitly include them.
      if(!absolute||isInside(path,absolute)||/\.(md|markdown)$/i.test(decoded))continue;
      if(/^(asset:|tauri:|blob:|javascript:)/i.test(source))throw new Error(`无法分享临时或应用资源：${source}`);
      const stat=await invoke<{size:number;path:string;root:string}>('share_resource_stat',{path:absolute,root:path});
      const warnings=[...new Set([...attachmentWarnings(path,absolute),...attachmentWarnings(stat.root,stat.path)])];
      const bytes=await invoke<number[]>('share_resource_read',{path:stat.path});
      prepared.files.push({source:`${entry.path}\0${source}`,path:stat.path,linked:absolute,name:basename(stat.path),size:bytes.length,mime:mimeOf(stat.path),warnings,bytes});
    }
  }
  const limits=await shareRequest<{settings:{maxAssetBytes:number;maxShareBytes:number}}>('me');
  const unique=new Map(prepared.files.filter(file=>!file.reviewOnly).map(file=>[file.path+'\0'+file.mime,file]));
  if([...unique.values()].some(file=>file.size>limits.settings.maxAssetBytes))throw new Error(tr('文件超过分享服务的单附件大小限制'));
  const bodySize=new TextEncoder().encode(JSON.stringify(document)).length;
  if(bodySize>5*1048576||bodySize+[...unique.values()].reduce((sum,file)=>sum+file.size,0)>limits.settings.maxShareBytes)throw new Error(tr('文件夹超过分享服务的大小限制'));
  return prepared;
}
async function validateFolderPreview(prepared:PreparedShare){
  const folder=prepared.folder!,latest=await scanFolder(folder.path,folder.options),before=folder.scan;
  const changed=()=>{throw new Error(tr('文件夹内容已修改，请重新预览'));};
  if(JSON.stringify(latest.excluded)!==JSON.stringify(before.excluded)||latest.entries.length!==before.entries.length)changed();
  for(let i=0;i<before.entries.length;i++){
    const a=before.entries[i],b=latest.entries[i];
    if(a.kind!==b.kind||a.relative!==b.relative||a.real!==b.real||JSON.stringify(a.warnings)!==JSON.stringify(b.warnings)||a.bytes?.length!==b.bytes?.length||a.bytes?.some((byte,index)=>byte!==b.bytes![index]))changed();
  }
  const state=useAppStore.getState();
  if(folder.active&&(state.activeFilePath!==folder.active.path||state.content!==folder.active.content))changed();
  if(!folder.active&&state.activeFilePath&&state.isDirty&&before.entries.some(entry=>entry.path===state.activeFilePath))changed();
  for(const file of prepared.files){
    if(file.reviewOnly||!file.source.includes('\0'))continue;
    const stat=await invoke<{path:string}>('share_resource_stat',{path:file.linked||file.path,root:folder.path});
    if(stat.path!==file.path)changed();
    const bytes=await invoke<number[]>('share_resource_read',{path:file.path});
    if(bytes.length!==file.bytes!.length||bytes.some((byte,index)=>byte!==file.bytes![index]))changed();
  }
}
