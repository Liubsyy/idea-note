import { Zip, ZipPassThrough, strToU8 } from 'fflate';

type Snapshot = { manifest: { format: string; version: number }; objects: { key: string; storageKey: string }[] };
type Sink = { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> };

// One HTTP request per object avoids the Workers Free external-request limit.
// Build the same stored ZIP format that the existing restore flow accepts.
export async function writeBackupArchive(write: (chunk: Uint8Array) => Promise<void>, progress: (text: string) => void) {
  const get = async (path: string) => {
    const response = await fetch('/api/v1/admin/backup/' + path);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Backup failed: HTTP ${response.status}`);
    }
    return response;
  };
  const snapshot: Snapshot = await (await get('manifest')).json();
  if (snapshot.manifest?.format !== 'idea-note-share-backup' || snapshot.manifest.version !== 1 || !Array.isArray(snapshot.objects)) throw new Error('Invalid backup manifest');
  let pending = Promise.resolve(), failure: Error | null = null;
  const zip = new Zip((error, data) => {
    if (error) { failure = error; return; }
    pending = pending.then(() => write(data));
  });
  const add = async (name: string, bytes: Uint8Array) => {
    const entry = new ZipPassThrough(name); zip.add(entry); entry.push(bytes, true);
    if (failure) throw failure;
    await pending;
  };
  try {
    await add('manifest.json', strToU8(JSON.stringify(snapshot.manifest)));
    const seen = new Set<string>();
    for (const object of snapshot.objects) {
      if (!/^(assets|documents)\/[a-f0-9]{32}$/.test(object.key) || !/^(?:restore\/[a-f0-9]{32}\/)?(assets|documents)\/[a-f0-9]{32}$/.test(object.storageKey) || seen.has(object.key)) throw new Error('Invalid backup object');
      seen.add(object.key); progress(`${seen.size} / ${snapshot.objects.length}`);
      await add('objects/' + object.key, new Uint8Array(await (await get('objects/' + object.storageKey)).arrayBuffer()));
    }
    zip.end(); if (failure) throw failure; await pending;
  } catch (error) { zip.terminate(); throw error; }
}

export async function downloadBackup(progress: (text: string) => void) {
  const picker = (window as typeof window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable: () => Promise<Sink> }> }).showSaveFilePicker;
  let sink: Sink | undefined;
  try {
    // Invoke the picker before any network await, while user activation is live.
    if (picker) sink = await (await picker.call(window, { suggestedName: 'idea-note-share-backup.zip' })).createWritable();
    const chunks: BlobPart[] = [];
    await writeBackupArchive(async chunk => { if (sink) await sink.write(chunk); else chunks.push(new Uint8Array(chunk)); }, progress);
    if (sink) await sink.close();
    else {
      const url = URL.createObjectURL(new Blob(chunks, { type: 'application/zip' })), link = document.createElement('a');
      link.href = url; link.download = 'idea-note-share-backup.zip'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch (error) {
    await sink?.abort().catch(() => {});
    if ((error as Error).name !== 'AbortError') throw error;
  }
}
