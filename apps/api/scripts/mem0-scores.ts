import { asc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { mem0Store } from '../src/lib/memory/mem0-store.js';

/**
 * Dev tool: ask Mem0 the same question our own store gets asked, and print
 * what it returns with its scores.
 *
 *   npx tsx scripts/mem0-scores.ts "how are my mornings these days?"
 *
 * The twin of scripts/memory-scores.ts (which scores OUR pgvector store).
 * Running both on one question is the comparison that decides which provider
 * to keep — the facts each holds, and the scores each assigns.
 *
 * It bypasses the chat model entirely, so it neither burns the 5-requests-
 * per-minute limit nor depends on the model deciding to search. Costs one
 * Mem0 retrieval from the monthly quota.
 *
 * Note: minScore is set to 0 here on purpose. The point is to SEE the raw
 * scores, which is how the threshold gets chosen rather than guessed.
 */

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Usage: npx tsx scripts/mem0-scores.ts "<query>"');
  process.exit(1);
}

const [user] = await db.select().from(users).orderBy(asc(users.createdAt)).limit(1);
if (!user) throw new Error('No users in the database');

const hits = await mem0Store.search({ userId: user.id, query, limit: 10, minScore: 0 });

console.log(`\nQuery: "${query}"`);
console.log(`Mem0 returned ${hits.length} memor(ies)\n`);

for (const hit of hits) {
  const bar = '█'.repeat(Math.max(0, Math.round(hit.score * 40)));
  console.log(
    `${hit.score.toFixed(3)} ${bar} ${hit.content.slice(0, 70)}  (${hit.createdAt.toISOString().slice(0, 10)})`,
  );
}

await pool.end();
