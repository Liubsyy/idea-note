// B2 Native API: no SDK or Node-only APIs, so this adapter also runs in Workers.
// Objects stay private; the service checks share visibility before every read.
const API = 'https://api.backblazeb2.com/b2api/v4/b2_authorize_account';
const managedKey = /^(?:restore\/[a-f0-9]{32}\/)?(?:assets|documents)\/[a-f0-9]{32}$/;
const required = ['B2_APPLICATION_KEY_ID', 'B2_APPLICATION_KEY', 'B2_BUCKET_ID', 'B2_BUCKET_NAME'];
const expired = response => response.status === 401;

async function failure(response, operation) {
  const data = await response.json().catch(() => ({}));
  // Upstream messages may contain tokens or URLs. Log only a bounded error code.
  const code = /^[a-z_]{1,80}$/.test(data.code) ? data.code : 'request_failed';
  return new Error(`B2 ${operation}: ${response.status} ${code}`);
}

export function b2Objects(config, { fetch: send = globalThis.fetch } = {}) {
  for (const name of required) if (!config[name] || config[name].startsWith('REPLACE_')) throw new Error(`Configure ${name}`);
  const prefix = config.B2_PREFIX || 'idea-note-share/';
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/$/.test(prefix)) throw new Error('B2_PREFIX must be a relative folder ending in /');
  const name = key => {
    if (!managedKey.test(key)) throw new Error('Invalid object key');
    return prefix + key;
  };
  let authorization, pending;
  async function authorize() {
    if (authorization && authorization.expires > Date.now()) return authorization;
    if (!pending) pending = (async () => {
      const response = await send(API, { headers: { Authorization: 'Basic ' + btoa(`${config.B2_APPLICATION_KEY_ID}:${config.B2_APPLICATION_KEY}`) }, redirect: 'manual' });
      if (!response.ok) throw await failure(response, 'authorize');
      const data = await response.json(), storage = data.apiInfo?.storageApi;
      if (!data.authorizationToken || !storage?.apiUrl || !storage.downloadUrl) throw new Error('Invalid B2 authorization response');
      const allowed = storage.allowed;
      if (allowed?.buckets && !allowed.buckets.some(bucket => bucket.id === config.B2_BUCKET_ID && (!bucket.name || bucket.name === config.B2_BUCKET_NAME))) throw new Error('B2 key does not match the configured bucket');
      if (allowed?.namePrefix && !prefix.startsWith(allowed.namePrefix)) throw new Error('B2 key does not allow B2_PREFIX');
      for (const capability of ['listFiles', 'readFiles', 'writeFiles', 'deleteFiles']) {
        if (!allowed?.capabilities?.includes(capability)) throw new Error(`B2 key requires ${capability}`);
      }
      authorization = { ...storage, token: data.authorizationToken, expires: Date.now() + 23 * 3600000 };
      return authorization;
    })().finally(() => { pending = undefined; });
    return pending;
  }
  async function authenticated(request) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await authorize(), response = await request(auth);
      if (expired(response) && attempt === 0) {
        await response.body?.cancel();
        if (authorization === auth) authorization = undefined;
        continue;
      }
      return response;
    }
  }
  async function call(operation, payload, missing = false) {
    const response = await authenticated(auth => send(`${auth.apiUrl}/b2api/v4/${operation}`, {
      method: 'POST', headers: { Authorization: auth.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), redirect: 'manual',
    }));
    if (!response.ok) {
      const error = await failure(response, operation);
      if (missing && / 400 file_not_present$/.test(error.message)) return null;
      throw error;
    }
    return response.json();
  }
  async function versions(remotePrefix = prefix) {
    const files = [];
    let startFileName, startFileId;
    do {
      const page = await call('b2_list_file_versions', { bucketId: config.B2_BUCKET_ID, prefix: remotePrefix, maxFileCount: 1000, ...(startFileName ? { startFileName, startFileId } : {}) });
      files.push(...page.files);
      startFileName = page.nextFileName;
      startFileId = page.nextFileId;
    } while (startFileName);
    return files;
  }
  async function remove(keys) {
    const names = new Set(keys.map(name));
    if (!names.size) return;
    // Delete exact file IDs, including old versions and hide markers. Deleting
    // only by name (S3 DELETE) would leave billable historical data behind.
    const files = await versions(names.size === 1 ? [...names][0] : prefix);
    for (const file of files) if (names.has(file.fileName)) {
      await call('b2_delete_file_version', { fileName: file.fileName, fileId: file.fileId }, true);
    }
  }
  return {
    put: async (key, bytes) => {
      const fileName = name(key);
      const checksum = [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      // Lease a separate URL for each upload: B2 forbids concurrent use of an
      // upload token. A rejected token is replaced once; never retry endlessly.
      for (let attempt = 0; attempt < 2; attempt++) {
        const upload = await call('b2_get_upload_url', { bucketId: config.B2_BUCKET_ID });
        const response = await send(upload.uploadUrl, { method: 'POST', headers: {
          Authorization: upload.authorizationToken, 'X-Bz-File-Name': encodeURIComponent(fileName),
          'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength), 'X-Bz-Content-Sha1': checksum,
        }, body: bytes, redirect: 'manual' });
        if ((response.status === 401 || response.status === 503) && attempt === 0) { await response.body?.cancel(); continue; }
        if (!response.ok) throw await failure(response, 'upload');
        await response.body?.cancel();
        return;
      }
    },
    get: async key => {
      const fileName = name(key);
      const response = await authenticated(auth => send(`${auth.downloadUrl}/file/${encodeURIComponent(config.B2_BUCKET_NAME)}/${fileName.split('/').map(encodeURIComponent).join('/')}`, {
        headers: { Authorization: auth.token }, redirect: 'manual', cache: 'no-store',
      }));
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) throw await failure(response, 'download');
      return new Uint8Array(await response.arrayBuffer());
    },
    delete: key => remove([key]),
    deleteMany: remove,
    list: async () => {
      const objects = new Map();
      for (const file of await versions()) {
        if (!file.fileName.startsWith(prefix)) continue;
        const key = file.fileName.slice(prefix.length);
        if (!managedKey.test(key)) continue;
        // Use the newest version's age, so cleanup cannot race a fresh upload.
        objects.set(key, Math.max(objects.get(key) || 0, file.uploadTimestamp));
      }
      return [...objects].map(([key, uploaded]) => ({ key, uploaded }));
    },
  };
}
