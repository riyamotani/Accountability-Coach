import mongoose from 'mongoose';
import { Worker, type Job } from 'bullmq';
import { formatTimeOfDay, localDateInZone, localTimeInZone } from '@coach/shared';
import { env } from './lib/env.js';
import { createWorkerConnection, queueConnection } from './queue/connection.js';
import {
  QUEUE_NAME,
  RETRY_OPTS,
  reminderQueue,
  cronPatternFor,
  scheduleKeyFor,
  schedulerIdFor,
  followupJobIdFor,
  followupDelayMsFor,
  syncGoalSchedule,
  type ReminderJobData,
  type FollowupJobData,
} from './queue/reminders.js';
import { GoalModel } from './models/Goal.js';
import { UserModel } from './models/User.js';
import { CheckInModel } from './models/CheckIn.js';
import { generateReminderMessage, type CheckInHistoryEntry } from './lib/ai.js';
import {
  checkInButtons,
  sendTelegramMessage,
  TelegramPermanentError,
} from './lib/telegram.js';

/**
 * THE WORKER — a separate process from the API server.
 *
 * Same package (it needs the same models, env, and Mongo connection), different
 * entry point, different process. The API server answers HTTP requests; this
 * blocks on Redis, waiting for jobs to come due. Splitting them means a burst
 * of reminders can never slow down the dashboard, and either can restart
 * without taking the other down.
 *
 * Every handler below follows ONE rule: TRUST MONGO, NOT THE JOB. A job is just
 * an alarm clock saying "wake up and check". The first thing each handler does
 * is re-read the current truth, because the job may be stale — the goal could
 * have been deleted, archived, edited, or already completed since it was
 * scheduled.
 *
 * Handlers RETURN a string for outcomes that are normal (including "skipped"),
 * and THROW only for failures worth retrying. BullMQ stores the returned string
 * on the job, so every skip is visible and explained rather than silent.
 */

const RECONCILE_EVERY_MS = 5 * 60 * 1000;

// How many minutes late a reminder is allowed to be before we treat it as an
// overdue catch-up rather than a genuine, on-time fire, and stay silent.
const LATE_THRESHOLD_MINUTES = 10;

/**
 * Minutes between two "HH:mm" times, same calendar day. Positive = `now` is
 * after `scheduled`. Does NOT handle wrapping past midnight — if a reminder
 * is so overdue it's now a different day, this returns a large negative
 * number (looks "early", not "late") and the guard below misses it. A known,
 * accepted gap: catching that too needs the DATE alongside the time, and the
 * failure mode without it is "an extremely stale job might still send" —
 * rare, and never worse than what shipped before this fix existed at all.
 */
function minutesLate(scheduledHHMM: string, nowHHMM: string): number {
  const [sh, sm] = scheduledHHMM.split(':').map(Number);
  const [nh, nm] = nowHHMM.split(':').map(Number);
  return nh! * 60 + nm! - (sh! * 60 + sm!);
}

/** Last 7 calendar days for one goal, oldest first — context for the AI layer. */
async function recentHistoryFor(goalId: string, timezone: string): Promise<CheckInHistoryEntry[]> {
  const today = localDateInZone(timezone);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const from = localDateInZone(timezone, weekAgo);

  const checkIns = await CheckInModel.find({ goalId, date: { $gte: from, $lte: today } })
    .select('date status')
    .sort({ date: 1 })
    .lean();

  return checkIns.map((c) => ({ date: c.date, status: c.status }));
}

// ---------------------------------------------------------------------------
// reminder — fired by each goal's cron scheduler
// ---------------------------------------------------------------------------

async function handleReminder(job: Job<ReminderJobData>): Promise<string> {
  const { goalId, scheduleKey } = job.data;

  const goal = await GoalModel.findById(goalId);
  if (!goal || goal.status !== 'active') return 'skip: goal deleted or archived';

  const user = await UserModel.findById(goal.ownerId);
  if (!user) return 'skip: owner no longer exists';

  // The staleness check from the dual-write discussion. Recompute the
  // fingerprint from what Mongo says NOW and compare it exactly to what was
  // stamped into the job when it was scheduled. A mismatch means this alarm
  // was set for an old version of the goal: say nothing, and let the
  // reconciliation sweep re-point the schedule.
  const currentKey = scheduleKeyFor(cronPatternFor(goal.cadence), user.timezone);
  if (currentKey !== scheduleKey) {
    return `skip: stale schedule (job had ${scheduleKey}, goal is now ${currentKey})`;
  }

  // A DIFFERENT kind of staleness than the check above. That one asks "did
  // the goal change since this was scheduled?" — this asks "is right now
  // actually close to when this was supposed to fire?". A goal that never
  // changed can still produce a job that's hours late — e.g. BullMQ catching
  // up on a scheduler whose "next run" fell while the worker was offline.
  // Sending "⏰ jogging — 8:00 AM" at 2 PM is worse than not sending at all,
  // so treat significantly-late as its own reason to stay silent.
  const nowInZone = localTimeInZone(user.timezone);
  const lateness = minutesLate(goal.cadence.timeOfDay, nowInZone);
  if (lateness > LATE_THRESHOLD_MINUTES) {
    return `skip: too late (scheduled ${goal.cadence.timeOfDay}, now ${nowInZone} in ${user.timezone})`;
  }

  if (!user.telegramChatId) return 'skip: telegram not linked';

  // "Today" in the USER'S timezone — never the server's.
  const date = localDateInZone(user.timezone);

  if (await CheckInModel.exists({ goalId: goal._id, date })) {
    return 'skip: already checked in today';
  }

  // ORDER MATTERS HERE: schedule the follow-up BEFORE sending.
  //
  // The follow-up has a deterministic jobId, so adding it twice is a no-op —
  // BullMQ ignores a job whose id already exists. That makes this whole
  // handler safe to retry:
  //   - send fails -> BullMQ retries -> follow-up add is a no-op -> send again
  //
  // The reverse order would be worse: send succeeds, follow-up add fails,
  // job retries, and the user gets the SAME reminder twice.
  await reminderQueue.add('followup', { goalId, date } satisfies FollowupJobData, {
    ...RETRY_OPTS,
    delay: followupDelayMsFor(goal),
    jobId: followupJobIdFor(goalId, date),
  });

  // The header (title, time) is ALWAYS this exact deterministic line, straight
  // from Mongo — never AI-generated. Only the second line is ever allowed to
  // come from the model, and a failure there degrades to the same static
  // text this feature shipped with, never to a broken or missing reminder.
  const aiLine = await generateReminderMessage({
    goalTitle: goal.title,
    target: goal.target,
    targetUnit: goal.targetUnit,
    recentHistory: await recentHistoryFor(goalId, user.timezone),
  });

  await sendTelegramMessage(
    user.telegramChatId,
    `⏰ ${goal.title} — ${formatTimeOfDay(goal.cadence.timeOfDay)}\n\n${aiLine ?? "Tap when you've done it."}`,
    checkInButtons(goalId, date),
  );

  return aiLine ? 'sent (ai)' : 'sent (template)';
}

// ---------------------------------------------------------------------------
// followup — a one-off delayed job, "did you actually do it?"
// ---------------------------------------------------------------------------

async function handleFollowup(job: Job<FollowupJobData>): Promise<string> {
  const { goalId, date } = job.data;

  const goal = await GoalModel.findById(goalId);
  if (!goal || goal.status !== 'active') return 'skip: goal deleted or archived';

  // The whole point of a follow-up: only speak if the reminder went unanswered.
  // If they tapped Done (in Telegram or on the dashboard) in the meantime,
  // stay quiet — a follow-up after you've already done the thing is noise,
  // and noise is how people end up muting the bot.
  if (await CheckInModel.exists({ goalId: goal._id, date })) {
    return 'skip: checked in since the reminder';
  }

  const user = await UserModel.findById(goal.ownerId);
  if (!user?.telegramChatId) return 'skip: telegram not linked';

  await sendTelegramMessage(
    user.telegramChatId,
    `👋 Checking in — did you get to ${goal.title} today?`,
    checkInButtons(goalId, date),
  );

  return 'sent';
}

// ---------------------------------------------------------------------------
// reconcile — the safety net for everything above
// ---------------------------------------------------------------------------

/**
 * Makes Redis match Mongo, in both directions:
 *   1. every active goal gets its schedule re-upserted (fixes MISSING or STALE)
 *   2. every goal-scheduler with no matching active goal is removed (fixes ORPHANS)
 *
 * This is what repairs the crash window: if the API updated a goal in Mongo and
 * died before touching Redis, the damage lasts at most one sweep interval. And
 * it's only safe to do this blindly because syncGoalSchedule is idempotent.
 *
 * At larger scale you'd stop re-syncing everything and track a version number
 * per goal to re-sync only what changed. At this scale, "just do all of them"
 * is simpler and obviously correct.
 */
async function handleReconcile(): Promise<string> {
  const goals = await GoalModel.find({ status: 'active' });
  for (const goal of goals) await syncGoalSchedule(goal);

  const expected = new Set(goals.map((g) => schedulerIdFor(g._id.toString())));
  const schedulers = await reminderQueue.getJobSchedulers();

  let removed = 0;
  for (const scheduler of schedulers) {
    if (scheduler.key.startsWith('goal-') && !expected.has(scheduler.key)) {
      await reminderQueue.removeJobScheduler(scheduler.key);
      removed++;
    }
  }

  return `synced ${goals.length} goal(s), removed ${removed} orphaned scheduler(s)`;
}

// ---------------------------------------------------------------------------

async function main() {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required to run the worker');
  }

  await mongoose.connect(env.mongoUri);
  console.log('[worker] mongo connected');

  // Wait for Redis to actually be connected before issuing any commands.
  //
  // This matters because of the fail-fast producer connection: with the
  // offline queue disabled, a command sent in the few milliseconds before the
  // connection is established doesn't wait — it rejects. Without this line the
  // upsert just below races the connection handshake, and the worker can die on
  // startup for no reason other than being quick.
  await reminderQueue.waitUntilReady();
  console.log('[worker] redis connected');

  const workerConnection = createWorkerConnection();

  // The sweep's own schedule. Upserting it on every boot is safe for the same
  // reason as everything else here: the fixed id makes it idempotent, so
  // restarting the worker never creates a second sweep.
  await reminderQueue.upsertJobScheduler(
    'system-reconcile',
    { every: RECONCILE_EVERY_MS },
    { name: 'reconcile', opts: RETRY_OPTS },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      try {
        switch (job.name) {
          case 'reminder':
            return await handleReminder(job as Job<ReminderJobData>);
          case 'followup':
            return await handleFollowup(job as Job<FollowupJobData>);
          case 'reconcile':
            return await handleReconcile();
          default:
            return `skip: unknown job name "${job.name}"`;
        }
      } catch (err) {
        // A user who blocked the bot will fail identically on every retry.
        // Convert it to a normal (non-retried) outcome instead of burning
        // three attempts on something that cannot succeed.
        if (err instanceof TelegramPermanentError) return `skip: ${err.message}`;
        throw err;
      }
    },
    {
      connection: workerConnection,
      // Up to 5 jobs in parallel. This is the knob that stops 500 users all
      // due at 9:00 from becoming 500 simultaneous Telegram (and later, Claude)
      // calls.
      concurrency: 5,
    },
  );

  worker.on('completed', (job, result) => {
    console.log(`[worker] ${job.name} ${job.id} → ${result}`);
  });
  worker.on('failed', (job, err) => {
    console.error(
      `[worker] ${job?.name} ${job?.id} FAILED (attempt ${job?.attemptsMade}/${job?.opts.attempts}):`,
      err.message,
    );
  });
  worker.on('error', (err) => console.error('[worker] error:', err.message));

  console.log('[worker] listening for jobs');

  // Graceful shutdown: let in-flight jobs finish instead of abandoning them
  // mid-send. An abandoned job isn't lost — BullMQ marks it stalled and
  // retries it — but finishing cleanly avoids a duplicate message.
  const shutdown = async () => {
    console.log('[worker] shutting down…');
    await worker.close();
    await reminderQueue.close();
    // We constructed these clients, so closing them is our job — BullMQ doesn't
    // own a connection it was handed. `.catch` because close() above may
    // already have ended one, and quitting a closed client throws.
    await workerConnection.quit().catch(() => {});
    await queueConnection.quit().catch(() => {});
    await mongoose.disconnect();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[worker] failed to start:', err);
  process.exit(1);
});
