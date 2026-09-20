import type { MemorySource } from '../../db/schema.js';

/**
 * ONE interface, three implementations later: our own pgvector store (built
 * first, by hand), Mem0's hosted platform, and Supermemory as the fallback
 * when Mem0's free quota runs out. Everything above this line — the
 * assistant's tools, the bot, the dashboard — only ever sees these two
 * methods, so swapping providers is a config change, not a rewrite.
 *
 * Deliberately tiny. A wider interface (update, tags, per-provider options)
 * would be shaped by whichever provider we implemented first, and the others
 * would then have to fake the parts they don't have.
 */
export interface MemoryStore {
  /** Remember something the user said. Returns the stored memory's id. */
  add(input: AddMemoryInput): Promise<{ id: string }>;

  /** Find what they said that RELATES to `query`, most similar first. */
  search(input: SearchMemoriesInput): Promise<MemoryHit[]>;
}

export interface AddMemoryInput {
  userId: string;
  /** The user's own words, not a summary of them. */
  content: string;
  source: MemorySource;
}

export interface SearchMemoriesInput {
  userId: string;
  /** Free text. Matched by MEANING, not by the words it contains. */
  query: string;
  limit?: number;
  /** Only memories saved on or after this instant. For "since March" questions. */
  since?: Date;
  /**
   * 0–1. Below this similarity, a result is noise: with no good match, the
   * nearest neighbours are still *some* rows, and feeding those to the model
   * invites it to explain a connection that isn't there.
   */
  minScore?: number;
}

export interface MemoryHit {
  id: string;
  content: string;
  source: MemorySource;
  createdAt: Date;
  /** 1 = identical meaning, 0 = unrelated. */
  score: number;
}
