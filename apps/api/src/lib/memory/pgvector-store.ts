import { and, cosineDistance, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { memories } from '../../db/schema.js';
import { embedText } from '../embeddings.js';
import { enqueueMemoryEmbedding } from '../../queue/memories.js';
import type { AddMemoryInput, MemoryHit, MemoryStore, SearchMemoriesInput } from './types.js';

/**
 * The hand-built memory store: embed, store, search by similarity, using
 * nothing but Postgres + pgvector.
 *
 * This is also the source of truth for the whole memory layer. Rows here are
 * APPEND-ONLY: the user's exact words, never edited, never expiring. A
 * hosted provider can be swapped in as the search index, but this table is
 * what any provider gets rebuilt from, and the only place the full history is
 * guaranteed to survive.
 */

const DEFAULT_LIMIT = 5;

/**
 * Below this similarity, a hit is treated as noise.
 *
 * Measured, not guessed (scripts/memory-scores.ts, cohere/embed-v4.0):
 *   0.63  "work deadlines"             vs "work has been insane this month…"
 *   0.33  "why am I struggling lately" vs the same note — right answer, vague question
 *   0.30  the same question            vs "knee has been hurting…"
 *   0.15  "pasta recipes"              vs anything stored — unrelated
 * So 0.2 sits in the gap between "vaguely asked but genuinely related" and
 * "nothing to do with it". Each embedding model has its own typical range,
 * so this number has to be re-measured if AI_EMBEDDING_MODEL changes.
 */
const DEFAULT_MIN_SCORE = 0.2;
const MAX_LIMIT = 20;

/** Identical text saved again within this window is treated as an echo. */
const ECHO_WINDOW_MS = 24 * 60 * 60 * 1000;

export const pgvectorStore: MemoryStore = {
  /**
   * Writes the row FIRST, embeds it after, in a retryable job.
   *
   * The order is the point. Embedding needs a network call that can fail or
   * be slow; if it ran first, an AI outage would mean losing what the user
   * told us. Written first, the worst case is a memory that isn't searchable
   * for a minute — the words are safe. Same principle as the scheduler:
   * source of truth first, derived index second, and make the second step
   * retryable.
   */
  async add({ userId, content, source }: AddMemoryInput) {
    const text = content.trim();

    /**
     * Echo guard. Relevant memories are put into the model's context before
     * it replies, and it will sometimes "save" one straight back — seen live:
     * a note saved at 06:42 was re-saved word-for-word at 07:33 after being
     * shown to the model. Duplicates crowd the top results, so the same
     * sentence twice pushes a different, useful memory out of the top 3.
     *
     * Deliberately NOT a unique constraint on (owner_id, content): saying the
     * same thing again in three months is SIGNAL — the problem is still
     * there — and the negotiation loop will want to see that it recurred.
     * Only an immediate repeat is an echo, hence the time window.
     */
    const [duplicate] = await db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.ownerId, userId),
          eq(memories.content, text),
          gte(memories.createdAt, new Date(Date.now() - ECHO_WINDOW_MS)),
        ),
      )
      .limit(1);
    if (duplicate) return { id: duplicate.id };

    const [row] = await db
      .insert(memories)
      .values({ ownerId: userId, content: text, source })
      .returning({ id: memories.id });
    if (!row) throw new Error('INSERT ... RETURNING returned no row');

    // Never awaited and never throws: the memory is already safe.
    void enqueueMemoryEmbedding(row.id);

    return { id: row.id };
  },

  /**
   * Nearest-neighbour search: turn the question into a vector, then ask
   * Postgres for the stored vectors closest to it.
   */
  async search({
    userId,
    query,
    limit = DEFAULT_LIMIT,
    since,
    minScore = DEFAULT_MIN_SCORE,
  }: SearchMemoriesInput): Promise<MemoryHit[]> {
    const queryVector = await embedText(query);

    // Cosine DISTANCE is 0 for identical meaning and 2 for opposite; the
    // familiar "1 = perfect match" score is 1 minus it. Computed once and
    // reused, so the SELECT and the WHERE can't drift apart.
    const distance = cosineDistance(memories.embedding, queryVector);
    const score = sql<number>`1 - (${distance})`;

    return db
      .select({
        id: memories.id,
        content: memories.content,
        source: memories.source,
        createdAt: memories.createdAt,
        score,
      })
      .from(memories)
      .where(
        and(
          // ALWAYS first: one user's memories must never surface in another
          // user's search. The filter is part of the query, not a check after.
          eq(memories.ownerId, userId),
          // Rows still waiting to be embedded have no vector to compare.
          isNotNull(memories.embedding),
          since ? gte(memories.createdAt, since) : undefined,
          sql`1 - (${distance}) >= ${minScore}`,
        ),
      )
      // Nearest first. This is the ORDER BY the HNSW index exists to serve.
      .orderBy(distance)
      .limit(Math.min(limit, MAX_LIMIT));
  },
};

/** Everything this user has said, newest first. Not a search — a listing. */
export async function listMemories(userId: string, limit = 50) {
  return db
    .select({
      id: memories.id,
      content: memories.content,
      source: memories.source,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(eq(memories.ownerId, userId))
    .orderBy(desc(memories.createdAt))
    .limit(limit);
}
