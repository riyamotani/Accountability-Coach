import { desc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { memories } from '../src/db/schema.js';
import { embedText } from '../src/lib/embeddings.js';

/**
 * Dev tool: print the similarity score of every stored memory against a
 * query, with no threshold and no AI answering on top.
 *
 *   npx tsx scripts/memory-scores.ts "why do I keep missing workouts?"
 *
 * Why this exists: "the bot didn't use my notes" has several possible causes
 * — nothing saved, nothing embedded, the model never searched, or the scores
 * fell below the cutoff. The first three are visible in the database and the
 * logs; this shows the fourth. Guessing at a threshold without seeing real
 * numbers is how you end up with a cutoff that's wrong in both directions.
 *
 * Cost: ONE embedding call for the query (~$0.000001 at typical rates, and
 * free on the Gateway's free-tier models). It does not write anything.
 */

const query = process.argv.slice(2).join(' ').trim();
if (!query) {
  console.error('Usage: npx tsx scripts/memory-scores.ts "<query>"');
  process.exit(1);
}

/** Cosine similarity, computed here rather than in SQL so the maths is visible. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y; // how much the two vectors point the same way
    magA += x * x;
    magB += y * y;
  }
  // Divide by both lengths so only DIRECTION counts, not magnitude.
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

const queryVector = await embedText(query);

const rows = await db
  .select({
    content: memories.content,
    embedding: memories.embedding,
    createdAt: memories.createdAt,
  })
  .from(memories)
  .orderBy(desc(memories.createdAt));

const scored = rows
  .filter((row): row is typeof row & { embedding: number[] } => row.embedding !== null)
  .map((row) => ({
    score: cosineSimilarity(queryVector, row.embedding),
    content: row.content,
  }))
  .sort((a, b) => b.score - a.score);

console.log(`\nQuery: "${query}"`);
console.log(`Dimensions: ${queryVector.length}`);
console.log(`Memories with an embedding: ${scored.length}\n`);

for (const { score, content } of scored) {
  const bar = '█'.repeat(Math.max(0, Math.round(score * 40)));
  console.log(`${score.toFixed(3)} ${bar} ${content.slice(0, 70)}`);
}

console.log('\n1.000 = identical meaning, 0 = unrelated.');

await pool.end();
