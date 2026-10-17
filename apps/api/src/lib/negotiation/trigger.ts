import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { localDateInZone, type LocalDate } from '@coach/shared';
import { db } from '../../db/client.js';
import {
  chatMessages,
  checkIns,
  goals,
  negotiations,
  pauseWindows,
  users,
} from '../../db/schema.js';

/**
 * "Is this goal worth renegotiating?" — decided entirely in code, before the
 * model is involved at all.
 *
 * This is the cheap deterministic FILTER in front of an expensive model
 * judgment. Asking the AI about every goal every day would cost a call per
 * goal, vary run to run, and be impossible to test or explain a month later
 * ("why did it message me?"). So code decides WHO is worth talking about,
 * and the model decides WHAT to say — with all the detail gathered here.
 */

/** How far back the evidence window reaches. */
const WINDOW_DAYS = 14;

/** Below this many DUE occurrences there isn't enough evidence to act on. */
const MIN_DUE_OCCURRENCES = 4;

/** Completion at or above this is fine; below it is a conversation. */
const COMPLETION_THRESHOLD = 0.5;

/**
 * A partial counts as half.
 *
 * It only affects whether the CONVERSATION starts, never what gets proposed.
 * Consistently doing a third of a goal is one of the clearest signs the goal
 * is mis-sized, so it shouldn't count as untroubled success — but it isn't a
 * miss either; the person turned up.
 */
const PARTIAL_CREDIT = 0.5;

/** No second negotiation about the same goal within this many days. */
const COOLDOWN_DAYS = 14;

/** A goal just created or just changed gets this long to prove itself. */
const GRACE_DAYS = 7;

/**
 * A user who has done NOTHING for this long isn't failing at a goal — they
 * have stopped using the app. Renegotiating with silence is pointless and
 * faintly insulting; the dormancy check in the worker handles them instead.
 */
const ENGAGEMENT_WINDOW_DAYS = 7;

export interface OccurrenceOutcome {
  date: LocalDate;
  /** `missed` means no row at all — absence is how a miss is recorded. */
  status: 'done' | 'partial' | 'skipped' | 'missed';
  /** What they actually logged, when they logged an amount. */
  value?: number;
  note?: string;
}

export interface GoalEvidence {
  /** Occurrences the cadence scheduled in the window, minus paused days. */
  due: number;
  /** Weighted: done = 1, partial = 0.5. */
  completed: number;
  completionRate: number;
  counts: { done: number; partial: number; skipped: number; missed: number };
  /** Days removed because they fell inside a pause window. */
  pausedDays: number;
  windowFrom: LocalDate;
  windowTo: LocalDate;
  /**
   * Every due occurrence with what happened. This is what the model reasons
   * over: which weekdays slip, whether misses are deliberate skips or silent
   * absences, and what the notes said.
   */
  occurrences: OccurrenceOutcome[];
  /** Average logged amount vs the goal's target — "12 of 30 minutes". */
  averageValue: number | null;
  /** Weekdays (0-6) where at least half the occurrences went unfinished. */
  weakDays: number[];
}

/** Yesterday backwards: today is still in progress and can't be a miss yet. */
function windowDates(timezone: string): LocalDate[] {
  const dates: LocalDate[] = [];
  for (let daysAgo = 1; daysAgo <= WINDOW_DAYS; daysAgo++) {
    const day = new Date();
    day.setDate(day.getDate() - daysAgo);
    dates.push(localDateInZone(timezone, day));
  }
  return dates.reverse(); // oldest first
}

/** 0 = Sunday … 6 = Saturday, read from a "YYYY-MM-DD" string. */
function dayOfWeek(localDate: LocalDate): number {
  // Parsed as UTC so the weekday can't shift with the server's timezone. A
  // LocalDate is a calendar day, not an instant.
  return new Date(`${localDate}T00:00:00Z`).getUTCDay();
}

/**
 * How this goal has actually been going — in OCCURRENCES, not calendar days.
 *
 * A Mondays-only goal has 2 due occurrences per fortnight, not 14. Counting
 * days would make every weekly goal look like a disaster.
 */
export async function gatherEvidence(
  goal: { id: string; ownerId: string; daysOfWeek: number[]; createdAt?: Date },
  timezone: string,
): Promise<GoalEvidence> {
  const dates = windowDates(timezone);
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;

  // A day before the goal EXISTED is not a missed day. Without this, a goal
  // created last Tuesday would show the preceding week as a run of misses and
  // look like a disaster on day one.
  const createdOn = goal.createdAt ? localDateInZone(timezone, goal.createdAt) : undefined;

  const scheduled = dates.filter(
    (date) => goal.daysOfWeek.includes(dayOfWeek(date)) && (!createdOn || date >= createdOn),
  );

  // Pause windows REMOVE days from the denominator entirely. A paused day is
  // neither done nor skipped — the user was away, and counting it as a miss
  // is exactly how a bot ends up renegotiating a goal that was never in
  // trouble.
  const pauses = await db
    .select({ from: pauseWindows.from, to: pauseWindows.to })
    .from(pauseWindows)
    .where(
      and(
        eq(pauseWindows.ownerId, goal.ownerId),
        lte(pauseWindows.from, to),
        gte(pauseWindows.to, from),
      ),
    );

  const due = scheduled.filter(
    (date) => !pauses.some((pause) => pause.from <= date && date <= pause.to),
  );

  const rows = due.length
    ? await db
        .select({
          date: checkIns.date,
          status: checkIns.status,
          value: checkIns.value,
          note: checkIns.note,
        })
        .from(checkIns)
        .where(and(eq(checkIns.goalId, goal.id), inArray(checkIns.date, due)))
    : [];

  const byDate = new Map(rows.map((row) => [row.date, row]));

  const occurrences: OccurrenceOutcome[] = due.map((date) => {
    const row = byDate.get(date);
    // No row means it simply never happened. Nothing is ever written for a
    // miss, which is why the due list comes from the cadence.
    if (!row) return { date, status: 'missed' as const };
    return {
      date,
      status: row.status,
      ...(row.value != null ? { value: row.value } : {}),
      ...(row.note ? { note: row.note } : {}),
    };
  });

  const counts = {
    done: occurrences.filter((o) => o.status === 'done').length,
    partial: occurrences.filter((o) => o.status === 'partial').length,
    skipped: occurrences.filter((o) => o.status === 'skipped').length,
    missed: occurrences.filter((o) => o.status === 'missed').length,
  };

  const completed = counts.done + counts.partial * PARTIAL_CREDIT;

  const values = occurrences.map((o) => o.value).filter((v): v is number => v != null);
  const averageValue = values.length
    ? values.reduce((sum, v) => sum + v, 0) / values.length
    : null;

  // Which weekdays go badly — the evidence behind "weekends always slip".
  const weakDays: number[] = [];
  for (const day of new Set(due.map(dayOfWeek))) {
    const onThatDay = occurrences.filter((o) => dayOfWeek(o.date) === day);
    const good = onThatDay.filter((o) => o.status === 'done').length;
    if (onThatDay.length >= 2 && good / onThatDay.length < 0.5) weakDays.push(day);
  }

  return {
    due: due.length,
    completed,
    completionRate: due.length === 0 ? 1 : completed / due.length,
    counts,
    pausedDays: scheduled.length - due.length,
    windowFrom: from,
    windowTo: to,
    occurrences,
    averageValue,
    weakDays,
  };
}

/**
 * Is this user still here at all?
 *
 * Any sign of life counts: a check-in (dashboard, button or chat), or a
 * message to the bot. Without this, two weeks of silence would look like
 * "every goal is failing" and the sweep would open a negotiation on ALL of
 * them — arguing with an empty room. Silence is a different problem, handled
 * by the dormancy check, and it has a different answer.
 */
export async function hasRecentEngagement(userId: string): Promise<boolean> {
  const since = new Date(Date.now() - ENGAGEMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [row] = await db
    .select({ found: sql<number>`1` })
    .from(checkIns)
    .where(and(eq(checkIns.ownerId, userId), gte(checkIns.createdAt, since)))
    .limit(1);
  if (row) return true;

  const [message] = await db
    .select({ found: sql<number>`1` })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.ownerId, userId),
        eq(chatMessages.role, 'user'),
        gte(chatMessages.createdAt, since),
      ),
    )
    .limit(1);
  return Boolean(message);
}

/** Has this goal been negotiated too recently to raise again? */
async function inCooldown(goalId: string): Promise<boolean> {
  const [last] = await db
    .select({ status: negotiations.status, createdAt: negotiations.createdAt })
    .from(negotiations)
    .where(eq(negotiations.goalId, goalId))
    .orderBy(desc(negotiations.createdAt))
    .limit(1);
  if (!last) return false;

  // An OPEN negotiation blocks a new one outright — that conversation is
  // still happening. A closed one blocks for the cooldown period, whatever
  // its outcome: agreeing a change means giving the change time to work, and
  // being told "no" means respecting it.
  if (last.status === 'proposed') return true;

  const cooldownEnds = new Date(last.createdAt.getTime() + COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  return cooldownEnds > new Date();
}

export interface SlippingGoal {
  goal: {
    id: string;
    ownerId: string;
    title: string;
    daysOfWeek: number[];
    timeOfDay: string;
    target: number | null;
    targetUnit: string | null;
    description: string | null;
  };
  user: { id: string; timezone: string; telegramChatId: string; displayName: string };
  evidence: GoalEvidence;
}

/**
 * Every goal that currently meets the whole rule. Called once a day by the
 * worker — not per reminder, which would give the same goal seven chances a
 * week to trip the same condition.
 */
export async function findSlippingGoals(): Promise<SlippingGoal[]> {
  const rows = await db
    .select({
      id: goals.id,
      ownerId: goals.ownerId,
      title: goals.title,
      daysOfWeek: goals.daysOfWeek,
      timeOfDay: goals.timeOfDay,
      target: goals.target,
      targetUnit: goals.targetUnit,
      description: goals.description,
      goalCreatedAt: goals.createdAt,
      goalUpdatedAt: goals.updatedAt,
      userTimezone: users.timezone,
      telegramChatId: users.telegramChatId,
      displayName: users.displayName,
    })
    .from(goals)
    .innerJoin(users, eq(users.id, goals.ownerId))
    .where(eq(goals.status, 'active'));

  const graceCutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000);
  const slipping: SlippingGoal[] = [];
  // One engagement lookup per user, not per goal.
  const engagement = new Map<string, boolean>();

  for (const row of rows) {
    // Nowhere to send a proposal, so there is no conversation to start.
    if (!row.telegramChatId) continue;

    // A goal created or edited in the last week hasn't had a fair run. This
    // is also what stops an agreed change from immediately re-triggering on
    // the very misses that caused it.
    if (row.goalUpdatedAt > graceCutoff) continue;

    if (!engagement.has(row.ownerId)) {
      engagement.set(row.ownerId, await hasRecentEngagement(row.ownerId));
    }
    if (!engagement.get(row.ownerId)) continue;

    const evidence = await gatherEvidence(
      { id: row.id, ownerId: row.ownerId, daysOfWeek: row.daysOfWeek, createdAt: row.goalCreatedAt },
      row.userTimezone,
    );

    if (evidence.due < MIN_DUE_OCCURRENCES) continue;
    if (evidence.completionRate >= COMPLETION_THRESHOLD) continue;
    if (await inCooldown(row.id)) continue;

    slipping.push({
      goal: {
        id: row.id,
        ownerId: row.ownerId,
        title: row.title,
        daysOfWeek: row.daysOfWeek,
        timeOfDay: row.timeOfDay,
        target: row.target,
        targetUnit: row.targetUnit,
        description: row.description,
      },
      user: {
        id: row.ownerId,
        timezone: row.userTimezone,
        telegramChatId: row.telegramChatId,
        displayName: row.displayName,
      },
      evidence,
    });
  }

  return slipping;
}

export const TRIGGER_RULE = {
  WINDOW_DAYS,
  MIN_DUE_OCCURRENCES,
  COMPLETION_THRESHOLD,
  PARTIAL_CREDIT,
  COOLDOWN_DAYS,
  GRACE_DAYS,
  ENGAGEMENT_WINDOW_DAYS,
} as const;
