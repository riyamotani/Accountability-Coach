import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { queueConnection } from './connection.js';
import { env } from '../lib/env.js';
import { db } from '../db/client.js';
import { describeError } from '../db/errors.js';
import { goals, users, type GoalRow } from '../db/schema.js';

export const QUEUE_NAME = 'reminders';

/**
 * One queue, three job types — distinguished by `job.name`, not by separate
 * queues:
 *
 *   reminder   — fired by a per-goal JOB SCHEDULER (repeating, cron-based)
 *   followup   — a one-off DELAYED job, added when a reminder is sent
 *   reconcile  — fired by a system scheduler every few minutes
 *
 * Those are BullMQ's two scheduling primitives side by side: a scheduler
 * produces jobs on a recurring pattern; a delayed job runs once, later.
 */
export const reminderQueue = new Queue(QUEUE_NAME, { connection: queueConnection });

// Without a listener, a Redis connection error is an unhandled 'error' event,
// which crashes the whole Node process — taking the API down with it.
reminderQueue.on('error', (err) => {
  console.error('[queue] redis error:', err.message);
});

/**
 * Recognized spellings of the two TIME units `targetUnit` might contain, in
 * minutes-per-unit. `targetUnit` is free text the user typed into a plain
 * TextInput (see GoalForm) — not a fixed enum — so this is deliberately a
 * small, exact-match list, not an attempt to parse arbitrary text.
 */
const MINUTES_PER_TIME_UNIT: Record<string, number> = {
  min: 1,
  mins: 1,
  minute: 1,
  minutes: 1,
  hr: 60,
  hrs: 60,
  hour: 60,
  hours: 60,
};

const FALLBACK_FOLLOWUP_MS = 2 * 60 * 60 * 1000; // 2 hours
const MIN_FOLLOWUP_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FOLLOWUP_MS = 3 * 60 * 60 * 1000; // 3 hours

/**
 * How long after a reminder to ask "did you do it?" — proportional to the
 * goal's OWN target, not one flat number for every goal.
 *
 * Roughly double the target time: a 30-minute run gets an hour of grace
 * before being asked about. Floored at 15 minutes and capped at 3 hours so
 * neither extreme (a 2-minute goal, a half-marathon) produces a silly delay.
 *
 * Two reasons this falls back to a flat 2 hours, and they're different kinds
 * of "missing":
 *   - `target`/`targetUnit` are OPTIONAL in the dashboard form — a goal with
 *     no target genuinely has no duration to scale from.
 *   - `targetUnit` might be "pages" or "reps" — a real value, just not a
 *     TIME unit, so there's nothing to multiply into minutes.
 * Both land here rather than crashing or guessing.
 */
// `| null`, not just `?`, because an optional (nullable) column comes back
// from Postgres as `null` for "not set". Under exactOptionalPropertyTypes,
// `target?: number` only permits "absent or a number", which would reject a
// real goal row at the call site.
export function followupDelayMsFor(goal: {
  target?: number | null;
  targetUnit?: string | null;
}): number {
  // TESTING OVERRIDE — see env.ts. Wins over everything below, unconditionally,
  // specifically so you don't have to wait hours to see the follow-up fire
  // while developing.
  if (env.followupDelayMinutesOverride !== undefined) {
    return env.followupDelayMinutesOverride * 60 * 1000;
  }

  if (!goal.target || !goal.targetUnit) return FALLBACK_FOLLOWUP_MS;

  const perUnitMinutes = MINUTES_PER_TIME_UNIT[goal.targetUnit.trim().toLowerCase()];
  if (!perUnitMinutes) return FALLBACK_FOLLOWUP_MS; // not a time unit we recognize

  const targetMs = goal.target * perUnitMinutes * 60 * 1000;
  return Math.min(Math.max(targetMs * 2, MIN_FOLLOWUP_MS), MAX_FOLLOWUP_MS);
}

/**
 * No colons in ids. BullMQ builds Redis keys by joining parts with ':', so a
 * custom id containing one is rejected outright.
 */
export function schedulerIdFor(goalId: string): string {
  return `goal-${goalId}`;
}

export function followupJobIdFor(goalId: string, date: string): string {
  return `followup-${goalId}-${date}`;
}

/**
 * Cadence -> cron. `{ daysOfWeek: [0, 6], timeOfDay: "07:15" }` -> "15 7 * * 0,6"
 *
 * Cron fields: minute, hour, day-of-month, month, day-of-week. Cron's
 * day-of-week uses the same 0=Sunday convention as JavaScript's getDay(), so
 * our stored numbers map straight across with no translation.
 */
export function cronPatternFor(cadence: { daysOfWeek: number[]; timeOfDay: string }): string {
  const [hour, minute] = cadence.timeOfDay.split(':').map(Number);
  const days = [...cadence.daysOfWeek].sort((a, b) => a - b).join(',');
  return `${minute} ${hour} * * ${days}`;
}

/**
 * A fingerprint of "exactly when this goal should fire" — the cron pattern
 * plus the timezone it's evaluated in.
 *
 * It's stamped into every job when the schedule is created, and recomputed
 * from the database when the job fires. If the two differ, the job is stale (the
 * goal was edited, or the user changed timezone) and must not send. This is an
 * EXACT comparison — no "roughly the same time" tolerance to tune or get wrong.
 */
export function scheduleKeyFor(pattern: string, timezone: string): string {
  return `${pattern}@${timezone}`;
}

export interface ReminderJobData {
  goalId: string;
  scheduleKey: string;
}

export interface FollowupJobData {
  goalId: string;
  /** The LocalDate the original reminder was for — the follow-up may cross midnight. */
  date: string;
}

/** Retry on failure with growing gaps: ~5s, ~10s, ~20s. */
export const RETRY_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  // Keep Redis from growing forever: retain a recent window for debugging
  // rather than every job that ever ran.
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
} as const;

/**
 * Make BullMQ's schedule for this goal match what Postgres says. Safe to call any
 * number of times — that idempotency is the whole design:
 *
 *   - the normal path calls it after every goal save
 *   - the reconciliation sweep calls it for every active goal, every few minutes
 *   - running it when nothing changed is a no-op
 *
 * It NEVER throws. The API calls this without awaiting it, and a Redis failure
 * must not become a failed HTTP request: Postgres already has the truth, and the
 * reconciliation sweep will repair the schedule. That's the answer to the
 * dual-write problem — don't pretend both writes are atomic; make the second
 * one retryable and the failure harmless.
 */
export async function syncGoalSchedule(goal: GoalRow): Promise<void> {
  const goalId = goal.id;
  try {
    if (goal.status !== 'active') {
      await reminderQueue.removeJobScheduler(schedulerIdFor(goalId));
      return;
    }

    const [user] = await db
      .select({ timezone: users.timezone })
      .from(users)
      .where(eq(users.id, goal.ownerId));
    if (!user) return;

    const pattern = cronPatternFor(goal);

    await reminderQueue.upsertJobScheduler(
      schedulerIdFor(goalId),
      // `tz` is what makes "7:15" mean 7:15 in the USER'S zone rather than the
      // server's — including DST transitions, which BullMQ's cron evaluation
      // handles so we never do that arithmetic ourselves.
      { pattern, tz: user.timezone },
      {
        name: 'reminder',
        data: {
          goalId,
          scheduleKey: scheduleKeyFor(pattern, user.timezone),
        } satisfies ReminderJobData,
        opts: RETRY_OPTS,
      },
    );
  } catch (err) {
    console.error(
      `[scheduler] sync failed for goal ${goalId} — reconciliation will retry:`,
      // This block also reads the database, and a failed query's message
      // carries its parameters. describeError strips them.
      describeError(err),
    );
  }
}

/** Same never-throws contract as syncGoalSchedule. */
export async function removeGoalSchedule(goalId: string): Promise<void> {
  try {
    await reminderQueue.removeJobScheduler(schedulerIdFor(goalId));
  } catch (err) {
    console.error(
      `[scheduler] remove failed for goal ${goalId} — reconciliation will retry:`,
      describeError(err),
    );
  }
}

/**
 * A timezone change invalidates EVERY one of that user's schedules at once —
 * "7:15" now means a different instant. Without this, their reminders would
 * keep firing in the old zone until the next reconciliation pass.
 */
export async function resyncUserGoals(userId: string): Promise<void> {
  const rows = await db.select().from(goals).where(eq(goals.ownerId, userId));
  await Promise.all(rows.map(syncGoalSchedule));
}
