import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../lib/env.js';
import * as schema from './schema.js';

/**
 * A POOL of connections, not one connection.
 *
 * A Postgres connection handles one query at a time. With a single
 * connection, two HTTP requests arriving together would queue behind each
 * other. The pool keeps up to `max` connections open and lends one to each
 * query. Opening a connection costs a network handshake plus auth, so reusing
 * them is also much faster than connecting per request.
 *
 * `max: 10` is plenty for one API process. Each Postgres connection is a
 * separate server process using real memory, and hosted free tiers cap the
 * total, so more is not better.
 */
export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
});

// An idle connection can be dropped (Postgres restarted, network blip). The
// pool emits that as an 'error' event, and an unhandled 'error' event crashes
// Node. The pool replaces the dead connection by itself; we only need to log.
pool.on('error', (err) => {
  console.error('[db] idle connection error:', err.message);
});

/**
 * The query builder. Passing `schema` enables the relational query API
 * (`db.query.goals.findMany(...)`) in addition to the SQL-like one
 * (`db.select().from(goals)...`).
 */
export const db = drizzle({ client: pool, schema });

export type Db = typeof db;
