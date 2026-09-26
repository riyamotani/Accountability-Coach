import { RETRY_OPTS, reminderQueue } from './reminders.js';

/**
 * BullMQ's role in the negotiation loop is TIME, and nothing else.
 *
 * The user's turns arrive as HTTP requests — someone is there, so the model
 * can run inside the request. The bot's turns have no request behind them:
 * "notice a slipping goal", "they've been quiet for a day", "they never
 * answered" all happen while none of our code is running. A queue is how you
 * wait for an ABSENCE.
 *
 * Every job below is only an alarm. When it fires it re-reads the row, and
 * may find the negotiation was agreed yesterday — in which case it does
 * nothing. Trust the database, not the job.
 */

/** Hourly: looks for slipping goals, but only acts in the user's evening. */
export const NEGOTIATION_SWEEP_JOB = 'negotiation-sweep';
export const NEGOTIATION_SWEEP_EVERY_MS = 60 * 60 * 1000;

/** One reminder that a proposal is waiting. Once only. */
export const NEGOTIATION_NUDGE_JOB = 'negotiation-nudge';
export const NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Give up on an unanswered proposal, which starts the cooldown. */
export const NEGOTIATION_ABANDON_JOB = 'negotiation-abandon';
export const ABANDON_AFTER_MS = 72 * 60 * 60 * 1000;

export interface NegotiationJobData {
  negotiationId: string;
}

/**
 * Schedules both silence timers for a freshly-sent proposal.
 *
 * Deterministic job ids, so scheduling twice is a no-op rather than two
 * nudges. Never throws: the proposal has already been sent and the row
 * saved, and a Redis hiccup must not undo that. The worst case is a
 * proposal that stays open — which the sweep handles anyway, since it
 * refuses to open a second negotiation for a goal.
 */
export async function scheduleSilenceTimers(negotiationId: string): Promise<void> {
  const data: NegotiationJobData = { negotiationId };

  try {
    await reminderQueue.add(NEGOTIATION_NUDGE_JOB, data, {
      ...RETRY_OPTS,
      jobId: `nudge-${negotiationId}`,
      delay: NUDGE_AFTER_MS,
      removeOnFail: true,
    });

    await reminderQueue.add(NEGOTIATION_ABANDON_JOB, data, {
      ...RETRY_OPTS,
      jobId: `abandon-${negotiationId}`,
      delay: ABANDON_AFTER_MS,
      removeOnFail: true,
    });
  } catch (err) {
    console.error(
      `[negotiation] could not schedule silence timers for ${negotiationId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
