import { env } from '../env.js';
import type { AddMemoryInput, MemoryHit, MemoryStore, SearchMemoriesInput } from './types.js';
import type { MemorySource } from '../../db/schema.js';

/**
 * Mem0's hosted platform, behind the same two-method interface as our
 * hand-built pgvector store.
 *
 * What it does that ours doesn't: Mem0 takes CONVERSATION MESSAGES, decides
 * by itself what is worth remembering, and stores an extracted fact rather
 * than the raw text. Send "ugh mornings are impossible for me, useless before
 * 10am" and it may store "Prefers not to schedule things before 10am". It
 * also merges and updates facts over time.
 *
 * That is the appeal and the catch. It's why our own table stays the source
 * of truth: Mem0's updating means an older fact can be REPLACED, which is
 * exactly the history we promised never to lose ("six months ago you were X").
 *
 * Written against the REST API with plain fetch rather than the `mem0ai` SDK:
 * one less dependency, and the request bodies below show precisely what
 * leaves our server, which matters when what leaves is a user's private
 * notes.
 */

const BASE_URL = 'https://api.mem0.ai';
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Measured with `rerank: true` on, via scripts/mem0-scores.ts, asking
 * "how are my mornings these days?":
 *
 *   0.850  fixed sleep, wakes at 7:00     ← the answer
 *   0.734  mornings are impossible        ← the outdated version, relevant
 *   0.561  insane workload in September   ← tangential
 *   0.379  knee has been hurting          ← unrelated
 *
 * So 0.5 sits between tangential and unrelated. Note how different this is
 * from our pgvector threshold of 0.2: reranking compresses scores UPWARD, so
 * a number carried over from the raw-score world would let noise straight
 * through. Every retrieval change invalidates the thresholds downstream of
 * it — measure again rather than reuse.
 */
const DEFAULT_MIN_SCORE = 0.5;
const DEFAULT_LIMIT = 5;

interface Mem0SearchResult {
  id: string;
  memory: string;
  score: number;
  created_at: string;
  metadata?: { source?: string } | null;
}

async function mem0Fetch<T>(path: string, body: unknown): Promise<T> {
  if (!env.mem0ApiKey) throw new Error('MEM0_API_KEY is not set');

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      // Mem0 uses "Token <key>", not the more common "Bearer <key>".
      Authorization: `Token ${env.mem0ApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    // The body often explains a quota or a malformed filter; the status alone
    // doesn't. Truncated because it is a provider's error text, not ours.
    const detail = await res.text().catch(() => '');
    throw new Error(`Mem0 ${path} failed: ${res.status} ${detail.slice(0, 200)}`);
  }

  return res.json() as Promise<T>;
}

export const mem0Store: MemoryStore = {
  /**
   * Hands Mem0 the text as a conversation turn — its API is message-shaped
   * because extraction is the product: it reads the exchange and decides what
   * the durable fact is.
   *
   * Returns Mem0's event id, not a memory id: extraction happens
   * ASYNCHRONOUSLY, so a memory saved this second may not be searchable for a
   * few more. Our own row (written first, by the store that wraps this) is
   * what makes that delay invisible.
   */
  async add({ userId, content, source }: AddMemoryInput) {
    const result = await mem0Fetch<{ event_id?: string }>('/v3/memories/add/', {
      messages: [{ role: 'user', content }],
      user_id: userId,
      // Carried through so a search result can say where it came from, the
      // same way our own `source` column does.
      metadata: { source },
    });
    return { id: result.event_id ?? 'pending' };
  },

  async search({
    userId,
    query,
    limit = DEFAULT_LIMIT,
    minScore = DEFAULT_MIN_SCORE,
    since,
  }: SearchMemoriesInput): Promise<MemoryHit[]> {
    const { results = [] } = await mem0Fetch<{ results?: Mem0SearchResult[] }>(
      '/v3/memories/search/',
      {
        query,
        // The user id MUST sit inside `filters`; at the top level Mem0
        // rejects the request. This is the tenant boundary — the same role
        // the `owner_id` filter plays in our own SQL.
        filters: { user_id: userId },
        top_k: limit,
        threshold: minScore,
        // Mem0's managed reranker. Off by default, and ordering is exactly
        // what a first comparison against our own store came down to — so it
        // is on here, and the comparison re-run with it. A default is not a
        // recommendation: read what the optional flags do before concluding
        // anything about a service.
        rerank: true,
      },
    );

    return results
      .map((result) => ({
        id: result.id,
        content: result.memory,
        source: (result.metadata?.source ?? 'chat') as MemorySource,
        createdAt: new Date(result.created_at),
        score: result.score,
      }))
      // The score filter is applied AGAIN here, on our side. `threshold` is
      // sent in the request and Mem0 does not enforce it the way our SQL
      // does: results scoring 0.137 came back from a request asking for 0.3.
      // A parameter existing is not proof it behaves as its name suggests —
      // check against real responses, then enforce what you actually need.
      //
      // Mem0 has no "since" parameter at all, so that filter lives here too.
      // Both mean this can return FEWER than `limit` results, because the
      // provider already chose its top k before we filtered.
      .filter((hit) => hit.score >= minScore)
      .filter((hit) => !since || hit.createdAt >= since);
  },
};
