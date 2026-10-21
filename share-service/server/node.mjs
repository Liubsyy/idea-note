import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat } from 'node:fs/promises';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { sqliteDatabase } from './storage.mjs';
import { createService } from './service.mjs';
import { forwardedClient, trustedProxyHops } from './address.mjs';

export async function fileObjects(directory) {
  await mkdir(directory, { recursive: true });
  const path = key => {
    if (!/^(?:restore\/[a-f0-9]{32}\/)?(assets|documents)\/[a-f0-9]{32}$/.test(key)) throw new Error('Invalid object key');
    return join(directory, key);
  };
  return {
    put: async (key, bytes) => { const target = path(key); await mkdir(dirname(target), { recursive: true }); const temp = target + '.' + crypto.randomUUID() + '.tmp'; await writeFile(temp, bytes); await rename(temp, target); },
    get: async key => { try { return new Uint8Array(await readFile(path(key))); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    delete: key => rm(path(key), { force: true }),
    deleteMany: async keys => { for (const key of keys) await rm(path(key), { force: true }); },
    list: async () => {
      const result = [];
      for (const prefix of ['assets','documents']) {
        for (const name of await readdir(join(directory, prefix)).catch(() => [])) {
          if (/^[a-f0-9]{32}$/.test(name)) { const key = `${prefix}/${name}`; result.push({ key, uploaded: (await stat(path(key))).mtimeMs }); }
        }
      }
      for (const token of await readdir(join(directory, 'restore')).catch(() => [])) {
        if (!/^[a-f0-9]{32}$/.test(token)) continue;
        for (const prefix of ['assets','documents']) for (const name of await readdir(join(directory,'restore',token,prefix)).catch(() => [])) {
          if (/^[a-f0-9]{32}$/.test(name)) { const key = `restore/${token}/${prefix}/${name}`; result.push({ key, uploaded: (await stat(path(key))).mtimeMs }); }
        }
      }
      return result;
    },
  };
}
export async function nodeService({ dataDir, password, distDir, origins = [] }) {
  await mkdir(dataDir, { recursive: true });
  const sqlite = new DatabaseSync(join(dataDir, 'share.sqlite'));
  sqlite.exec(await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2', '.svg':'image/svg+xml', '.png':'image/png' };
  const service = createService({ db: sqliteDatabase(sqlite), objects: await fileObjects(join(dataDir, 'objects')), adminPassword: password, allowedOrigins: origins,
    staticFetch: async request => {
      if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const relative = pathname === '/' || pathname === '/admin' || pathname.startsWith('/admin/') || /^\/share\/[a-f0-9]{32}$/.test(pathname) ? 'index.html' : pathname.slice(1);
      const target = resolve(distDir, relative);
      if (!target.startsWith(resolve(distDir) + '/') || relative.includes('\\')) return new Response('Not found', { status: 404 });
      try { return new Response(request.method === 'HEAD' ? null : await readFile(target), { headers: { 'Content-Type': mime[extname(target)] || 'application/octet-stream' } }); }
      catch { return new Response('Not found', { status: 404 }); }
    } });
  return { ...service, close: () => sqlite.close() };
}
/** Node HTTP adapter. `hops` is the parsed TRUST_PROXY setting. */
export function requestListener(service, { publicOrigin, hops = 0 } = {}) {
  let warned = false;
  return async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [key,value] of Object.entries(incoming.headers)) if (value && !['x-service-client-ip','cf-connecting-ip'].includes(key)) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      if (!hops && !warned && incoming.headers['x-forwarded-for']) { warned = true; console.warn('X-Forwarded-For received but TRUST_PROXY is not set: all clients behind the proxy share one login rate limit'); }
      headers.set('x-service-client-ip', forwardedClient(incoming.socket.remoteAddress, incoming.headers['x-forwarded-for'], hops));
      const origin = publicOrigin || `http://${incoming.headers.host}`;
      const request = new Request(new URL(incoming.url, origin), { method: incoming.method, headers, ...(incoming.method !== 'GET' && incoming.method !== 'HEAD' ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
      const response = await service.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(outgoing); else outgoing.end();
    } catch { outgoing.writeHead(500); outgoing.end('Internal server error'); }
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787), hops = trustedProxyHops(process.env.TRUST_PROXY);
  const service = await nodeService({ dataDir: resolve(process.env.DATA_DIR || './data'), password: process.env.ADMIN_PASSWORD, distDir: fileURLToPath(new URL('../dist/', import.meta.url)), origins: (process.env.ALLOWED_ORIGINS || '').split(',').filter(Boolean) });
  const server = createServer(requestListener(service, { publicOrigin: process.env.PUBLIC_ORIGIN, hops }));
  server.listen(port, '0.0.0.0', () => console.log(`Idea Note Share listening on port ${port}`));
  const timer = setInterval(() => service.cleanup().catch(console.error), 3600000); timer.unref();
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { clearInterval(timer); server.close(() => { service.close(); process.exit(0); }); });
}
