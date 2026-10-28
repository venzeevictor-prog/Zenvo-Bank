import pg from 'pg';
import { config } from '../config/index.js';

// NUMERIC is returned as text by pg - never parse monetary values into JS floats.
let pool;
export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: config.dbSsl,
      max: config.dbPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
    });
  }
  return pool;
}
export const query = (text, params) => getPool().query(text, params);

/** Run fn in a transaction. Retries on serialization failures / deadlocks (bounded). */
export async function withTx(fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      if ((err.code === '40001' || err.code === '40P01') && attempt < retries) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}
export async function closePool() { if (pool) { await pool.end(); pool = undefined; } }
