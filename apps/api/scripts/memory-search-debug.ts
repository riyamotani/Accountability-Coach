import { asc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { getMemoryStore } from '../src/lib/memory/index.js';

/**
 * Dev tool: run the REAL search path (the same code the assistant's
 * recallNotes tool calls) and print what comes back.
 *
 *   npx tsx scripts/memory-search-debug.ts "why do I keep missing workouts?"
 *
 * memory-scores.ts computes similarity in JavaScript; this one goes through
 * Postgres. Running both is how you tell "the embeddings are wrong" apart
 * from "the query is wrong".
 */

const query = process.argv.slice(2).join(' ').trim() || 'why am I struggling lately?';

const [user] = await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
if (!user) throw new Error('No users in the database');

const store = getMemoryStore();

for (const minScore of [0, 0.25]) {
  const hits = await store.search({ userId: user.id, query, minScore, limit: 10 });
  console.log(`\nminScore=${minScore} → ${hits.length} hit(s)`);
  for (const hit of hits) {
    console.log(`  ${hit.score?.toFixed?.(3) ?? hit.score}  ${hit.content.slice(0, 60)}`);
  }
}

await pool.end();

// The memory store imports the BullMQ queue (add() schedules an embedding
// job), and its Redis connection keeps Node's event loop alive forever — so
// this script printed its results and then hung. A one-off script is allowed
// to be blunt about shutdown; a server would close the connections properly.
process.exit(0);
