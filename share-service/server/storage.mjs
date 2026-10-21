// The service core only uses these SQL and object-storage contracts. D1 batch
// and SQLite transactions provide the same atomicity for publish and restore.
export function d1Database(binding) {
  const statement = (sql, args = []) => binding.prepare(sql).bind(...args);
  return {
    snapshot: async tables => Object.fromEntries((await binding.batch(tables.map(table => statement(`SELECT * FROM ${table}`)))).map((r,i) => [tables[i],r.results])),
    all: async (sql, args) => (await statement(sql, args).all()).results,
    get: (sql, args) => statement(sql, args).first(),
    run: async (sql, args) => ({ changes: (await statement(sql, args).run()).meta.changes }),
    batch: async (queries) => (await binding.batch(queries.map(([sql, args]) => statement(sql, args))))
      .map(r => ({ changes: r.meta.changes })),
  };
}

export function sqliteDatabase(db) {
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  return {
    snapshot: async tables => {
      db.exec('BEGIN');
      try { const result = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()])); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    all: async (sql, args = []) => db.prepare(sql).all(...args),
    get: async (sql, args = []) => db.prepare(sql).get(...args) ?? null,
    run: async (sql, args = []) => ({ changes: Number(db.prepare(sql).run(...args).changes) }),
    batch: async (queries) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = queries.map(([sql, args = []]) => ({ changes: Number(db.prepare(sql).run(...args).changes) }));
        db.exec('COMMIT');
        return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

export function r2Objects(bucket) {
  return {
    put: async (key, bytes) => { await bucket.put(key, bytes); },
    get: async (key) => {
      const object = await bucket.get(key);
      return object ? new Uint8Array(await object.arrayBuffer()) : null;
    },
    delete: async (key) => { await bucket.delete(key); },
    deleteMany: async keys => { for (let at=0; at<keys.length; at+=1000) await bucket.delete(keys.slice(at,at+1000)); },
    list: async () => {
      const keys = []; let cursor;
      do {
        const page = await bucket.list({ cursor });
        keys.push(...page.objects.map(o => ({ key: o.key, uploaded: o.uploaded.getTime() })));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return keys;
    },
  };
}
