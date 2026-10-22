import test from 'node:test';
import assert from 'node:assert/strict';
import { b2Objects } from '../server/b2.mjs';
import { fakeB2 } from './helpers/b2.mjs';

const a = 'assets/' + 'a'.repeat(32), b = 'documents/' + 'b'.repeat(32);
test('B2 binary uploads, authenticated reads, pagination and permanent version deletion', async () => {
  const backend = fakeB2({ pageSize: 1 }), objects = b2Objects(backend.config, backend);
  const bytes = new Uint8Array([0, 255, 13, 128]);
  await objects.put(a, bytes);
  await objects.put(a, new Uint8Array([9]));
  await objects.put(b, bytes);
  assert.deepEqual(await objects.get(a), new Uint8Array([9]));
  assert.equal(await objects.get('assets/' + 'c'.repeat(32)), null);
  backend.add(backend.config.B2_PREFIX + a, [], { action: 'hide' });
  backend.add('another-app/' + a, bytes);
  backend.add(backend.config.B2_PREFIX + 'unmanaged.txt', bytes);
  const list = await objects.list();
  assert.deepEqual(new Set(list.map(file => file.key)), new Set([a, b]));
  assert.ok(list.every(file => file.uploaded > 0));
  await objects.deleteMany([a, b]);
  assert.equal(await objects.get(a), null);
  assert.equal(await objects.get(b), null);
  assert.equal(backend.files.length, 2); // Unrelated files are never removed.
  assert.equal(backend.requests.filter(r => r.operation === 'b2_authorize_account').length, 1);
  assert.ok(backend.requests.filter(r => r.operation === 'b2_list_file_versions').length > 3);
});
test('B2 refreshes expired account and upload tokens, sharing concurrent authorization', async () => {
  const backend = fakeB2();
  let expire = true, rejectUpload = true;
  const objects = b2Objects(backend.config, { fetch: async (url, options) => {
    if (String(url).includes('/file/') && expire) { expire = false; return backend.json({ code: 'expired_auth_token' }, 401); }
    if (String(url).endsWith('b2_upload_file') && rejectUpload) { rejectUpload = false; return backend.json({ code: 'expired_auth_token' }, 401); }
    return backend.fetch(url, options);
  } });
  await Promise.all([objects.put(a, new Uint8Array([1])), objects.put(b, new Uint8Array([2]))]);
  assert.equal(backend.requests.filter(r => r.operation === 'b2_authorize_account').length, 1);
  assert.deepEqual(await objects.get(a), new Uint8Array([1]));
  assert.equal(backend.requests.filter(r => r.operation === 'b2_authorize_account').length, 2);
});
test('B2 errors are not treated as missing files and do not leak upstream secrets', async () => {
  const backend = fakeB2();
  let failUpload = false;
  const objects = b2Objects(backend.config, { fetch: async (url, options) => {
    if (String(url).includes('/file/') || (failUpload && String(url).endsWith('b2_upload_file'))) return backend.json({ code: 'unauthorized', message: 'SECRET https://private-url' }, 403);
    return backend.fetch(url, options);
  } });
  await assert.rejects(objects.get(a), error => /403 unauthorized/.test(error.message) && !/SECRET|private-url/.test(error.message));
  failUpload = true;
  await assert.rejects(objects.put(a, new Uint8Array([1])), /403 unauthorized/);
  assert.equal(backend.files.length, 0);
  await assert.rejects(objects.delete('../outside'), /Invalid object key/);
  await assert.rejects(objects.put('assets/../../outside', new Uint8Array()), /Invalid object key/);
  assert.throws(() => b2Objects({}), /Configure B2_APPLICATION_KEY_ID/);
  assert.throws(() => b2Objects({ ...backend.config, B2_PREFIX: '../' }), /B2_PREFIX/);
});
test('B2 rejects a key for the wrong bucket or without delete permission', async () => {
  for (const wrongBucket of [true, false]) {
    const backend = fakeB2();
    const objects = b2Objects(backend.config, { fetch: async (url, options) => {
      const response = await backend.fetch(url, options);
      if (!String(url).endsWith('b2_authorize_account')) return response;
      const data = await response.json();
      if (wrongBucket) data.apiInfo.storageApi.allowed.buckets[0].id = 'wrong';
      else data.apiInfo.storageApi.allowed.capabilities = ['listFiles', 'readFiles', 'writeFiles'];
      return backend.json(data);
    } });
    await assert.rejects(objects.get(a), wrongBucket ? /configured bucket/ : /requires deleteFiles/);
  }
});
