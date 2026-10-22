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
