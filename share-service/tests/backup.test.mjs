import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import * as fflate from 'fflate';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeService } from '../server/node.mjs';
import { fakeB2 } from './helpers/b2.mjs';

const source = ts.transpileModule(await readFile(new URL('../web/backup.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = fetch => {
  const exports = {};
  vm.runInNewContext(source, { exports, require: name => { assert.equal(name, 'fflate'); return fflate; }, fetch, Uint8Array, Set, Error });
  return exports;
};
test('incremental browser backup exports over 50 B2 documents and restores the same archive', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'idea-share-backup-')), backend = fakeB2(), password = 'backup-integration-password';
  t.mock.method(globalThis, 'fetch', backend.fetch);
  const service = await nodeService({ dataDir: join(dir, 'source'), password, distDir: dir, storage: { OBJECT_STORAGE: 'b2', ...backend.config } });
  const target = await nodeService({ dataDir: join(dir, 'target'), password, distDir: dir });
  t.after(async () => { service.close(); target.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (runtime, path, method = 'GET', data, headers = {}) => runtime.fetch(new Request('https://backup.test/api/v1/' + path, { method, headers: { Origin: 'https://backup.test', ...headers }, body: data === undefined ? undefined : data instanceof Uint8Array ? data : JSON.stringify(data) }));
  const login = async runtime => (await request(runtime, 'admin/login', 'POST', { password })).headers.get('set-cookie').split(';')[0];
  const cookie = await login(service), admin = { Cookie: cookie, 'X-Share-CSRF': '1' };
  const { key } = await (await request(service, 'admin/publishers', 'POST', { name: 'Backup test' }, admin)).json(), auth = { Authorization: 'Bearer ' + key };
  for (let i = 0; i < 60; i++) {
    const stage = await (await request(service, 'uploads', 'POST', {}, auth)).json();
    const response = await request(service, `uploads/${stage.id}/commit`, 'POST', { format: 1, title: 'Note ' + i, markdown: '# Note ' + i, expiresAt: null, assets: [], appearance: {}, inputs: {}, results: [] }, auth);
    assert.equal(response.status, 200);
  }
  assert.equal((await request(service, 'admin/backup/manifest')).status, 401);
  let maxCalls = 0, count = 0;
  const { writeBackupArchive } = load(async path => {
    const before = backend.requests.length;
    const response = await request(service, path.slice('/api/v1/'.length), 'GET', undefined, admin);
    maxCalls = Math.max(maxCalls, backend.requests.length - before); count++;
    return response;
  });
  const chunks = [], progress = [];
  await writeBackupArchive(async bytes => { chunks.push(bytes); }, value => progress.push(value));
  assert.equal(count, 61); assert.ok(maxCalls <= 2); assert.equal(progress.at(-1), '60 / 60');
  const archive = new Uint8Array(Buffer.concat(chunks));
  assert.equal(Object.keys(fflate.unzipSync(archive)).length, 61);
  const restored = await request(target, 'admin/restore', 'POST', archive, { Cookie: await login(target), 'X-Share-CSRF': '1' });
  assert.equal(restored.status, 200, await restored.clone().text());
  const shares = await (await request(target, 'shares', 'GET', undefined, auth)).json();
  assert.equal(shares.length, 60);
  assert.equal((await request(target, 'public/' + shares[0].id)).status, 200);
});

test('incremental backup fails on missing objects and does not finalize a partial archive', async () => {
  const object = 'documents/' + 'a'.repeat(32), chunks = [];
  const { writeBackupArchive } = load(async path => path.endsWith('/manifest')
    ? new Response(JSON.stringify({ manifest: { format: 'idea-note-share-backup', version: 1 }, objects: [{ key: object, storageKey: object }] }))
    : new Response(JSON.stringify({ error: 'Backup resource missing; restart the export' }), { status: 404 }));
  await assert.rejects(writeBackupArchive(async chunk => { chunks.push(chunk); }, () => {}), /Backup resource missing/);
  assert.throws(() => fflate.unzipSync(new Uint8Array(Buffer.concat(chunks))));
});
