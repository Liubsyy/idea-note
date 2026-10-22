import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Protocol fake only: tests still exercise the production adapter and Worker.
export function fakeB2({ pageSize = 1000 } = {}) {
  const config = { B2_APPLICATION_KEY_ID: 'test-key-id', B2_APPLICATION_KEY: 'test-secret', B2_BUCKET_ID: 'bucket-id', B2_BUCKET_NAME: 'private-test', B2_PREFIX: 'idea-note-share/' };
  const files = [], requests = [];
  let sequence = 0, token = 0;
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const add = (fileName, bytes, extra = {}) => {
    const file = { fileName, fileId: 'version-' + ++sequence, action: 'upload', uploadTimestamp: Date.now(), bytes: new Uint8Array(bytes), ...extra };
    files.push(file); return file;
  };
  const fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url), operation = url.pathname.split('/').at(-1);
    requests.push({ url: request.url, headers: request.headers, operation });
    if (operation === 'b2_authorize_account') {
      assert.equal(url.origin, 'https://api.backblazeb2.com');
      assert.equal(request.headers.get('authorization'), 'Basic ' + btoa('test-key-id:test-secret'));
      return json({ authorizationToken: 'account-' + ++token, apiInfo: { storageApi: {
        apiUrl: 'https://api-test.backblazeb2.com', downloadUrl: 'https://files-test.backblazeb2.com',
        allowed: { buckets: [{ id: config.B2_BUCKET_ID, name: config.B2_BUCKET_NAME }], capabilities: ['listFiles', 'readFiles', 'writeFiles', 'deleteFiles'], namePrefix: null },
      } } });
    }
    if (operation === 'b2_upload_file') {
      assert.match(request.headers.get('authorization'), /^upload-/);
      const bytes = new Uint8Array(await request.arrayBuffer());
      assert.equal(request.headers.get('content-length'), String(bytes.length));
      assert.equal(request.headers.get('x-bz-content-sha1'), createHash('sha1').update(bytes).digest('hex'));
      return json(add(decodeURIComponent(request.headers.get('x-bz-file-name')), bytes));
    }
    assert.equal(request.headers.get('authorization'), 'account-' + token);
    if (url.pathname.startsWith('/file/')) {
      const name = url.pathname.slice(('/file/' + config.B2_BUCKET_NAME + '/').length).split('/').map(decodeURIComponent).join('/');
      const file = files.filter(file => file.fileName === name).at(-1);
      return file?.action === 'upload' ? new Response(file.bytes) : json({ code: 'file_not_present' }, 404);
    }
    assert.equal(request.method, 'POST');
    assert.match(url.pathname, /^\/b2api\/v4\//);
    const payload = await request.json();
    if (operation === 'b2_get_upload_url') {
      assert.equal(payload.bucketId, config.B2_BUCKET_ID);
      return json({ uploadUrl: 'https://upload-test.backblazeb2.com/b2api/v4/b2_upload_file', authorizationToken: 'upload-' + ++sequence });
    }
    if (operation === 'b2_list_file_versions') {
      assert.equal(payload.bucketId, config.B2_BUCKET_ID);
      const sorted = files.filter(file => file.fileName.startsWith(payload.prefix)).sort((a, b) => a.fileName.localeCompare(b.fileName) || b.uploadTimestamp - a.uploadTimestamp || b.fileId.localeCompare(a.fileId));
      const start = payload.startFileName ? sorted.findIndex(file => file.fileName === payload.startFileName && file.fileId === payload.startFileId) : 0;
      assert.ok(start >= 0);
      const page = sorted.slice(start, start + Math.min(pageSize, payload.maxFileCount)), next = sorted[start + page.length];
      return json({ files: page, nextFileName: next?.fileName || null, nextFileId: next?.fileId || null });
    }
    if (operation === 'b2_delete_file_version') {
      const at = files.findIndex(file => file.fileId === payload.fileId && file.fileName === payload.fileName);
      if (at === -1) return json({ code: 'file_not_present' }, 400);
      return json(files.splice(at, 1)[0]);
    }
    throw new Error('Unexpected B2 request: ' + request.url);
  };
  return { config, files, requests, fetch, add, json };
}
