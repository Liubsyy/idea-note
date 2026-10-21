import { digest, equal, id } from './crypto.mjs';
import { exportBackup, importBackup, restoreQueries } from './backup.mjs';
import { rateLimitKey } from './address.mjs';

const MiB = 1024 * 1024;
export const DEFAULTS = Object.freeze({ allowCreate: true, allowUpdate: true, allowRead: true, maxAssetBytes: 20 * MiB, maxShareBytes: 100 * MiB });
const encoder = new TextEncoder();
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: http: data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
// The admin console frames this page. External images stay blocked so a
// publisher cannot learn when, or from where, an administrator previews.
const PREVIEW_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'";
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
class Fault extends Error { constructor(status, message) { super(message); this.status = status; } }
const demand = (value, status, message) => { if (!value) throw new Fault(status, message); };
const safeId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const future = value => value === null || (integer(value, 1, Number.MAX_SAFE_INTEGER) && value > Date.now());
async function bodyBytes(request, limit) {
  demand(Number(request.headers.get('content-length') || 0) <= limit, 413, 'Request too large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  // Keep one final buffer instead of retaining every chunk plus a second full
  // concatenation buffer, which matters for larger Worker uploads.
  const limited = new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) { controller.close(); return; }
      size += value.length;
      if (size > limit) { await reader.cancel(); controller.error(new Fault(413, 'Request too large')); return; }
      controller.enqueue(value);
    },
    cancel: reason => reader.cancel(reason),
  });
  return new Uint8Array(await new Response(limited).arrayBuffer());
}
async function body(request, limit = 5 * MiB) {
  try { return JSON.parse(new TextDecoder().decode(await bodyBytes(request, limit))); }
  catch (error) { if (error instanceof Fault) throw error; throw new Fault(400, 'Invalid JSON'); }
}
const publicShare = s => ({ id: s.id, title: s.title, status: s.status, version: s.version, bytes: s.bytes, expiresAt: s.expires_at, createdAt: s.created_at, updatedAt: s.updated_at, owner: s.owner });
const publicPublisher = p => ({ id: p.id, name: p.name, enabled: !!p.enabled, expiresAt: p.expires_at, maxShares: p.max_shares, maxBytes: p.max_bytes, createdAt: p.created_at });
function validateDocument(doc) {
  demand(doc && [1,2].includes(doc.format), 400, 'Unsupported share document');
  demand(typeof doc.title === 'string' && doc.title.trim().length > 0 && doc.title.length <= 300, 400, 'Invalid title');
  demand(Array.isArray(doc.assets) && doc.assets.every(safeId) && new Set(doc.assets).size === doc.assets.length, 400, 'Invalid assets');
  demand(future(doc.expiresAt ?? null), 400, 'Invalid expiry');
  demand(doc.appearance && typeof doc.appearance === 'object' && !Array.isArray(doc.appearance) && Object.values(doc.appearance).every(v => typeof v === 'string' && v.length < 500), 400, 'Invalid appearance');
  if (doc.format === 1) return validateNote(doc);
  demand(Array.isArray(doc.entries), 400, 'Invalid folder entries');
  const paths = new Map();
  for (const entry of doc.entries) {
    demand(entry && ['directory','markdown','file'].includes(entry.kind) && typeof entry.path === 'string' && entry.path.length > 0 && !/[\\:\x00-\x1f\x7f]/.test(entry.path) && entry.path.split('/').every(part => part && part !== '.' && part !== '..'), 400, 'Invalid folder path');
    demand(!paths.has(entry.path), 400, 'Duplicate folder path'); paths.set(entry.path, entry.kind);
    if (entry.kind === 'markdown') { demand(entry.content && typeof entry.content === 'object',400,'Invalid note'); validateNote(entry.content); }
    if (entry.kind === 'file') demand(typeof entry.asset === 'string' && typeof entry.mime === 'string' && integer(entry.size,0,Number.MAX_SAFE_INTEGER),400,'Invalid file entry');
  }
  for (const entry of doc.entries) {
    const parent = entry.path.split('/').slice(0,-1).join('/');
    demand(!parent || paths.get(parent) === 'directory',400,'Missing parent directory');
  }
}
function validateNote(doc) {
  demand(typeof doc.markdown === 'string', 400, 'Invalid Markdown');
  demand(Array.isArray(doc.results) && doc.results.length <= 500 && doc.inputs && typeof doc.inputs === 'object' && !Array.isArray(doc.inputs), 400, 'Invalid snapshot');
  demand(Object.values(doc.inputs).every(block => block && typeof block === 'object' && !Array.isArray(block) && Object.values(block).every(v => ['string','number','boolean'].includes(typeof v))), 400, 'Invalid parameters');
  for (const result of doc.results) {
    demand(result && typeof result.code === 'string' && typeof result.info === 'string' && typeof result.inputSummary === 'string' && Number.isFinite(result.ms), 400, 'Invalid result snapshot');
    const value = result.componentResult;
    demand(value && ['markdown','text','mermaid','html','image','json','table'].includes(value.type), 400, 'Invalid result type');
    if (['markdown','text','mermaid','html'].includes(value.type)) demand(typeof value.data === 'string', 400, 'Invalid text result');
    if (value.type === 'image') demand(typeof value.data === 'string' || (Array.isArray(value.data) && value.data.every(v => typeof v === 'string')), 400, 'Invalid image result');
    if (value.type === 'table') demand(value.data && Array.isArray(value.data.columns) && value.data.columns.every(v => typeof v === 'string') && Array.isArray(value.data.rows) && value.data.rows.every(r => Array.isArray(r) && r.length === value.data.columns.length), 400, 'Invalid table result');
  }
  // Desktop redacts before upload; reject recognizable encrypted payloads as
  // defense in depth for other API clients and older desktop versions.
  demand(!/(?:^|\n)\s*(?:`{3,}|~{3,})secret\b|`secret\s*\{/i.test(doc.markdown), 400, 'Encrypted content must be redacted');
}

export function createService({ db, objects, adminPassword, allowedOrigins = [], staticFetch = () => new Response('Not found', { status: 404 }) }) {
  const settings = async () => ({ ...DEFAULTS, ...JSON.parse((await db.get('SELECT json FROM settings WHERE id=1'))?.json || '{}') });
  const log = (actor, action, target = null) => db.run('INSERT INTO audit(id,actor,action,target,at) VALUES(?,?,?,?,?)', [id(), actor, action, target, Date.now()]);
  async function publisher(request) {
    const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '')?.[1];
    demand(token && token.length < 300, 401, 'A publishing key is required');
    const row = await db.get('SELECT * FROM publishers WHERE token_hash=?', [await digest(token)]);
    demand(row && row.enabled && (!row.expires_at || row.expires_at > Date.now()), 401, 'Invalid, disabled or expired publishing key');
    return row;
  }
  async function administrator(request) {
    const token = /(?:^|;\s*)idea_share_admin=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie') || '')?.[1];
    demand(token, 401, 'Administrator login required');
    const session = await db.get('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?', [await digest(token), Date.now()]);
    demand(session, 401, 'Session expired');
    if (!['GET', 'HEAD'].includes(request.method)) {
      demand(request.headers.get('origin') === new URL(request.url).origin && request.headers.get('x-share-csrf') === '1', 403, 'Invalid administrator request origin');
    }
    return token;
  }
  async function readable(shareId) {
    demand((await settings()).allowRead, 503, 'Public access is temporarily disabled');
    const share = await db.get('SELECT * FROM shares WHERE id=?', [shareId]);
    demand(share && share.status === 'active' && (!share.expires_at || share.expires_at > Date.now()), 404, 'Share unavailable');
    return share;
  }
  async function stageFor(stageId, owner) {
    const stage = await db.get("SELECT * FROM stages WHERE id=? AND owner=? AND state='open' AND created_at>?", [stageId, owner, Date.now() - 86400000]);
    demand(stage, 404, 'Upload expired or already committed');
    return stage;
  }

  async function route(request) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    if (path === '/api/v1/health' && method === 'GET') return json({ service: 'idea-note-share', apiVersion: 1 });
    if (path === '/api/v1/admin/login' && method === 'POST') {
      demand(adminPassword && adminPassword.length >= 12, 503, 'Configure ADMIN_PASSWORD with at least 12 characters');
      demand(request.headers.get('origin') === url.origin, 403, 'Invalid login origin');
      // Buckets are per client (IPv6 per /64), so failures from other clients
      // never lock the administrator out. An attempt is counted before the
      // password check so parallel guesses cannot all slip under the limit,
      // and a successful login clears its bucket.
      const address = request.headers.get('cf-connecting-ip') || request.headers.get('x-service-client-ip') || 'unknown';
      const attemptId = await digest(rateLimitKey(address)), now = Date.now();
      await db.run('INSERT INTO attempts(id,hits,reset_at) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET hits=CASE WHEN reset_at<? THEN 1 ELSE hits+1 END,reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END', [attemptId, now + 900000, now, now]);
      demand((await db.get('SELECT hits FROM attempts WHERE id=?', [attemptId])).hits <= 10, 429, 'Too many login attempts; retry in 15 minutes');
      const payload = await body(request, 4096);
      demand(typeof payload.password === 'string' && equal(await digest(payload.password), await digest(adminPassword)), 401, 'Invalid password');
      await db.run('DELETE FROM attempts WHERE id=?', [attemptId]);
      const token = id() + id();
      await db.run('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)', [await digest(token), now + 8 * 3600000]);
      await log('admin', 'login');
      return json({ ok: true }, 200, { 'Set-Cookie': `idea_share_admin=${token}; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=28800${url.protocol === 'https:' ? '; Secure' : ''}` });
    }
    if (path.startsWith('/api/v1/admin/')) {
      const token = await administrator(request);
      const sub = path.slice('/api/v1/admin/'.length);
      if (sub === 'logout' && method === 'POST') {
        await db.run('DELETE FROM sessions WHERE token_hash=?', [await digest(token)]);
        return json({ ok: true }, 200, { 'Set-Cookie': 'idea_share_admin=; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=0' });
      }
      if (sub === 'overview' && method === 'GET') return json({ settings: await settings(),
        shares: await db.get('SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM shares'),
        storage: await db.get('SELECT COALESCE(SUM(bytes),0) AS bytes,COUNT(*) AS count FROM assets'),
        publishers: await db.get('SELECT COUNT(*) AS count FROM publishers'),
        audit: await db.all('SELECT * FROM audit ORDER BY at DESC LIMIT 100') });
      if (sub === 'settings' && method === 'PUT') {
        const value = await body(request, 4096);
        demand(['allowCreate','allowUpdate','allowRead'].every(k => typeof value[k] === 'boolean') && integer(value.maxAssetBytes, 1, 100 * MiB) && integer(value.maxShareBytes, value.maxAssetBytes, 500 * MiB), 400, 'Invalid service settings');
        const clean = Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, value[k]]));
        await db.run('INSERT INTO settings(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json', [JSON.stringify(clean)]);
        await log('admin', 'settings.update'); return json(clean);
      }
      if (sub === 'publishers' && method === 'GET') return json(await db.all('SELECT p.*,COUNT(s.id) AS share_count,COALESCE(SUM(s.bytes),0) AS used_bytes FROM publishers p LEFT JOIN shares s ON s.owner=p.id GROUP BY p.id ORDER BY p.created_at DESC').then(rows => rows.map(p => ({ ...publicPublisher(p), shareCount: p.share_count, usedBytes: p.used_bytes }))));
      if (sub === 'publishers' && method === 'POST') {
        const data = await body(request, 4096), publisherId = id(), key = 'inshare_' + id() + id();
        demand(typeof data.name === 'string' && data.name.trim() && data.name.length <= 100, 400, 'Name required');
        const created = await db.run("INSERT INTO publishers(id,name,token_hash,created_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM restore_jobs)", [publisherId, data.name.trim(), await digest(key), Date.now()]);
        demand(created.changes, 409, 'Backup restore in progress');
        await log('admin', 'publisher.create', publisherId); return json({ id: publisherId, key }, 201);
      }
      const publisherMatch = /^publishers\/([a-f0-9]{32})(?:\/(reset|unpublish))?$/.exec(sub);
      if (publisherMatch) {
        const [, target, action] = publisherMatch;
        demand(await db.get('SELECT id FROM publishers WHERE id=?', [target]), 404, 'Publisher not found');
        if (action === 'reset' && method === 'POST') {
          const key = 'inshare_' + id() + id();
          await db.run('UPDATE publishers SET token_hash=? WHERE id=?', [await digest(key), target]);
          await log('admin', 'publisher.reset', target); return json({ key });
        }
        if (action === 'unpublish' && method === 'POST') {
          await db.run("UPDATE shares SET status='hidden',version=version+1,updated_at=? WHERE owner=?", [Date.now(), target]);
          await log('admin', 'publisher.unpublish', target); return json({ ok: true });
        }
        if (!action && method === 'PUT') {
          const data = await body(request, 4096);
          demand(typeof data.enabled === 'boolean' && typeof data.name === 'string' && data.name.trim() && data.name.length <= 100 && future(data.expiresAt ?? null) && integer(data.maxShares, 0, 1000000) && integer(data.maxBytes, 0, 1024 ** 5), 400, 'Invalid publisher settings');
          await db.run('UPDATE publishers SET name=?,enabled=?,expires_at=?,max_shares=?,max_bytes=? WHERE id=?', [data.name.trim(), +data.enabled, data.expiresAt ?? null, data.maxShares, data.maxBytes, target]);
          await log('admin', 'publisher.update', target); return json({ ok: true });
        }
      }
      if (sub === 'shares' && method === 'GET') {
        const query = (url.searchParams.get('q') || '').slice(0, 300), offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        return json((await db.all('SELECT * FROM shares WHERE title LIKE ? OR id=? ORDER BY updated_at DESC LIMIT 100 OFFSET ?', ['%' + query + '%', query, offset])).map(publicShare));
      }
      const adminAsset = /^shares\/([a-f0-9]{32})\/assets\/([a-f0-9]{32})$/.exec(sub);
      if (adminAsset && method === 'GET') {
        const asset = await db.get('SELECT a.* FROM assets a JOIN shares s ON s.stage_id=a.stage_id WHERE s.id=? AND a.id=?', [adminAsset[1], adminAsset[2]]);
        demand(asset, 404, 'Asset unavailable');
        const bytes = await objects.get(asset.object_key); demand(bytes, 404, 'Asset unavailable');
        const image = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(asset.mime);
        return new Response(bytes, { headers: { 'Content-Type': image ? asset.mime : 'application/octet-stream', 'Content-Disposition': image ? 'inline' : 'attachment', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
      }
      const shareMatch = /^shares\/([a-f0-9]{32})(?:\/(document))?$/.exec(sub);
      if (shareMatch) {
        const target = shareMatch[1], share = await db.get('SELECT * FROM shares WHERE id=?', [target]);
        demand(share, 404, 'Share not found');
        if (shareMatch[2] && method === 'GET') return new Response(await objects.get(share.doc_key), { headers: { 'Content-Type': 'application/json' } });
        if (!shareMatch[2] && method === 'PUT') {
          const data = await body(request, 4096); demand(['active','hidden'].includes(data.status), 400, 'Invalid status');
          await db.run('UPDATE shares SET status=?,version=version+1,updated_at=? WHERE id=?', [data.status, Date.now(), target]);
          await log('admin', 'share.' + data.status, target); return json({ ok: true });
        }
        if (!shareMatch[2] && method === 'DELETE') {
          await db.run('DELETE FROM shares WHERE id=?', [target]);
          await log('admin', 'share.delete', target); return json({ ok: true });
        }
      }
      if (sub === 'cleanup' && method === 'POST') { await cleanup(); await log('admin', 'cleanup'); return json({ ok: true }); }
      if (sub === 'restore/start' && method === 'POST') {
        const job = id();
        const result = await db.run("INSERT INTO restore_jobs(id,token,created_at) SELECT 'active',?,? WHERE NOT EXISTS(SELECT 1 FROM publishers) AND NOT EXISTS(SELECT 1 FROM shares) ON CONFLICT(id) DO NOTHING", [job, Date.now()]);
        demand(result.changes, 409, 'Restore requires an empty instance with no active restore');
        return json({ id: job }, 201);
      }
      const restoreJob = /^restore\/([a-f0-9]{32})(?:\/(commit|objects\/(assets|documents)\/([a-f0-9]{32})))?$/.exec(sub);
      if (restoreJob) {
        const job = await db.get("SELECT * FROM restore_jobs WHERE id='active' AND token=?", [restoreJob[1]]);
        demand(job, 404, 'Restore session expired');
        if (restoreJob[3] && method === 'PUT') {
          const key = `${restoreJob[3]}/${restoreJob[4]}`;
          const bytes = await bodyBytes(request, restoreJob[3] === 'documents' ? 5 * MiB : 100 * MiB);
          await objects.put(`restore/${job.token}/${key}`, bytes);
          await db.batch([['INSERT OR IGNORE INTO restore_objects(job,object_key) VALUES(?,?)', [job.token, key]], ["UPDATE restore_jobs SET created_at=? WHERE token=?", [Date.now(), job.token]]]);
          return json({ ok: true });
        }
        if (restoreJob[2] === 'commit' && method === 'POST') {
          const manifest = await body(request, 16 * MiB);
          const stored = await db.all('SELECT object_key FROM restore_objects WHERE job=?', [job.token]);
          let queries;
          try { queries = restoreQueries(manifest, new Set(stored.map(r => 'objects/' + r.object_key)), `restore/${job.token}/`); }
          catch (error) { throw new Fault(400, error.message); }
          try { await db.batch([['INSERT INTO restore_guard(id) VALUES(1)', []], ['DELETE FROM settings', []], ['DELETE FROM audit', []], ...queries, ['DELETE FROM restore_objects WHERE job=?', [job.token]], ['DELETE FROM restore_jobs WHERE token=?', [job.token]]]); }
          catch { throw new Fault(409, 'Restore conflicts with another operation; retry on an empty instance'); }
          await log('admin', 'backup.restore'); return json({ ok: true });
        }
        if (!restoreJob[2] && method === 'DELETE') {
          for (const row of await db.all('SELECT object_key FROM restore_objects WHERE job=?', [job.token])) await objects.delete(`restore/${job.token}/${row.object_key}`);
          await db.batch([['DELETE FROM restore_objects WHERE job=?', [job.token]], ['DELETE FROM restore_jobs WHERE token=?', [job.token]]]);
          return json({ ok: true });
        }
      }
      if (sub === 'backup' && method === 'GET') return backup();
      if (sub === 'restore' && method === 'POST') return restore(request);
      throw new Fault(404, 'Unknown administrator endpoint');
    }
    const publicMatch = /^\/api\/v1\/public\/([a-f0-9]{32})(?:\/assets\/([a-f0-9]{32}))?$/.exec(path);
    if (publicMatch && method === 'GET') {
      const share = await readable(publicMatch[1]);
      if (!publicMatch[2]) {
        const bytes = await objects.get(share.doc_key); demand(bytes, 404, 'Document unavailable');
        // Readers get no publisher identity; owner is for the publisher and admin.
        const { owner: _owner, ...metadata } = publicShare(share);
        return json({ ...metadata, document: JSON.parse(new TextDecoder().decode(bytes)) });
      }
      const asset = await db.get('SELECT * FROM assets WHERE id=? AND stage_id=?', [publicMatch[2], share.stage_id]);
      demand(asset, 404, 'Asset unavailable');
      const bytes = await objects.get(asset.object_key); demand(bytes, 404, 'Asset unavailable');
      // SVG is allowed as an image, never as an active same-origin document.
      const image = /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(asset.mime);
      return new Response(bytes, { headers: { 'Content-Type': image ? asset.mime : 'application/octet-stream',
        'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'X-Content-Type-Options': 'nosniff' } });
    }
    if (path.startsWith('/api/v1/public/')) throw new Fault(404, 'Share unavailable');
    if (path.startsWith('/api/v1/')) {
      const owner = await publisher(request);
      if (path === '/api/v1/me' && method === 'GET') return json({ ...publicPublisher(owner), settings: await settings() });
      const ownedDocument = /^\/api\/v1\/shares\/([a-f0-9]{32})\/document$/.exec(path);
      if (ownedDocument && method === 'GET') {
        const share = await db.get('SELECT * FROM shares WHERE id=? AND owner=?',[ownedDocument[1],owner.id]);
        demand(share,404,'Share not found');
        const bytes = await objects.get(share.doc_key); demand(bytes,404,'Document unavailable');
        return json({document:JSON.parse(new TextDecoder().decode(bytes))});
      }
      if (path === '/api/v1/shares' && method === 'GET') return json((await db.all('SELECT * FROM shares WHERE owner=? ORDER BY updated_at DESC',[owner.id])).map(publicShare));
      const cancel = /^\/api\/v1\/shares\/([a-f0-9]{32})$/.exec(path);
      if (cancel && method === 'DELETE') {
        const result = await db.run("UPDATE shares SET status=CASE WHEN status='hidden' THEN status ELSE 'revoked' END,version=version+1,updated_at=? WHERE id=? AND owner=?", [Date.now(), cancel[1], owner.id]);
        demand(result.changes, 404, 'Share not found'); await log(owner.id, 'share.revoke', cancel[1]); return json({ ok: true });
      }
      if (path === '/api/v1/uploads' && method === 'POST') {
        const data = await body(request, 4096), config = await settings();
        const share = data.shareId ? await db.get('SELECT * FROM shares WHERE id=? AND owner=?', [data.shareId, owner.id]) : null;
        demand(!data.shareId || share, 404, 'Share not found');
        demand(!share || share.status === 'active', 409, 'This share has been revoked or taken down');
        demand(share ? config.allowUpdate : config.allowCreate, 503, 'Publishing is temporarily disabled');
        demand(!share || data.version === share.version, 409, 'Share changed; refresh before updating');
        const stageId = id(), shareId = share?.id || id();
        await db.run('INSERT INTO stages(id,owner,share_id,base_version,created_at) VALUES(?,?,?,?,?)', [stageId, owner.id, shareId, share?.version || 0, Date.now()]);
        return json({ id: stageId, shareId, version: share?.version || 0 }, 201);
      }
      const upload = /^\/api\/v1\/uploads\/([a-f0-9]{32})\/(assets|commit)$/.exec(path);
      if (upload && method === 'POST') {
        const stage = await stageFor(upload[1], owner.id), config = await settings();
        if (upload[2] === 'assets') {
          const name = decodeURIComponent(request.headers.get('x-file-name') || 'attachment').replaceAll('\\', '/').split('/').pop();
          demand(name && name.length <= 255 && !/[\x00-\x1f]/.test(name), 400, 'Invalid filename');
          const bytes = await bodyBytes(request, config.maxAssetBytes), assetId = id(), key = `assets/${assetId}`;
          const mime = (request.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
          await objects.put(key, bytes);
          const result = await db.run("INSERT INTO assets(id,stage_id,name,mime,bytes,object_key,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM stages WHERE id=? AND state='open') AND (SELECT COALESCE(SUM(bytes),0) FROM assets WHERE stage_id=?) + ? <= ? AND (SELECT COALESCE(SUM(a.bytes),0) FROM assets a JOIN stages t ON a.stage_id=t.id WHERE t.owner=?) + ? <= ?", [assetId, stage.id, name, mime, bytes.length, key, Date.now(), stage.id, stage.id, bytes.length, config.maxShareBytes, owner.id, bytes.length, owner.max_bytes]);
          if (!result.changes) { await objects.delete(key); throw new Fault(413, 'Upload quota exceeded or upload already committed'); }
          return json({ id: assetId, name, bytes: bytes.length, url: `/api/v1/public/${stage.share_id}/assets/${assetId}` }, 201);
        }
        const doc = await body(request); validateDocument(doc);
        const assets = await db.all('SELECT * FROM assets WHERE stage_id=?', [stage.id]);
        if (stage.base_version) {
          const old=await db.get('SELECT doc_key FROM shares WHERE id=?',[stage.share_id]);
          const bytes=old&&await objects.get(old.doc_key);
          demand(bytes && JSON.parse(new TextDecoder().decode(bytes)).format===doc.format,409,'Share type cannot change');
        }
        if (doc.format===2) for (const entry of doc.entries) {
          if (entry.kind!=='file') continue;
          const asset=assets.find(a=>entry.asset===`/api/v1/public/${stage.share_id}/assets/${a.id}`);
          demand(asset && doc.assets.includes(asset.id) && entry.size===asset.bytes && entry.mime===asset.mime,400,'Invalid folder asset');
        }
        demand(doc.assets.length === assets.length && doc.assets.every(assetId => assets.some(a => a.id === assetId)), 400, 'Uploaded asset manifest does not match');
        const documentBytes = encoder.encode(JSON.stringify(doc)), total = documentBytes.length + assets.reduce((sum, a) => sum + a.bytes, 0);
        demand(total <= config.maxShareBytes, 413, 'Share size limit exceeded');
        demand(stage.base_version ? config.allowUpdate : config.allowCreate, 503, 'Publishing is temporarily disabled');
        const docKey = `documents/${stage.id}`, now = Date.now();
        await objects.put(docKey, documentBytes);
        // One conditional statement enforces ownership, optimistic locking and
        // owner quotas atomically, including simultaneous Worker requests.
        const result = await db.run(`INSERT INTO shares(id,owner,title,status,version,stage_id,doc_key,bytes,expires_at,created_at,updated_at)
          SELECT ?,?,?,'active',1,?,?,?,?,?,? WHERE
          EXISTS(SELECT 1 FROM stages WHERE id=? AND state='open') AND
          EXISTS(SELECT 1 FROM publishers WHERE id=? AND enabled=1 AND (expires_at IS NULL OR expires_at>?) AND
            (SELECT COUNT(*) FROM shares WHERE owner=? AND id<>?) < max_shares AND
            (SELECT COALESCE(SUM(bytes),0) FROM shares WHERE owner=? AND id<>?) + ? <= max_bytes) AND
          ((?=0 AND NOT EXISTS(SELECT 1 FROM shares WHERE id=?)) OR EXISTS(SELECT 1 FROM shares WHERE id=? AND owner=? AND version=? AND status='active'))
          ON CONFLICT(id) DO UPDATE SET title=excluded.title,version=shares.version+1,stage_id=excluded.stage_id,doc_key=excluded.doc_key,bytes=excluded.bytes,expires_at=excluded.expires_at,updated_at=excluded.updated_at`,
        [stage.share_id, owner.id, doc.title, stage.id, docKey, total, doc.expiresAt ?? null, now, now, stage.id, owner.id, now, owner.id, stage.share_id, owner.id, stage.share_id, total, stage.base_version, stage.share_id, stage.share_id, owner.id, stage.base_version]);
        if (!result.changes) throw new Fault(409, 'Share changed or publisher quota exceeded; refresh and retry');
        await db.run("UPDATE stages SET state='committed' WHERE id=?", [stage.id]);
        await log(owner.id, stage.base_version ? 'share.update' : 'share.create', stage.share_id);
        return json({...publicShare(await db.get('SELECT * FROM shares WHERE id=?', [stage.share_id])),kind:doc.format===2?'folder':'note'}, 200);
      }
      throw new Fault(404, 'Unknown API endpoint');
    }
    return staticFetch(request);
  }

  const removeObjects = keys => objects.deleteMany ? objects.deleteMany(keys) : Promise.all(keys.map(key => objects.delete(key)));
  async function cleanup() {
    const cutoff = Date.now() - 86400000;
    // Revoked and expired shares stay restorable for a day, then their record,
    // document and attachments are deleted; hidden (taken down) shares wait
    // for an administrator. A fixed number of D1/R2 calls per run keeps the
    // Worker cron within the free plan's subrequest limit.
    const ended = "(status='revoked' AND updated_at<?) OR expires_at<?";
    const due = await db.all(`SELECT id,stage_id,doc_key FROM shares WHERE ${ended} LIMIT 50`, [cutoff, cutoff]);
    if (due.length) {
      const assets = await db.all(`SELECT stage_id,object_key FROM assets WHERE stage_id IN (${due.map(() => '?').join(',')})`, due.map(s => s.stage_id));
      // Re-check on the same revision: the publisher may have just updated an
      // expired share, or an administrator restored a revoked one.
      const results = await db.batch(due.flatMap(s => [
        [`DELETE FROM shares WHERE id=? AND stage_id=? AND (${ended})`, [s.id, s.stage_id, cutoff, cutoff]],
        ['DELETE FROM assets WHERE stage_id=? AND NOT EXISTS(SELECT 1 FROM shares WHERE stage_id=?)', [s.stage_id, s.stage_id]],
        ['DELETE FROM stages WHERE id=? AND NOT EXISTS(SELECT 1 FROM shares WHERE stage_id=?)', [s.stage_id, s.stage_id]],
      ]));
      const purged = due.filter((_, i) => results[i * 3].changes);
      if (purged.length) await db.batch(purged.map(s => ['INSERT INTO audit(id,actor,action,target,at) VALUES(?,?,?,?,?)', [id(), 'system', 'share.purge', s.id, Date.now()]]));
      // If this fails, the orphan sweep below reclaims the objects later.
      await removeObjects(purged.flatMap(s => [s.doc_key, ...assets.filter(a => a.stage_id === s.stage_id).map(a => a.object_key)]));
    }
    const stale = await db.all('SELECT t.id FROM stages t WHERE t.created_at<? AND NOT EXISTS(SELECT 1 FROM shares s WHERE s.stage_id=t.id) LIMIT 8', [cutoff]);
    for (const stage of stale) {
      await removeObjects([...(await db.all('SELECT object_key FROM assets WHERE stage_id=?', [stage.id])).map(a=>a.object_key), `documents/${stage.id}`]);
      await db.batch([['DELETE FROM assets WHERE stage_id=?', [stage.id]], ['DELETE FROM stages WHERE id=?', [stage.id]]]);
    }
    // Also collect objects left by interrupted writes before their SQL insert.
    const known = new Set((await db.all('SELECT object_key AS key FROM assets UNION SELECT doc_key AS key FROM shares')).map(r => r.key));
    await removeObjects((await objects.list()).filter(object=>object.uploaded<cutoff&&!known.has(object.key)).map(object=>object.key));
    for (const job of await db.all('SELECT token FROM restore_jobs WHERE created_at<?', [cutoff])) {
      for (const row of await db.all('SELECT object_key FROM restore_objects WHERE job=?', [job.token])) await objects.delete(`restore/${job.token}/${row.object_key}`);
      await db.batch([['DELETE FROM restore_objects WHERE job=?', [job.token]], ['DELETE FROM restore_jobs WHERE token=?', [job.token]]]);
    }
    await db.batch([['DELETE FROM sessions WHERE expires_at<?', [Date.now()]], ['DELETE FROM attempts WHERE reset_at<?', [Date.now()]], ['DELETE FROM audit WHERE at<?', [Date.now() - 90 * 86400000]]]);
  }

  async function backup() {
    await log('admin', 'backup.export'); return exportBackup(db, objects);
  }
  async function restore(request) {
    demand(!(await db.get('SELECT id FROM publishers LIMIT 1')), 409, 'Restore requires an empty instance');
    try { await importBackup(request, db, objects); }
    catch(error) { throw new Fault(400, error.message || 'Invalid backup'); }
    await log('admin', 'backup.restore'); return json({ ok: true });
  }

  return {
    cleanup,
    fetch: async request => {
      const origin = request.headers.get('origin'), url = new URL(request.url);
      const allowed = origin && (origin === url.origin || allowedOrigins.includes(origin));
      let response;
      try {
        if (request.method === 'OPTIONS') { demand(allowed, 403, 'Origin not allowed'); response = new Response(null, { status: 204 }); }
        else {
          if (origin && origin !== url.origin) demand(allowed && !url.pathname.startsWith('/api/v1/admin/'), 403, 'Origin not allowed');
          response = await route(request);
        }
      } catch (error) {
        response = json({ error: error instanceof Fault ? error.message : 'Internal server error' }, error instanceof Fault ? error.status : 500);
        if (!(error instanceof Fault)) console.error('Share service failure', error);
      }
      const headers = new Headers(response.headers);
      headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'no-referrer');
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/share/')) { headers.set('Cache-Control', 'no-store, max-age=0'); headers.set('CDN-Cache-Control', 'no-store'); }
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', url.pathname.startsWith('/admin/preview/') ? PREVIEW_CSP : PAGE_CSP);
      if (allowed) { headers.set('Access-Control-Allow-Origin', origin); headers.append('Vary', 'Origin'); headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name, X-Share-CSRF'); headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS'); }
      return new Response(response.body, { status: response.status, headers });
    },
  };
}
