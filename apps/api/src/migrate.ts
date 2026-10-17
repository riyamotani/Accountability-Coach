import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './db/client.js';

/**
 * Applies pending database migrations, then exits. Run once per deploy,
 * BEFORE the API and worker start.
 *
 * Locally we use `drizzle-kit migrate`, but drizzle-kit is a development
 * tool and doesn't belong in a production image. drizzle-orm ships a runtime
 * migrator that reads the very same `drizzle/*.sql` files and records them in
 * the very same `drizzle.__drizzle_migrations` table — so a database migrated
 * locally and one migrated here agree about what has already been applied.
 *
 * In production this runs as its own short-lived container. The API only
 * starts once it has exited successfully, which guarantees the code never
 * runs against a schema older than it expects.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/migrate.js → apps/api/drizzle, where the generated SQL lives.
const migrationsFolder = path.resolve(here, '../drizzle');

try {
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  console.log('[migrate] done');
} catch (err) {
  // A failed migration must stop the deploy: starting the new code against a
  // half-migrated schema is worse than keeping the old version running.
  console.error('[migrate] FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
