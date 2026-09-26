import { Worker, type Job } from 'bullmq';
import { and, asc, eq, gte, isNull, lt, lte } from 'drizzle-orm';
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
  DORMANCY_JOB,
  DORMANCY_EVERY_MS,
  type ReminderJobData,
  type FollowupJobData,
} from './queue/reminders.js';
import { db, pool } from './db/client.js';
import {
  chatMessages,
  checkIns,
  goals,
  linkCodes,
  memories,
  negotiations,
  pauseWindows,
  pendingActions,
  users,
} from './db/schema.js';
import {
  EMBED_MEMORY_JOB,
  SYNC_MEMORY_JOB,
  enqueueMemoryEmbedding,
  type EmbedMemoryJobData,
  type SyncMemoryJobData,
} from './queue/memories.js';
import { getSyncTarget } from './lib/memory/index.js';
import { currentEmbeddingModel, embedText } from './lib/embeddings.js';
import { findNewlyDormantUsers, goodbyeMessage, markDormant } from './lib/engagement.js';
import { findSlippingGoals } from './lib/negotiation/trigger.js';
import { composeProposal } from './lib/negotiation/propose.js';
import {
  closeNegotiation,
  createNegotiation,
  recordBotMessage,
} from './lib/negotiation/state.js';
import {
  NEGOTIATION_ABANDON_JOB,
  NEGOTIATION_NUDGE_JOB,
  NEGOTIATION_SWEEP_JOB,
  NEGOTIATION_SWEEP_EVERY_MS,
  scheduleSilenceTimers,
  type NegotiationJobData,
} from './queue/negotiations.js';
import { getMemoryStore } from './lib/memory/index.js';
import { describeError } from './db/errors.js';
import { isUuid } from './lib/validators.js';
import { generateReminderMessage, type CheckInHistoryEntry } from './lib/ai.js';
import {
  checkInButtons,
  sendTelegramMessage,
  TelegramPermanentError,
} from './lib/telegram.js';

/**
 * THE WORKER — a separate process from the API server.
 *
 * Same package (it needs the same schema, env, and database), different
 * entry point, different process. The API server answers HTTP requests; this
 * blocks on Redis, waiting for jobs to come due. Splitting them means a burst
 * of reminders can never slow down the dashboard, and either can restart
 * without taking the other down.
 *
 * Every handler below follows ONE rule: TRUST THE DATABASE, NOT THE JOB. A job is just
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

/** Per sweep, so a large backlog is worked through over several sweeps. */
const UNEMBEDDED_SWEEP_LIMIT = 50;

/** How long raw chat turns are kept. Facts worth keeping become memories. */
const CHAT_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Wordings for the messages a user sees EVERY day. The exact same sentence
 * every morning is what makes a bot feel automated; one of a few is enough to
 * avoid that. Rare messages stay fixed.
 */
function pick<T>(options: readonly T[]): T {
  return options[Math.floor(Math.random() * options.length)] ?? options[0]!;
}

/** Used when the AI line is unavailable — the reminder still has to read well. */
const REMINDER_FALLBACKS = [
  "You've got this. Tap below when it's done.",
  'Time to make it happen — tap below when done.',
  'Small step, big streak. Tap below when done.',
] as const;

const FOLLOWUP_OPENERS = [
  (title: string) => `👋 Hey, did ${title} happen today?`,
  (title: string) => `👋 Quick check — how'd ${title} go?`,
  (title: string) => `👋 Just checking in on ${title}. Get to it?`,
] as const;

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

  // SELECT date, status FROM check_ins
  // WHERE goal_id = $1 AND date >= $2 AND date <= $3 ORDER BY date ASC
  return db
    .select({ date: checkIns.date, status: checkIns.status })
    .from(checkIns)
    .where(and(eq(checkIns.goalId, goalId), gte(checkIns.date, from), lte(checkIns.date, today)))
    .orderBy(asc(checkIns.date));
}

/** Does this goal already have a check-in for this day? */
async function hasCheckIn(goalId: string, date: string): Promise<boolean> {
  // Fetch at most one id: we only care WHETHER a row exists, not what's in it.
  const rows = await db
    .select({ id: checkIns.id })
    .from(checkIns)
    .where(and(eq(checkIns.goalId, goalId), eq(checkIns.date, date)))
    .limit(1);
  return rows.length > 0;
}

async function findGoal(goalId: string) {
  // Jobs already sitting in Redis can outlive a data-format change (these
  // held Mongo ObjectIds before the move to Postgres). A malformed id would
  // make Postgres throw and the job retry pointlessly; "not found" is the
  // honest answer, and the handlers turn it into a logged skip.
  if (!isUuid(goalId)) return undefined;
  const [goal] = await db.select().from(goals).where(eq(goals.id, goalId));
  return goal;
}

async function findUser(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user;
}

// ---------------------------------------------------------------------------
// reminder — fired by each goal's cron scheduler
// ---------------------------------------------------------------------------

async function handleReminder(job: Job<ReminderJobData>): Promise<string> {
  const { goalId, scheduleKey } = job.data;

  const goal = await findGoal(goalId);
  if (!goal || goal.status !== 'active') return 'skip: goal deleted or archived';

  const user = await findUser(goal.ownerId);
  if (!user) return 'skip: owner no longer exists';

  // The bot has gone quiet for this person. Their schedules keep running —
  // cheap, and it means everything resumes the instant they say something —
  // but nothing is sent, and no AI call is made.
  if (user.dormantSince) return 'skip: user dormant (no reply in 7+ days)';

  // The staleness check from the dual-write discussion. Recompute the
  // fingerprint from what the database says NOW and compare it exactly to what was
  // stamped into the job when it was scheduled. A mismatch means this alarm
  // was set for an old version of the goal: say nothing, and let the
  // reconciliation sweep re-point the schedule.
  const currentKey = scheduleKeyFor(cronPatternFor(goal), user.timezone);
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
  const lateness = minutesLate(goal.timeOfDay, nowInZone);
  if (lateness > LATE_THRESHOLD_MINUTES) {
    return `skip: too late (scheduled ${goal.timeOfDay}, now ${nowInZone} in ${user.timezone})`;
  }

  if (!user.telegramChatId) return 'skip: telegram not linked';

  // "Today" in the USER'S timezone — never the server's.
  const date = localDateInZone(user.timezone);

  // Vacation / do-not-disturb. Note what does NOT happen here: no CheckIn row
  // gets written for a paused day. Marking it "skipped" would break streaks
  // AND make the (future) negotiation loop's pattern detection try to
  // renegotiate a goal that's fine — the user was just away. A paused day is
  // simply excluded from whatever later counts "days due", by never having
  // existed in the first place.
  //
  // SELECT to_date FROM pause_windows
  // WHERE owner_id = $1 AND from_date <= $2 AND to_date >= $2 LIMIT 1
  // i.e. "is today inside any of this user's pause windows?"
  const [pause] = await db
    .select({ to: pauseWindows.to })
    .from(pauseWindows)
    .where(
      and(
        eq(pauseWindows.ownerId, user.id),
        lte(pauseWindows.from, date),
        gte(pauseWindows.to, date),
      ),
    )
    .limit(1);
  if (pause) return `skip: paused until ${pause.to}`;

  if (await hasCheckIn(goal.id, date)) {
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
  // from the database — never AI-generated. Only the second line is ever allowed to
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
    `⏰ ${goal.title} — ${formatTimeOfDay(goal.timeOfDay)}\n\n${aiLine ?? pick(REMINDER_FALLBACKS)}`,
    checkInButtons(goalId, date),
  );

  return aiLine ? 'sent (ai)' : 'sent (template)';
}

// ---------------------------------------------------------------------------
// followup — a one-off delayed job, "did you actually do it?"
// ---------------------------------------------------------------------------

async function handleFollowup(job: Job<FollowupJobData>): Promise<string> {
  const { goalId, date } = job.data;

  const goal = await findGoal(goalId);
  if (!goal || goal.status !== 'active') return 'skip: goal deleted or archived';

  // The whole point of a follow-up: only speak if the reminder went unanswered.
  // If they tapped Done (in Telegram or on the dashboard) in the meantime,
  // stay quiet — a follow-up after you've already done the thing is noise,
  // and noise is how people end up muting the bot.
  if (await hasCheckIn(goal.id, date)) {
    return 'skip: checked in since the reminder';
  }

  const user = await findUser(goal.ownerId);
  if (!user?.telegramChatId) return 'skip: telegram not linked';
  if (user.dormantSince) return 'skip: user dormant';

  await sendTelegramMessage(
    user.telegramChatId,
    pick(FOLLOWUP_OPENERS)(goal.title),
    checkInButtons(goalId, date),
  );

  return 'sent';
}

// ---------------------------------------------------------------------------
// embed-memory — turn a stored memory into a searchable vector
// ---------------------------------------------------------------------------

/**
 * The second half of "write the words first, embed them after". The memory
 * row already exists; this fills in the vector that makes it findable.
 *
 * Throws on failure so BullMQ retries: an embedding API that is briefly down
 * should delay search, never lose a memory.
 */
async function handleEmbedMemory(job: Job<EmbedMemoryJobData>): Promise<string> {
  const { memoryId } = job.data;

  const [memory] = await db
    .select({
      id: memories.id,
      content: memories.content,
      embedding: memories.embedding,
      embeddingModel: memories.embeddingModel,
    })
    .from(memories)
    .where(eq(memories.id, memoryId));
  if (!memory) return 'skip: memory deleted';

  // Already done. Re-running a job must not pay for the same embedding twice.
  if (memory.embedding && memory.embeddingModel === currentEmbeddingModel()) {
    return 'skip: already embedded';
  }

  const embedding = await embedText(memory.content);

  await db
    .update(memories)
    .set({ embedding, embeddingModel: currentEmbeddingModel(), updatedAt: new Date() })
    .where(eq(memories.id, memoryId));

  return `embedded (${embedding.length} dims)`;
}

// ---------------------------------------------------------------------------
// sync-memory — copy a saved memory to the hosted provider
// ---------------------------------------------------------------------------

/**
 * Pushes one memory to whichever provider is active (Mem0 today).
 *
 * Our own row is already written; this keeps the provider's searchable copy
 * in step with it. Throws on failure so BullMQ retries — a provider being
 * briefly unreachable should delay the copy, never skip it.
 */
async function handleSyncMemory(job: Job<SyncMemoryJobData>): Promise<string> {
  const target = getSyncTarget();
  if (!target) return 'skip: no hosted provider configured';

  const { memoryId } = job.data;
  const [memory] = await db
    .select({ ownerId: memories.ownerId, content: memories.content, source: memories.source })
    .from(memories)
    .where(eq(memories.id, memoryId));
  if (!memory) return 'skip: memory deleted';

  await target.store.add({
    userId: memory.ownerId,
    content: memory.content,
    source: memory.source,
  });

  return `synced to ${target.name}`;
}

// ---------------------------------------------------------------------------
// negotiation — the bot opening a conversation about a goal that isn't working
// ---------------------------------------------------------------------------

/**
 * Evening only, in the user's own timezone.
 *
 * "This week hasn't gone well, shall we change it?" is a reflective message,
 * and it lands very differently at 11am on a workday than after dinner. It
 * also can't then collide with a morning reminder for the same goal.
 */
const PROPOSAL_EARLIEST_HOUR = 18;
const PROPOSAL_LATEST_HOUR = 21;

function isProposalHour(timezone: string): boolean {
  const [hour] = localTimeInZone(timezone).split(':').map(Number);
  return hour !== undefined && hour >= PROPOSAL_EARLIEST_HOUR && hour < PROPOSAL_LATEST_HOUR;
}

/**
 * Finds goals that are slipping and opens ONE negotiation per user.
 *
 * Runs hourly so it can catch each user's evening wherever they are, and
 * does nothing outside that window.
 */
async function handleNegotiationSweep(): Promise<string> {
  const slipping = await findSlippingGoals();
  if (slipping.length === 0) return 'no slipping goals';

  const alreadyMessaged = new Set<string>();
  let opened = 0;

  for (const candidate of slipping) {
    if (!isProposalHour(candidate.user.timezone)) continue;

    // At most one proposal per user per sweep, even with three qualifying
    // goals. Three renegotiation requests at once reads as an intervention,
    // not as help — and the others will still be there tomorrow.
    if (alreadyMessaged.has(candidate.user.id)) continue;

    // Why the goal might be slipping, in the user's own words. The trigger
    // knows THAT it slipped; this is the only source for WHY.
    let memories: string[] = [];
    try {
      const hits = await getMemoryStore().search({
        userId: candidate.user.id,
        query: `struggling with ${candidate.goal.title}`,
        limit: 3,
      });
      memories = hits.map((hit) => hit.content);
    } catch (err) {
      console.error('[negotiation] memory lookup failed:', describeError(err));
    }

    const proposal = await composeProposal(candidate, memories);
    if (!proposal) continue;

    // The row FIRST, then the message. If sending fails we have an open
    // negotiation with nothing said, which the nudge repairs; the reverse —
    // a message sent with no row — would be a proposal the bot cannot
    // remember making.
    const created = await createNegotiation({
      goalId: candidate.goal.id,
      ownerId: candidate.user.id,
      proposal,
      evidence: candidate.evidence as unknown as Record<string, unknown>,
    });
    // Another sweep beat us to this goal (the partial unique index).
    if (!created) continue;

    try {
      await sendTelegramMessage(candidate.user.telegramChatId, proposal.message);
    } catch (err) {
      if (err instanceof TelegramPermanentError) {
        await closeNegotiation(created.id, 'abandoned');
        continue;
      }
      throw err; // transient: let BullMQ retry the whole sweep
    }

    // Into the conversation history, so a reply tomorrow — after a reminder
    // and a check-in have come and gone — still has the proposal above it.
    await recordBotMessage(candidate.user.id, proposal.message);
    await scheduleSilenceTimers(created.id);

    alreadyMessaged.add(candidate.user.id);
    opened++;
  }

  return `opened ${opened} negotiation(s) of ${slipping.length} slipping goal(s)`;
}

/** One reminder that a proposal is still waiting. */
async function handleNegotiationNudge(job: Job<NegotiationJobData>): Promise<string> {
  const [negotiation] = await db
    .select()
    .from(negotiations)
    .where(eq(negotiations.id, job.data.negotiationId));

  // All the ways this alarm can be stale, checked against the database
  // rather than assumed from the fact that the job fired.
  if (!negotiation) return 'skip: negotiation gone';
  if (negotiation.status !== 'proposed') return `skip: already ${negotiation.status}`;
  if (negotiation.nudgedAt) return 'skip: already nudged';
  // They replied since — the bot spoke last at a later time than this job
  // was scheduled for.
  if (negotiation.lastMessageAt.getTime() > job.timestamp) return 'skip: conversation moved on';

  const user = await findUser(negotiation.ownerId);
  if (!user?.telegramChatId || user.dormantSince) return 'skip: not contactable';

  const [goal] = await db
    .select({ title: goals.title })
    .from(goals)
    .where(eq(goals.id, negotiation.goalId));
  if (!goal) return 'skip: goal deleted';

  const message =
    `Still thinking about ${goal.title}? No rush — just say yes, no, or tell me what ` +
    `would work better and I'll sort it.`;

  await sendTelegramMessage(user.telegramChatId, message);
  await recordBotMessage(user.id, message);
  await db
    .update(negotiations)
    .set({ nudgedAt: new Date(), updatedAt: new Date() })
    .where(eq(negotiations.id, negotiation.id));

  return 'nudged';
}

/**
 * Closes a proposal nobody answered. Deliberately SILENT: a third message
 * saying "I'll stop asking" is one more message to someone who has already
 * shown they don't want to discuss it.
 */
async function handleNegotiationAbandon(job: Job<NegotiationJobData>): Promise<string> {
  const [negotiation] = await db
    .select()
    .from(negotiations)
    .where(eq(negotiations.id, job.data.negotiationId));

  if (!negotiation) return 'skip: negotiation gone';
  if (negotiation.status !== 'proposed') return `skip: already ${negotiation.status}`;
  if (negotiation.lastMessageAt.getTime() > job.timestamp) return 'skip: conversation moved on';

  await closeNegotiation(negotiation.id, 'abandoned');
  // The cooldown runs from here, so the goal won't be raised again for two
  // weeks — silence is an answer, and it gets respected.
  return 'abandoned after 72h of silence';
}

// ---------------------------------------------------------------------------
// dormancy — stop talking to someone who has stopped listening
// ---------------------------------------------------------------------------

/**
 * Sends ONE goodbye to users who have been silent for a week, then stops
 * reminding them until they say something.
 *
 * A proactive bot is the only part of this app that speaks first, so it is
 * the only part that needs a rule for when to stop. Reminders arriving for
 * weeks after someone stopped listening is how an app gets muted or blocked,
 * and every unread AI-written reminder costs money.
 *
 * Runs hourly rather than daily, because it only acts during the user's own
 * waking hours — a bot that goes quiet at 4am has managed to be annoying on
 * the way out.
 */
async function handleDormancySweep(): Promise<string> {
  const candidates = await findNewlyDormantUsers();
  let sent = 0;

  for (const user of candidates) {
    try {
      await sendTelegramMessage(user.telegramChatId, goodbyeMessage(user.displayName));
      // Marked only AFTER the message is delivered: if the send fails, the
      // next sweep should try again rather than silently going quiet.
      await markDormant(user.id);
      sent++;
    } catch (err) {
      if (err instanceof TelegramPermanentError) {
        // They blocked the bot, which is an even clearer "stop" — no message
        // is possible, so just go quiet.
        await markDormant(user.id);
        sent++;
        continue;
      }
      console.error(`[dormancy] could not message ${user.id}:`, describeError(err));
    }
  }

  return `${sent} user(s) went dormant`;
}

// ---------------------------------------------------------------------------
// reconcile — the safety net for everything above
// ---------------------------------------------------------------------------

/**
 * Makes Redis match Postgres, in both directions:
 *   1. every active goal gets its schedule re-upserted (fixes MISSING or STALE)
 *   2. every goal-scheduler with no matching active goal is removed (fixes ORPHANS)
 *
 * This is what repairs the crash window: if the API updated a goal in Postgres
 * and died before touching Redis, the damage lasts at most one sweep interval.
 * And it's only safe to do this blindly because syncGoalSchedule is idempotent.
 *
 * It also deletes expired link codes and assistant drafts. Postgres has no TTL
 * indexes (Mongo deleted these on its own), so this sweep is their garbage
 * collector. Correctness never depends on it: every read of those rows checks
 * expires_at itself. This only stops dead rows from piling up.
 *
 * At larger scale you'd stop re-syncing everything and track a version number
 * per goal to re-sync only what changed. At this scale, "just do all of them"
 * is simpler and obviously correct.
 */
async function handleReconcile(): Promise<string> {
  const activeGoals = await db.select().from(goals).where(eq(goals.status, 'active'));
  for (const goal of activeGoals) await syncGoalSchedule(goal);

  const expected = new Set(activeGoals.map((g) => schedulerIdFor(g.id)));
  const schedulers = await reminderQueue.getJobSchedulers();

  let removed = 0;
  for (const scheduler of schedulers) {
    if (scheduler.key.startsWith('goal-') && !expected.has(scheduler.key)) {
      await reminderQueue.removeJobScheduler(scheduler.key);
      removed++;
    }
  }

  // DELETE FROM link_codes WHERE expires_at < now() RETURNING id
  // (RETURNING only so we can count what was removed.)
  const now = new Date();
  const expiredCodes = await db
    .delete(linkCodes)
    .where(lt(linkCodes.expiresAt, now))
    .returning({ id: linkCodes.id });
  const expiredDrafts = await db
    .delete(pendingActions)
    .where(lt(pendingActions.expiresAt, now))
    .returning({ id: pendingActions.id });

  // Old chat turns. Unlike memories — which are kept forever on purpose —
  // the raw conversation is working state: it exists to resolve "it" and
  // "that one" within a conversation, and a month-old exchange can no longer
  // do that for anyone. Anything worth keeping from it was saved as a memory.
  const oldTurns = await db
    .delete(chatMessages)
    .where(lt(chatMessages.createdAt, new Date(now.getTime() - CHAT_HISTORY_RETENTION_MS)))
    .returning({ id: chatMessages.id });

  // Memories whose embedding job never ran or never succeeded (Redis was
  // down when they were saved, the worker died mid-job, the AI was out of
  // credit). Re-queued rather than embedded inline, so one sweep can't turn
  // into a long batch of API calls — and the deterministic job id makes
  // re-queuing something already in flight a no-op.
  const unembedded = await db
    .select({ id: memories.id })
    .from(memories)
    .where(isNull(memories.embedding))
    .limit(UNEMBEDDED_SWEEP_LIMIT);
  for (const memory of unembedded) await enqueueMemoryEmbedding(memory.id);

  return (
    `synced ${activeGoals.length} goal(s), removed ${removed} orphaned scheduler(s), ` +
    `swept ${expiredCodes.length} expired code(s), ${expiredDrafts.length} expired draft(s) ` +
    `and ${oldTurns.length} old chat turn(s), ` +
    `re-queued ${unembedded.length} unembedded memor(ies)`
  );
}

// ---------------------------------------------------------------------------

async function main() {
  if (!env.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required to run the worker');
  }

  // The pool connects lazily, on the first query. Running one now means a
  // wrong DATABASE_URL or a stopped container fails loudly at startup instead
  // of on the first reminder, possibly hours later.
  await pool.query('SELECT 1');
  console.log('[worker] postgres connected');

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

  // Hourly, because it acts on each user's LOCAL clock: a single daily run
  // would land at 4am for someone.
  await reminderQueue.upsertJobScheduler(
    'system-dormancy',
    { every: DORMANCY_EVERY_MS },
    { name: DORMANCY_JOB, opts: RETRY_OPTS },
  );

  // Also hourly, for the same reason: it only acts during each user's
  // evening, which no single daily run could cover across timezones.
  await reminderQueue.upsertJobScheduler(
    'system-negotiation',
    { every: NEGOTIATION_SWEEP_EVERY_MS },
    { name: NEGOTIATION_SWEEP_JOB, opts: RETRY_OPTS },
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
          case DORMANCY_JOB:
            return await handleDormancySweep();
          case NEGOTIATION_SWEEP_JOB:
            return await handleNegotiationSweep();
          case NEGOTIATION_NUDGE_JOB:
            return await handleNegotiationNudge(job as Job<NegotiationJobData>);
          case NEGOTIATION_ABANDON_JOB:
            return await handleNegotiationAbandon(job as Job<NegotiationJobData>);
          case EMBED_MEMORY_JOB:
            return await handleEmbedMemory(job as Job<EmbedMemoryJobData>);
          case SYNC_MEMORY_JOB:
            return await handleSyncMemory(job as Job<SyncMemoryJobData>);
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
    // Closes every pooled connection, after any in-flight queries finish.
    await pool.end();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[worker] failed to start:', err);
  process.exit(1);
});
