import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { chatMessages, goals, negotiations, type NegotiationStatus } from '../../db/schema.js';
import { describeError } from '../../db/errors.js';

/**
 * The state machine's transitions, kept in one place.
 *
 * Every rule with a guarantee attached lives here rather than in a prompt:
 * how many rounds are allowed, what closing means, and the fact that an
 * agreed change is applied exactly once. A model can be talked out of a rule;
 * a function cannot.
 */

/**
 * After three rounds it is a disagreement, not a negotiation. The bot backs
 * off and leaves the goal alone until the cooldown expires — being argued
 * with by software is worse than being left alone.
 */
export const MAX_ROUNDS = 3;

export interface OpenNegotiation {
  id: string;
  goalId: string;
  goalTitle: string;
  round: number;
  proposal: Record<string, unknown>;
  evidence: Record<string, unknown>;
  createdAt: Date;
  lastMessageAt: Date;
}

/**
 * The user's open negotiation, if any. Loaded on EVERY message, which is
 * what makes a reply work two days and several reminders later: the thread
 * is found by state, not by which message the user happened to reply to.
 */
export async function findOpenNegotiation(userId: string): Promise<OpenNegotiation | undefined> {
  const [row] = await db
    .select({
      id: negotiations.id,
      goalId: negotiations.goalId,
      goalTitle: goals.title,
      round: negotiations.round,
      proposal: negotiations.proposal,
      evidence: negotiations.evidence,
      createdAt: negotiations.createdAt,
      lastMessageAt: negotiations.lastMessageAt,
    })
    .from(negotiations)
    .innerJoin(goals, eq(goals.id, negotiations.goalId))
    .where(and(eq(negotiations.ownerId, userId), eq(negotiations.status, 'proposed')))
    .orderBy(desc(negotiations.createdAt))
    .limit(1);

  return row;
}

export async function createNegotiation(input: {
  goalId: string;
  ownerId: string;
  proposal: Record<string, unknown>;
  evidence: Record<string, unknown>;
}): Promise<{ id: string } | undefined> {
  // onConflictDoNothing against the partial unique index: if a sweep already
  // opened one for this goal, this simply does nothing rather than erroring.
  const [row] = await db
    .insert(negotiations)
    .values({ ...input, status: 'proposed' })
    .onConflictDoNothing()
    .returning({ id: negotiations.id });
  return row;
}

/** The bot answered a counter-offer: same negotiation, next round. */
export async function advanceRound(
  negotiationId: string,
  proposal: Record<string, unknown>,
): Promise<number> {
  const [row] = await db
    .update(negotiations)
    .set({
      // `round + 1` computed IN the database. Reading the round in JavaScript
      // and writing back round+1 would lose one of two replies that arrive
      // together — the classic read-modify-write race.
      round: sql`${negotiations.round} + 1`,
      proposal,
      lastMessageAt: new Date(),
      // A new proposal restarts the silence clock. The already-scheduled
      // nudge re-reads this row when it fires and will see it's been
      // answered since.
      nudgedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(negotiations.id, negotiationId))
    .returning({ round: negotiations.round });
  return row?.round ?? MAX_ROUNDS;
}

export async function closeNegotiation(
  negotiationId: string,
  status: Exclude<NegotiationStatus, 'proposed'>,
): Promise<void> {
  await db
    .update(negotiations)
    .set({ status, closedAt: new Date(), updatedAt: new Date() })
    .where(eq(negotiations.id, negotiationId));
}

/**
 * Record something the BOT said proactively, so it appears in the
 * conversation history the model reads next time.
 *
 * Without this, messages sent by the worker — reminders, follow-ups, and the
 * negotiation proposal itself — exist only in Telegram. The model would then
 * see "yeah let's do 3 days" with no record of having proposed anything, and
 * the reply would be unanswerable.
 *
 * Reminders are deliberately NOT recorded: one per goal per day would crowd
 * the ten-message window and push out actual conversation. Only messages
 * that invite a written reply belong here.
 */
export async function recordBotMessage(userId: string, content: string): Promise<void> {
  try {
    await db.insert(chatMessages).values({ ownerId: userId, role: 'assistant', content });
  } catch (err) {
    console.error('[negotiation] could not record the bot message:', describeError(err));
  }
}
