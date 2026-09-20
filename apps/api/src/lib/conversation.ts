import type { ModelMessage } from 'ai';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { chatMessages } from '../db/schema.js';

/**
 * The last few turns of the conversation, so the assistant can resolve "it",
 * "that one", "make it later" — none of which mean anything on their own.
 *
 * This is short-term memory. Long-term memory (what is TRUE about the user)
 * lives in lib/memory and is retrieved by meaning instead of recency.
 */

/**
 * Ten messages is five exchanges — enough for "add a goal" → "yes" → "make it
 * 10pm" → "actually Tuesdays too". Every message costs tokens on every
 * request, and more history also makes a small model likelier to answer the
 * wrong question, so this stays deliberately short.
 */
const HISTORY_LIMIT = 10;

/**
 * Older than this and the thread is almost certainly a new conversation.
 * Replaying yesterday's chat would have the bot answering a question the user
 * has long since moved past.
 */
const HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Recent turns, oldest first — the order a model expects to read them in. */
export async function loadRecentTurns(userId: string): Promise<ModelMessage[]> {
  // Newest first in SQL (that's what the index serves and what LIMIT needs),
  // then reversed in memory so the model reads them chronologically.
  const rows = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.ownerId, userId),
        gte(chatMessages.createdAt, new Date(Date.now() - HISTORY_WINDOW_MS)),
      ),
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(HISTORY_LIMIT);

  return rows.reverse().map((row) => ({ role: row.role, content: row.content }));
}

/**
 * Store both halves of one exchange.
 *
 * Written AFTER the model has replied, and as one insert, so a failed reply
 * never leaves a question in the history with no answer — which would make
 * the next turn read as if the bot had ignored the user.
 */
export async function saveTurn(
  userId: string,
  userMessage: string,
  assistantMessage: string,
): Promise<void> {
  await db.insert(chatMessages).values([
    { ownerId: userId, role: 'user', content: userMessage },
    { ownerId: userId, role: 'assistant', content: assistantMessage },
  ]);
}
