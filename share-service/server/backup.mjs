// Streaming ZIP archives keep a full service backup independent of the Worker
// memory limit. Each object is processed individually; the ZIP uses stored
// entries so restoring needs no decompression or large archive-sized buffer.
import { Zip, ZipPassThrough, Unzip, UnzipPassThrough, strToU8, strFromU8 } from 'fflate';
const TABLES = {
  publishers: ['id','name','token_hash','enabled','expires_at','max_shares','max_bytes','created_at'],
  shares: ['id','owner','title','status','version','stage_id','doc_key','bytes','expires_at','created_at','updated_at'],
  stages: ['id','owner','share_id','base_version','state','created_at'],
  assets: ['id','stage_id','name','mime','bytes','object_key','created_at'],
  settings: ['id','json'], audit: ['id','actor','action','target','at'],
};
const objectKey = key => /^(documents|assets)\/[a-f0-9]{32}$/.test(key);
export async function exportBackup(db, objects) {
  // One read snapshot prevents simultaneous publication from pairing different
  // revisions. D1 batch executes statements in the same transaction.
  const tables=await db.snapshot(Object.keys(TABLES));
  const live=new Set(tables.shares.map(s=>s.stage_id));
  tables.stages=tables.stages.filter(s=>live.has(s.id));
  tables.assets=tables.assets.filter(a=>live.has(a.stage_id));
  const originalKeys=new Map();
  const canonical=key=>key.replace(/^restore\/[a-f0-9]{32}\//,'');
  for(const share of tables.shares){originalKeys.set(canonical(share.doc_key),share.doc_key);share.doc_key=canonical(share.doc_key);}
  for(const asset of tables.assets){originalKeys.set(canonical(asset.object_key),asset.object_key);asset.object_key=canonical(asset.object_key);}
  const keys=[...originalKeys.keys()];
  // Reject inconsistent snapshots before starting the archive response.
  for(const share of tables.shares)if(!tables.stages.some(s=>s.id===share.stage_id))throw new Error('Backup snapshot changed; retry');
  const manifest=strToU8(JSON.stringify({format:'idea-note-share-backup',version:1,tables}));
  let next=0,done=false,zip;
  const stream=new ReadableStream({
    start(controller){zip=new Zip((error,data)=>{if(error)controller.error(error);else controller.enqueue(data);});
      const entry=new ZipPassThrough('manifest.json');zip.add(entry);entry.push(manifest,true);},
    async pull(controller){
      if(done)return;
      try{
        if(next<keys.length){const key=keys[next++],bytes=await objects.get(originalKeys.get(key));if(!bytes)throw new Error('Backup resource missing');const entry=new ZipPassThrough('objects/'+key);zip.add(entry);entry.push(bytes,true);}
        else{done=true;zip.end();controller.close();}
      }catch(error){done=true;controller.error(error);}
    },
    cancel(){done=true;},
  });
  return new Response(stream,{headers:{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="idea-note-share-backup.zip"'}});
}
export async function importBackup(request,db,objects){
  if(await db.get('SELECT id FROM publishers LIMIT 1'))throw new Error('Restore requires an empty instance');
  const reader=request.body?.getReader();if(!reader)throw new Error('Missing backup');
  let manifest,manifestSeen=false,failure,total=0;
  const present=new Set(),writes=[];
  const unzip=new Unzip(file=>{
    try{
      if(file.compression!==0)throw new Error('Only service-generated stored ZIP archives are supported');
      if(file.name!=='manifest.json'&&!/^objects\/(documents|assets)\/[a-f0-9]{32}$/.test(file.name))throw new Error('Invalid archive path');
      if(present.has(file.name))throw new Error('Duplicate archive entry');present.add(file.name);
      let chunks=[],bytes=0;
      file.ondata=(error,data,final)=>{
        if(error){failure=error;return;}
        bytes+=data.length;const limit=file.name==='manifest.json'?16*1024*1024:100*1024*1024;
        if(bytes>limit){failure=new Error('Archive entry exceeds limit');file.terminate();return;}
        chunks.push(data);
        if(final){const value=new Uint8Array(bytes);let at=0;for(const chunk of chunks){value.set(chunk,at);at+=chunk.length;}chunks=[];
          if(file.name==='manifest.json'){try{manifest=JSON.parse(strFromU8(value));manifestSeen=true;}catch(error){failure=error;}}
          else writes.push(objects.put(file.name.slice('objects/'.length),value));
        }
      };file.start();
    }catch(error){failure=error;}
  });unzip.register(UnzipPassThrough);
  try{
    for(;;){const {value,done}=await reader.read();if(done)break;total+=value.length;if(total>10*1024**3)throw new Error('Backup exceeds 10 GiB');unzip.push(value,false);if(failure)throw failure;await Promise.all(writes.splice(0));}
    unzip.push(new Uint8Array(),true);if(failure)throw failure;await Promise.all(writes);
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  if(!manifestSeen||manifest.format!=='idea-note-share-backup'||manifest.version!==1)throw new Error('Unsupported backup');
  const queries=restoreQueries(manifest,present);
  // A durable singleton gate plus its SQL trigger makes empty-instance restore
  // atomic with concurrent imports and publisher creation.
  queries.unshift(['INSERT INTO restore_guard(id) VALUES(1)',[]],['DELETE FROM settings',[]],['DELETE FROM audit',[]]);
  await db.batch(queries);
}

export function restoreQueries(manifest,present,keyPrefix=''){
  if(manifest?.format!=='idea-note-share-backup'||manifest.version!==1)throw new Error('Unsupported backup');
  const queries=[];
  for(const [table,fields]of Object.entries(TABLES)){
    if(!Array.isArray(manifest.tables?.[table]))throw new Error('Missing backup table');
    let chunk=[],chunkBytes=2;
    const flush=()=>{if(!chunk.length)return;queries.push([`INSERT INTO ${table}(${fields.join(',')}) SELECT ${fields.map(k=>`json_extract(value,'$.${k}')`).join(',')} FROM json_each(?)`,[JSON.stringify(chunk)]]);chunk=[];chunkBytes=2;};
    for(const row of manifest.tables[table]){
      if(!row||!fields.every(k=>Object.hasOwn(row,k)&&(row[k]===null||['number','string'].includes(typeof row[k]))))throw new Error('Invalid backup row');
      const mapped=Object.fromEntries(fields.map(k=>[k,(k==='doc_key'||k==='object_key')?keyPrefix+row[k]:row[k]]));
      const bytes=strToU8(JSON.stringify(mapped)).length;
      if(bytes>512*1024)throw new Error('Backup row too large');
      if(chunkBytes+bytes+1>512*1024)flush();
      chunk.push(mapped);chunkBytes+=bytes+1;
      if(table==='shares'||table==='assets'){
        const key=row.doc_key||row.object_key;
        if(!objectKey(key)||!present.has('objects/'+key))throw new Error('Backup resource missing');
      }
    }
    flush();
  }
  return queries;
}
