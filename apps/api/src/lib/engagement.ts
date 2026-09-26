import { and, eq, gte, isNull, isNotNull, sql } from 'drizzle-orm';
import { localTimeInZone } from '@coach/shared';
import { db } from '../db/client.js';
import { chatMessages, checkIns, users } from '../db/schema.js';
import { describeError } from '../db/errors.js';

/**
 * Whether the bot should still be talking to someone.
 *
 * A proactive bot has an obligation the rest of the app doesn't: it speaks
 * first. So it needs a rule for when to stop. Reminders that keep arriving
 * for weeks after someone has stopped listening are how an app gets muted,
 * blocked or reported — and every unread AI-written reminder costs money.
 */

/** Silence for this long and the bot says goodbye and stops reminding. */
const DORMANT_AFTER_DAYS = 7;

/**
 * Local hours during which the bot may send an unprompted message. The
 * goodbye is not urgent, and a bot that goes quiet at 4am has managed to be
 * annoying on its way out.
 */
const EARLIEST_HOUR = 9;
const LATEST_HOUR = 21;

export function isReasonableHour(timezone: string): boolean {
  const [hour] = localTimeInZone(timezone).split(':').map(Number);
  return hour !== undefined && hour >= EARLIEST_HOUR && hour < LATEST_HOUR;
}

/**
 * Record that the user did something, and wake the bot if it had gone quiet.
 *
 * Called from the paths that represent a real human action: sending a
 * message, or logging a check-in (dashboard, Telegram button or chat). Never
 * awaited by the caller — this is bookkeeping, and it must not be able to
 * fail someone's request.
 */
export async function touchUserActivity(userId: string): Promise<void> {
  try {
    // Only touches rows that are actually dormant, so the common case costs
    // one cheap indexed UPDATE that matches nothing.
    const woken = await db
      .update(users)
      .set({ dormantSince: null, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNotNull(users.dormantSince)))
      .returning({ id: users.id });

    if (woken.length) console.log(`[engagement] ${userId} is back — reminders resumed`);
  } catch (err) {
    console.error('[engagement] could not clear dormancy:', describeError(err));
  }
}

/** The most recent sign of life: a check-in or a message to the bot. */
export async function lastActivityAt(userId: string): Promise<Date | null> {
  const [activity] = await db
    .select({
      // Typed as a STRING on purpose, because that is what arrives. Drizzle
      // turns timestamps into Date objects only for columns it knows about;
      // a raw SQL expression comes back from the driver as text. This was
      // once annotated `sql<Date | null>` — a promise to the compiler, not a
      // conversion — and `"2026-09-20 …" > someDate` is quietly `false` in
      // JavaScript, so EVERY user looked silent and got the goodbye message.
      at: sql<string | null>`GREATEST(
        (SELECT MAX(${checkIns.createdAt}) FROM ${checkIns} WHERE ${checkIns.ownerId} = ${userId}),
        (SELECT MAX(${chatMessages.createdAt}) FROM ${chatMessages}
           WHERE ${chatMessages.ownerId} = ${userId} AND ${chatMessages.role} = 'user')
      )`,
    })
    .from(users)
    .where(eq(users.id, userId));

  if (!activity?.at) return null;
  const at = new Date(activity.at);
  // Fail loudly rather than silently mis-compare: an unparseable value here
  // is exactly the class of bug that sent a wrongful goodbye.
  if (Number.isNaN(at.getTime())) throw new Error(`Unparseable activity time: ${activity.at}`);
  return at;
}

export interface DormantCandidate {
  id: string;
  displayName: string;
  telegramChatId: string;
  timezone: string;
}

/**
 * Users who have gone quiet and haven't been told yet.
 *
 * Deliberately excludes anyone already dormant: the goodbye is sent once,
 * not once a day. A user who never interacted at all (no check-ins, no
 * messages) is measured from when they linked Telegram, so a brand-new
 * account isn't declared dormant on day one.
 */
export async function findNewlyDormantUsers(): Promise<DormantCandidate[]> {
  const cutoff = new Date(Date.now() - DORMANT_AFTER_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      telegramChatId: users.telegramChatId,
      timezone: users.timezone,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(and(isNotNull(users.telegramChatId), isNull(users.dormantSince)));

  const dormant: DormantCandidate[] = [];
  for (const user of candidates) {
    if (!user.telegramChatId) continue;

    const lastSeen = (await lastActivityAt(user.id)) ?? user.createdAt;
    if (lastSeen > cutoff) continue;
    // Not at 4am their time.
    if (!isReasonableHour(user.timezone)) continue;

    dormant.push({
      id: user.id,
      displayName: user.displayName,
      telegramChatId: user.telegramChatId,
      timezone: user.timezone,
    });
  }

  return dormant;
}

export async function markDormant(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ dormantSince: new Date(), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/** Is the bot currently staying quiet for this user? */
export async function isDormant(userId: string): Promise<boolean> {
  const [user] = await db
    .select({ dormantSince: users.dormantSince })
    .from(users)
    .where(eq(users.id, userId));
  return Boolean(user?.dormantSince);
}

export const ENGAGEMENT_RULE = { DORMANT_AFTER_DAYS, EARLIEST_HOUR, LATEST_HOUR } as const;

/** Checked only for a user who has stopped replying, so it stays short. */
export function goodbyeMessage(displayName: string): string {
  return (
    `Hey ${displayName} — I haven't heard from you in a while, so I'll stop the reminders ` +
    `for now.\n\nSay anything whenever you want them back, and we'll pick up where we left off. 👋`
  );
}
