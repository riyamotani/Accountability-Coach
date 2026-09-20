import { createGateway, embed, embedMany } from 'ai';
import { env } from './env.js';
import { EMBEDDING_DIMENSIONS } from '../db/schema.js';

/**
 * Text in, numbers out.
 *
 * An embedding model reads a piece of text and returns a fixed-length list of
 * numbers (a vector) that stands for its MEANING. Two texts that mean similar
 * things get vectors that sit close together, even with no words in common —
 * which is the whole reason the memory layer can answer "why do I keep
 * missing gym?" with a note that never says "gym".
 *
 * Every vector from a given model has the same length (1536 here), which is
 * why the database column has a fixed size. Vectors from DIFFERENT models are
 * not comparable at all, so the model id is stored next to each one.
 */

/**
 * Longer input costs more and, past a point, blurs the meaning: one vector
 * has to stand for the whole text, so a long ramble averages out into
 * something that matches nothing well. Long entries get split before they
 * reach here; this is the backstop.
 */
const MAX_INPUT_CHARS = 2000;

const REQUEST_TIMEOUT_MS = 10000;

let gateway: ReturnType<typeof createGateway> | null = null;

function model() {
  if (!env.aiGatewayApiKey) throw new Error('AI_GATEWAY_API_KEY is not set');
  gateway ??= createGateway({ apiKey: env.aiGatewayApiKey });
  return gateway.textEmbeddingModel(env.aiEmbeddingModel);
}

/** Trim and cap, so the same text always produces the same request. */
function prepare(text: string): string {
  return text.trim().slice(0, MAX_INPUT_CHARS);
}

function assertDimensions(vector: number[]): number[] {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    // Would otherwise fail later, inside Postgres, as a confusing insert
    // error. Usually means AI_EMBEDDING_MODEL was changed without changing
    // the column.
    throw new Error(
      `Expected ${EMBEDDING_DIMENSIONS} dimensions from ${env.aiEmbeddingModel}, got ${vector.length}`,
    );
  }
  return vector;
}

/** One text. Throws on failure, so the caller (a retryable job) can retry. */
export async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({
    model: model(),
    value: prepare(text),
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return assertDimensions(embedding);
}

/**
 * Several texts in ONE request. Used by the backfill job: embedding 500
 * memories one at a time is 500 round trips, and providers price and rate
 * limit per request as well as per token.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { embeddings } = await embedMany({
    model: model(),
    values: texts.map(prepare),
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 3),
  });
  return embeddings.map(assertDimensions);
}

/** The id stored alongside each vector, so a model change is detectable. */
export function currentEmbeddingModel(): string {
  return env.aiEmbeddingModel;
}
