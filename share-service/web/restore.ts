import { Unzip, UnzipPassThrough, strFromU8 } from 'fflate';
// One request per stored ZIP entry stays within Cloudflare's request limit.
export async function restoreArchive(file: File, progress: (text: string) => void) {
  const call = async (path: string, method: string, body?: BodyInit) => {
    const response = await fetch('/api/v1/admin/restore/' + path, { method, headers: { 'X-Share-CSRF': '1' }, body });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Restore failed'); return result;
  };
  const job = await call('start', 'POST');
  let manifest: string | undefined, failure: Error | undefined;
  const pending: Promise<unknown>[] = [], seen = new Set<string>();
  const unzip = new Unzip(entry => {
    if (entry.compression !== 0 || seen.has(entry.name) || (entry.name !== 'manifest.json' && !/^objects\/(documents|assets)\/[a-f0-9]{32}$/.test(entry.name))) { failure = new Error('Invalid backup archive'); return; }
    seen.add(entry.name); let chunks: Uint8Array[] = [], length = 0;
    entry.ondata = (error, data, final) => {
      if (error) { failure = error; return; }
      length += data.length;
      if (length > (entry.name === 'manifest.json' ? 16 : 100) * 1048576) { failure = new Error('Backup entry too large'); entry.terminate(); return; }
      chunks.push(data);
      if (final) {
        const bytes = new Uint8Array(length); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; } chunks = [];
        if (entry.name === 'manifest.json') manifest = strFromU8(bytes);
        else { progress(entry.name); pending.push(call(`${job.id}/${entry.name}`, 'PUT', bytes)); }
      }
    }; entry.start();
  }); unzip.register(UnzipPassThrough);
  const reader = file.stream().getReader();
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; unzip.push(value, false); if (failure) throw failure; await Promise.all(pending.splice(0)); }
    unzip.push(new Uint8Array(), true); if (failure) throw failure; await Promise.all(pending);
    if (!manifest) throw new Error('Missing backup manifest');
    progress('Applying metadata…'); await call(`${job.id}/commit`, 'POST', manifest);
  } catch (error) {
    await reader.cancel().catch(() => {}); await call(job.id, 'DELETE').catch(() => {}); throw error;
  }
}
