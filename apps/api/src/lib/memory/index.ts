import { env } from '../env.js';
import { pgvectorStore } from './pgvector-store.js';
import { mem0Store } from './mem0-store.js';
import { enqueueMemorySync } from '../../queue/memories.js';
import type { AddMemoryInput, MemoryHit, MemoryStore, SearchMemoriesInput } from './types.js';

export type { AddMemoryInput, MemoryHit, MemoryStore, SearchMemoriesInput } from './types.js';

export const MEMORY_PROVIDERS = ['pgvector', 'mem0'] as const;
export type MemoryProvider = (typeof MEMORY_PROVIDERS)[number];

/** The hosted provider currently used for SEARCH, or null when it's all ours. */
function activeProvider(): { name: MemoryProvider; store: MemoryStore } | null {
  if (env.memoryProvider === 'mem0' && env.mem0ApiKey) {
    return { name: 'mem0', store: mem0Store };
  }
  return null;
}

/**
 * The store everything else uses. It is not one implementation but a policy
 * over two:
 *
 *   WRITE  → always our Postgres table, synchronously. Then a retryable job
 *            copies it to the hosted provider.
 *   SEARCH → the hosted provider when one is active, falling back to our own
 *            pgvector search if it errors.
 *
 * Why not simply "use Mem0 for everything":
 *
 * 1. Mem0 stores an EXTRACTED, UPDATED fact, not the sentence the user typed.
 *    It will happily replace "lives in Kolkata" with "moved to Berlin" — and
 *    the promise here is long-horizon recall ("six months ago you were X, now
 *    you're Y"), which needs the earlier version to still exist.
 * 2. A provider is a network dependency with a free-tier quota. Ours is a
 *    table in a database we already run: if Mem0 is down, out of quota, or
 *    abandoned, search degrades rather than disappears.
 * 3. Switching providers later must not lose anything. Every raw note lives
 *    in our table, so a new provider can be backfilled from it.
 *
 * The cost of this design is honest: two writes per memory instead of one,
 * and the two can briefly disagree — which is why the copy is a retryable job
 * and never part of the user's request.
 */
const compositeStore: MemoryStore = {
  async add(input: AddMemoryInput) {
    // Source of truth first. If this throws, the user's words were not saved
    // and the caller should know about it.
    const { id } = await pgvectorStore.add(input);

    // Derived index second, out of band. Never awaited, never throws: a
    // provider outage must not fail the user's message.
    if (activeProvider()) void enqueueMemorySync(id);

    return { id };
  },

  async search(input: SearchMemoriesInput): Promise<MemoryHit[]> {
    const provider = activeProvider();
    if (!provider) return pgvectorStore.search(input);

    try {
      return await provider.store.search(input);
    } catch (err) {
      // Falling back rather than failing: worse recall beats no recall, and
      // our own index is always complete, so the fallback is never empty
      // just because the provider is unwell.
      console.error(
        `[memory] ${provider.name} search failed, falling back to pgvector:`,
        err instanceof Error ? err.message : err,
      );
      return pgvectorStore.search(input);
    }
  },
};

export function getMemoryStore(): MemoryStore {
  return compositeStore;
}

/** The provider a sync job should push to, if any. Used by the worker. */
export function getSyncTarget(): { name: MemoryProvider; store: MemoryStore } | null {
  return activeProvider();
}
