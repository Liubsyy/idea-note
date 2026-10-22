import { restoreArchive } from "./restore";
import { downloadBackup } from "./backup";
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ShareSnapshot } from '../renderer/folder';
import { SharedViewer } from './FolderBrowser';
import { ShareQrDialog } from './ShareQrDialog';
import { tr } from '../renderer/i18n/core';
import './style.css';

type Share = { id: string; title: string; owner: string; version: number; status: string; bytes: number; updatedAt: number; expiresAt: number | null; kind?: 'note' | 'folder' | null };
type Publisher = { id: string; name: string; enabled: boolean; maxShares: number; maxBytes: number; expiresAt: number | null; shareCount: number; usedBytes: number };
type Settings = { allowCreate: boolean; allowUpdate: boolean; allowRead: boolean; maxAssetBytes: number; maxShareBytes: number };
type Overview = { settings: Settings; shares: {count: number; bytes: number}; storage: {bytes: number}; publishers: {count: number}; audit: {id: string; actor: string; action: string; target: string; at: number}[] };
const size = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${(value / 1024).toFixed(1)} KB`;
const date = (value: number) => new Date(value).toLocaleString();
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api/v1/' + path, { ...init, headers: { ...(init?.body instanceof File ? {} : { 'Content-Type': 'application/json' }), 'X-Share-CSRF': '1', ...init?.headers } });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || `HTTP ${response.status}`); }
  return response.json();
}
function ReadingPage() {
  const id = location.pathname.split('/')[2];
  const [data, setData] = useState<Share & {document: ShareSnapshot}>();
  const [error, setError] = useState('');
  useEffect(() => { void api<Share & {document: ShareSnapshot}>('public/' + id).then(setData).catch(e => setError(e.message)); }, [id]);
  useEffect(() => { if (data) document.title = `${data.title} · Idea Note`; }, [data]);
  const folder = data !== undefined && data.document.format !== 1;
  return <><header className={folder ? 'masthead folder-masthead' : 'masthead'}><a href="/">Idea Note <span>Share</span></a><span>{tr('文档分享')}</span></header>
    {error ? <main className="empty"><h1>{tr('分享暂不可用')}</h1><p>{error}</p></main> : data ? <>
      <div className={folder ? 'document-heading folder-heading' : 'document-heading'}><div><h1>{data.title}</h1><p>{tr('更新于')} {date(data.updatedAt)}</p></div></div>
      <SharedViewer document={data.document} shareId={id} />
      <footer>Idea Note · {tr('只读分享')}</footer></> : <main className="empty">{tr('正在加载…')}</main>}</>;
}
// The admin preview renders on its own page, framed by the console: a share's
// CSS then reaches only this page, which has no admin controls to cover or
// click through to, and its CSP blocks external images. The frame stays
// same-origin so the page can load its scripts and the cookie-protected document.
function AdminPreview() {
  const id = location.pathname.split('/')[3];
  const [data, setData] = useState<ShareSnapshot>(), [error, setError] = useState('');
  useEffect(() => { void api<ShareSnapshot>(`admin/shares/${id}/document`).then(setData).catch(e => setError(e.message)); }, [id]);
  return error ? <main className="empty"><p role="alert" className="error">{error}</p></main> : data ? <SharedViewer document={data} shareId={id} adminPreview /> : <main className="empty">{tr('正在加载…')}</main>;
}
function Admin() {
  const [loggedIn, setLoggedIn] = useState(false), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [overview, setOverview] = useState<Overview>(), [publishers, setPublishers] = useState<Publisher[]>([]), [shares, setShares] = useState<Share[]>([]);
  const [section, setSection] = useState('shares'), [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [name, setName] = useState(''), [newKey, setNewKey] = useState('');
  const [restoreProgress,setRestoreProgress]=useState('');
  const [preview, setPreview] = useState<string>();
  const [qrShareId,setQrShareId]=useState<string>();
  const qrShare=shares.find(share=>share.id===qrShareId&&share.status==='active'&&(share.expiresAt===null||share.expiresAt>Date.now()));
  async function refresh() {
    const [overview, publishers, shares] = await Promise.all([api<Overview>('admin/overview'), api<Publisher[]>('admin/publishers'), api<Share[]>(`admin/shares?q=${encodeURIComponent(query)}&offset=${offset}`)]);
    setOverview(overview); setPublishers(publishers); setShares(shares); setLoggedIn(true);
  }
  const act = async (action: () => Promise<unknown>, refreshAfter = true) => { setBusy(true); setError(''); try { await action(); if (refreshAfter) await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  useEffect(() => { void refresh().catch(() => setLoggedIn(false)); }, []);
  if (!loggedIn) return <main className="login"><div className="brand">Idea Note <span>Share</span></div><h1>{tr('服务管理')}</h1><p>{tr('使用部署时配置的管理员密码登录。')}</p><form onSubmit={event => { event.preventDefault(); void act(() => api('admin/login', { method: 'POST', body: JSON.stringify({ password }) })); setPassword(''); }}><label>{tr('管理员密码')}<input autoComplete="current-password" type="password" required value={password} onChange={e => setPassword(e.target.value)} /></label><button className="primary" disabled={busy}>{tr('登录')}</button></form>{error && <p role="alert" className="error">{error}</p>}</main>;
  return <div className="admin"><aside><div className="brand">Idea Note <span>Share</span></div><p>{tr('服务管理')}</p><nav>{[['shares','分享管理'],['keys','发布密钥'],['settings','服务设置'],['audit','操作日志'],['backup','备份迁移']].map(([id,label]) => <button key={id} className={section === id ? 'selected' : ''} onClick={() => setSection(id)}>{tr(label)}</button>)}</nav><button onClick={() => void act(async () => { await api('admin/logout', { method: 'POST' }); location.reload(); })}>{tr('退出登录')}</button></aside>
    <main><header><h1>{tr({ shares:'分享管理', keys:'发布密钥', settings:'服务设置', audit:'操作日志', backup:'备份迁移' }[section] || section)}</h1><button disabled={busy} onClick={() => void act(refresh,false)}>{tr('刷新')}</button></header>
      {error && <p role="alert" className="error">{error}</p>}
      {overview && <div className="metrics"><div><span>{tr('分享总数')}</span><strong>{overview.shares.count}</strong></div><div><span>{tr('分享内容用量')}</span><strong>{size(overview.shares.bytes)}</strong></div><div><span>{tr('附件存储用量')}</span><strong>{size(overview.storage.bytes)}</strong></div><div><span>{tr('发布者')}</span><strong>{overview.publishers.count}</strong></div></div>}
      {section === 'shares' && <><form className="actions" onSubmit={e => { e.preventDefault(); setOffset(0); void act(async () => setShares(await api<Share[]>(`admin/shares?q=${encodeURIComponent(query)}`)),false); }}><input placeholder={tr('搜索标题或分享 ID')} value={query} onChange={e => setQuery(e.target.value)} /><button>{tr('搜索')}</button></form><div className="table-wrap"><table><thead><tr>{['标题','类型','状态','大小','更新时间','操作'].map(t => <th key={t}>{tr(t)}</th>)}</tr></thead><tbody>{shares.map(s => <tr key={s.id}><td><a href={'/share/' + s.id} target="_blank" rel="noreferrer">{s.title}</a><small>{s.id}<br />{publishers.find(p => p.id === s.owner)?.name || s.owner}</small></td><td>{s.kind ? tr(s.kind === 'folder' ? '文件夹' : '笔记') : '—'}</td><td>{s.status}{s.expiresAt && <small>{tr('到期')} {date(s.expiresAt)}</small>}</td><td>{size(s.bytes)}</td><td>{date(s.updatedAt)}</td><td><div className="actions"><button disabled={busy} onClick={() => setPreview(s.id)}>{tr('预览')}</button>{s.status==='active'&&(s.expiresAt===null||s.expiresAt>Date.now())&&<button disabled={busy} onClick={()=>setQrShareId(s.id)}>{tr('二维码')}</button>}<button disabled={busy} onClick={() => void act(() => api('admin/shares/' + s.id, { method: 'PUT', body: JSON.stringify({ status: s.status === 'active' ? 'hidden' : 'active' }) }))}>{tr(s.status === 'active' ? '下架' : '恢复')}</button><button className="danger" disabled={busy} onClick={() => { if (confirm(tr('永久删除该分享？'))) void act(() => api('admin/shares/' + s.id, { method: 'DELETE' })); }}>{tr('删除')}</button></div></td></tr>)}</tbody></table></div><div className="actions"><button disabled={!offset || busy} onClick={() => { const n = Math.max(0, offset - 100); setOffset(n); void act(async () => setShares(await api<Share[]>(`admin/shares?q=${encodeURIComponent(query)}&offset=${n}`)),false); }}>{tr('上一页')}</button><button disabled={shares.length < 100 || busy} onClick={() => { const n = offset + 100; setOffset(n); void act(async () => setShares(await api<Share[]>(`admin/shares?q=${encodeURIComponent(query)}&offset=${n}`)),false); }}>{tr('下一页')}</button></div></>}
      {section === 'keys' && <><form className="actions" onSubmit={e => { e.preventDefault(); void act(async () => { const result = await api<{key: string}>('admin/publishers', { method:'POST', body:JSON.stringify({name}) }); setNewKey(result.key); setName(''); }); }}><input required maxLength={100} placeholder={tr('发布者名称')} value={name} onChange={e => setName(e.target.value)} /><button className="primary" disabled={busy}>{tr('签发密钥')}</button></form>{newKey && <div className="key-card"><strong>{tr('密钥仅显示一次，请立即保存。')}</strong><code>{newKey}</code><div className="actions"><button onClick={() => void navigator.clipboard.writeText(newKey)}>{tr('复制')}</button><button onClick={() => setNewKey('')}>{tr('关闭')}</button></div></div>}{publishers.map(p => <PublisherCard key={p.id} publisher={p} busy={busy} save={draft => act(() => api('admin/publishers/' + p.id, {method:'PUT',body:JSON.stringify(draft)}))} reset={() => void act(async () => { const result = await api<{key: string}>(`admin/publishers/${p.id}/reset`, {method:'POST'}); setNewKey(result.key); })} unpublish={() => { if (confirm(tr('下架该发布者的全部分享？'))) void act(() => api(`admin/publishers/${p.id}/unpublish`, {method:'POST'})); }} />)}</>}
      {section === 'settings' && overview && <SettingsForm value={overview.settings} busy={busy} onSave={value => void act(() => api('admin/settings', {method:'PUT', body:JSON.stringify(value)}))} />}
      {section === 'audit' && <div className="table-wrap"><table><thead><tr>{['时间','操作人','操作','对象'].map(t => <th key={t}>{tr(t)}</th>)}</tr></thead><tbody>{overview?.audit.map(a => <tr key={a.id}><td>{date(a.at)}</td><td>{a.actor}</td><td>{a.action}</td><td>{a.target}</td></tr>)}</tbody></table></div>}
      {section === 'backup' && <section className="card"><h2>{tr('备份与迁移')}</h2>{restoreProgress&&<p role="status">{restoreProgress}</p>}<p>{tr('备份包含分享、附件、密钥摘要及服务设置。妥善保管备份，管理员密码与登录会话不包含在内。恢复仅支持空实例，迁移时保留域名可保持链接。')}</p><div className="actions"><button className="primary" disabled={busy} onClick={() => void act(async () => { try { await downloadBackup(setRestoreProgress); } finally { setRestoreProgress(''); } },false)}>{tr('下载备份')}</button><label className="button">{tr('恢复备份')}<input type="file" hidden accept=".zip" disabled={busy} onChange={e => { const file=e.target.files?.[0]; if (file && confirm(tr('将备份恢复到当前空实例？'))) void act(async () => { try { await restoreArchive(file,setRestoreProgress); } finally { setRestoreProgress(''); } }); e.target.value=''; }} /></label><button disabled={busy} onClick={() => void act(() => api('admin/cleanup',{method:'POST'}))}>{tr('立即清理')}</button></div><p>{tr('清理会删除超过 24 小时未引用的上传，以及取消或到期已超过 24 小时的分享及其附件。')}</p></section>}
    </main>{qrShare&&<ShareQrDialog key={qrShare.id} share={qrShare} onClose={()=>setQrShareId(undefined)}/>}{preview && <div className="modal-overlay"><section className="preview-modal"><div className="actions"><button onClick={() => setPreview(undefined)}>{tr('关闭')}</button><small>{tr('预览不加载外部图片。')}</small></div><iframe title={tr('预览')} src={'/admin/preview/' + preview} sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" /></section></div>}</div>;
}
function PublisherCard({publisher: p, busy, save, reset, unpublish}: {publisher: Publisher; busy: boolean; save(value: Publisher): Promise<void>; reset(): void; unpublish(): void}) {
  const [draft,setDraft]=useState(p); useEffect(() => setDraft(p),[p]);
  return <form className="card" onSubmit={e => {e.preventDefault(); void save(draft);}}><div className="actions"><h2>{p.name}</h2><span>{p.shareCount} {tr('篇分享')} · {size(p.usedBytes)}</span></div><div className="fields"><label>{tr('名称')}<input required value={draft.name} onChange={e => setDraft({...draft,name:e.target.value})} /></label><label>{tr('分享数量上限')}<input type="number" min="0" required value={draft.maxShares} onChange={e => setDraft({...draft,maxShares:Number(e.target.value)})} /></label><label>{tr('存储上限（MB）')}<input type="number" min="0" required value={draft.maxBytes/1048576} onChange={e => setDraft({...draft,maxBytes:Math.round(Number(e.target.value)*1048576)})} /></label><label>{tr('密钥到期时间')}<input type="datetime-local" value={draft.expiresAt ? new Date(draft.expiresAt-new Date(draft.expiresAt).getTimezoneOffset()*60000).toISOString().slice(0,16) : ''} onChange={e => setDraft({...draft,expiresAt:e.target.value ? new Date(e.target.value).getTime() : null})} /></label></div><div className="actions"><label className="check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({...draft,enabled:e.target.checked})} />{tr('启用发布密钥')}</label><button disabled={busy}>{tr('保存')}</button><button type="button" disabled={busy} onClick={() => {if(confirm(tr('重置密钥后旧密钥立即失效，继续？')))reset();}}>{tr('重置密钥')}</button><button type="button" className="danger" disabled={busy} onClick={unpublish}>{tr('全部下架')}</button></div></form>;
}
function SettingsForm({value,busy,onSave}:{value:Settings;busy:boolean;onSave(value:Settings):void}) {
  const [draft,setDraft]=useState(value);useEffect(()=>setDraft(value),[value]);
  return <form className="card" onSubmit={e=>{e.preventDefault();onSave(draft);}}><h2>{tr('服务开关与限制')}</h2>{(['allowCreate','allowUpdate','allowRead'] as const).map((key,i)=><label className="check" key={key}><input type="checkbox" checked={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.checked})}/>{tr(['允许新建分享','允许更新分享','允许公开访问'][i])}</label>)}<div className="fields">{(['maxAssetBytes','maxShareBytes'] as const).map((key,i)=><label key={key}>{tr(['单附件上限（MB）','单篇总量上限（MB）'][i])}<input type="number" min="1" max={i?500:100} required value={draft[key]/1048576} onChange={e=>setDraft({...draft,[key]:Math.round(Number(e.target.value)*1048576)})}/></label>)}</div><button className="primary" disabled={busy}>{tr('保存设置')}</button></form>;
}
function Landing() { return <main className="empty"><div className="brand">Idea Note <span>Share</span></div><h1>{tr('把笔记分享出去')}</h1><p>{tr('在 Idea Note 中配置服务地址和发布密钥，即可分享 Markdown 笔记。')}</p></main>; }
createRoot(document.getElementById('root')!).render(location.pathname.startsWith('/share/') ? <ReadingPage /> : location.pathname.startsWith('/admin/preview/') ? <AdminPreview /> : location.pathname.startsWith('/admin') ? <Admin /> : <Landing />);
