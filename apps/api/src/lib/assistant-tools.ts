import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { and, asc, count, eq, gt, gte, lt, lte } from 'drizzle-orm';
import { daysBetween, formatLocalDate, localDateInZone, type CheckInStatus } from '@coach/shared';
import { db } from '../db/client.js';
import {
  checkIns,
  goals,
  pauseWindows,
  pendingActions,
  scheduleBlocks,
  type PendingActionKind,
  type PendingActionPayload,
} from '../db/schema.js';
import { isUuid } from './validators.js';
import { getMemoryStore } from './memory/index.js';
import { removeGoalSchedule, syncGoalSchedule } from '../queue/reminders.js';
import {
  advanceRound,
  closeNegotiation,
  findOpenNegotiation,
  MAX_ROUNDS,
} from './negotiation/state.js';

/**
 * The tool set for the free-text assistant. Two trust levels, and the split
 * between them is the entire safety design:
 *
 * READ tools (getGoals, getRecentCheckIns, getSchedule) — answer questions.
 * A wrong answer here is a bad sentence, corrected by asking again.
 *
 * PROPOSE tools (proposePauseWindow, proposeCheckIn) — the ONLY way a write
 * intent can go anywhere. They NEVER touch pause_windows or check_ins. They
 * only write a draft to pending_actions. Only confirmPendingAction, below,
 * can turn a draft into a real write — and it requires the user's own next
 * message to call it. A hallucinated proposal costs nothing; nothing is
 * written until a human says so.
 *
 * `userId` is a closure argument, never a tool input the model fills in.
 * If it were a model-supplied field, a confused or manipulated model could
 * name a different user's id. Building the tool set fresh per request, one
 * call scoped to one authenticated user, makes that class of bug structurally
 * impossible rather than something to remember to check.
 */

const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;

/**
 * How far back a check-in can be logged BY CHAT. "I forgot to tap yesterday"
 * and "I did go on Tuesday" both fit in a week, which is also the window the
 * assistant and the reminder prompt already call "recent".
 *
 * The limit exists because the negotiation loop will later judge goals from
 * this history ("missed 5 of 7"); letting one sentence rewrite a month would
 * quietly distort what it is judging. The dashboard can still edit any date —
 * that path is explicit, one day at a time.
 */
const MAX_BACKDATE_DAYS = 7;

const LOCAL_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const TIME_OF_DAY = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm, 24-hour');
const DAYS_OF_WEEK = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .max(7)
  .describe('0 = Sunday … 6 = Saturday');

/**
 * Drafts are stored as jsonb — the database accepts any shape — and are read
 * back minutes later, possibly after a deploy that changed these tools. So
 * every payload is validated AGAIN on the way out, right before it becomes a
 * real row. Trusting what went in would mean a malformed draft reaching an
 * INSERT as a confusing database error instead of a clear message.
 */
const goalFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  daysOfWeek: DAYS_OF_WEEK,
  timeOfDay: TIME_OF_DAY,
  target: z.number().min(0).optional(),
  targetUnit: z.string().trim().max(32).optional(),
});

/**
 * A cap on goals per draft. One message might reasonably set up a morning and
 * an evening slot, or a few related habits; much beyond that is more likely a
 * model misreading the request than a person asking for it.
 */
const MAX_GOALS_PER_DRAFT = 5;

const goalUpdateSchema = goalFieldsSchema.partial().extend({ goalId: z.string().uuid() });
const goalIdSchema = z.object({ goalId: z.string().uuid(), title: z.string().optional() });

const scheduleBlockFieldsSchema = z.object({
  label: z.string().trim().min(1).max(60),
  startTime: TIME_OF_DAY,
  endTime: TIME_OF_DAY,
  daysOfWeek: DAYS_OF_WEEK,
});

const scheduleBlockUpdateSchema = scheduleBlockFieldsSchema
  .partial()
  .extend({ blockId: z.string().uuid() });

const pauseWindowSchema = z.object({
  from: LOCAL_DATE,
  to: LOCAL_DATE,
  reason: z.string().max(500).optional(),
});

const checkInSchema = z.object({
  goalId: z.string().uuid(),
  date: LOCAL_DATE,
  status: z.enum(['done', 'partial', 'skipped']),
  note: z.string().max(2000).optional(),
});

/** The user's draft, only if it hasn't expired yet. */
export async function findLivePendingAction(userId: string) {
  const [pending] = await db
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.userId, userId), gt(pendingActions.expiresAt, new Date())));
  return pending;
}

/**
 * "Is this the user's own goal?" — asked before drafting anything about it,
 * so a hallucinated id fails while the user is still in the conversation
 * rather than at confirm time. The same check runs again at write time,
 * because a goal can be deleted in between.
 */
async function findOwnGoal(goalId: string, userId: string) {
  if (!isUuid(goalId)) return undefined;
  const [goal] = await db
    .select({ id: goals.id, title: goals.title })
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.ownerId, userId)));
  return goal;
}

async function findOwnScheduleBlock(blockId: string, userId: string) {
  if (!isUuid(blockId)) return undefined;
  const [block] = await db
    .select({ id: scheduleBlocks.id, label: scheduleBlocks.label })
    .from(scheduleBlocks)
    .where(and(eq(scheduleBlocks.id, blockId), eq(scheduleBlocks.ownerId, userId)));
  return block;
}

/**
 * Saves a draft, and says so LOUDLY if it replaced another one.
 *
 * One draft per user is deliberate (a stale draft must never be confirmable
 * by accident), so a second proposal replaces the first. That used to happen
 * silently — seen live: asked for "9 PM for 1 hour AND 6:30 AM for 2 hours",
 * the model drafted both, the second replaced the first, the user confirmed,
 * only the 6:30 goal was created, and the bot announced that "both" were set.
 * The model couldn't have known. The code did, so the code has to say it.
 *
 * The returned object is spread into every propose tool's result, so the
 * model sees `replacedDraft` in the same breath as `drafted: true`.
 */
async function setPendingAction(
  userId: string,
  kind: PendingActionKind,
  payload: PendingActionPayload,
): Promise<{ replacedDraft?: { kind: string; payload: unknown }; note_about_drafts?: string }> {
  const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MS);

  const previous = await findLivePendingAction(userId);

  // INSERT ... ON CONFLICT (user_id) DO UPDATE: one draft per user, and a new
  // proposal REPLACES any older one rather than piling up beside it.
  await db
    .insert(pendingActions)
    // createdAt is set from the API's clock, NOT the database's `now()`: it is
    // compared against the API's own turnStartedAt, and two machines' clocks
    // can disagree by enough to make a same-turn draft look older than it is.
    .values({ userId, kind, payload, expiresAt, createdAt: new Date() })
    .onConflictDoUpdate({
      target: pendingActions.userId,
      set: { kind, payload, expiresAt, createdAt: new Date() },
    });

  if (!previous) return {};
  return {
    replacedDraft: { kind: previous.kind, payload: previous.payload },
    note_about_drafts:
      'This REPLACED an earlier unconfirmed draft, which is now gone. Only ONE draft can ' +
      'exist at a time. To create several goals, put them ALL in a single proposeGoal ' +
      'call — one draft, one confirmation. If the earlier draft held something different ' +
      'the user still wants, tell them it was replaced. Never say something was created ' +
      'unless confirmPendingAction returned it.',
  };
}

/**
 * Stops the model calling the same tool, with the same arguments, twice in
 * one message.
 *
 * Seen live: `getRecentCheckIns` four times in a row, which used every step
 * allowed and left no room to actually answer — the user got "sorry, I didn't
 * catch that". The model repeats a call when the result isn't what it hoped
 * for, as if the answer might change.
 *
 * The second call gets the first result back, plus an instruction to answer.
 * Cheaper and more reliable than asking it not to in the prompt, and unlike a
 * flat refusal it keeps the data in front of the model.
 */
function withRepeatGuard(tools: ToolSet): ToolSet {
  const seen = new Map<string, unknown>();

  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = tool.execute;
      if (!execute) return [name, tool];

      return [
        name,
        {
          ...tool,
          execute: async (input: unknown, options: Parameters<typeof execute>[1]) => {
            const key = `${name}:${JSON.stringify(input)}`;
            if (seen.has(key)) {
              return {
                repeated: true,
                previousResult: seen.get(key),
                note_to_model:
                  'You already called this with the same arguments and this was the result. ' +
                  'It will not change. Answer the user now with what you have.',
              };
            }
            const result = await execute(input, options);
            seen.set(key, result);
            return result;
          },
        },
      ];
    }),
  );
}

/**
 * The user's side of a negotiation the BOT started: accept, counter, or
 * decline. Built separately so they can be withheld entirely when no
 * proposal is waiting.
 */
function negotiationTools(userId: string, turnStartedAt: Date): ToolSet {
  return {
    acceptNegotiation: tool({
      description:
        'The user AGREED to the change the bot proposed for a goal. Call this when they ' +
        'say yes, sounds good, ok do it, etc. It applies exactly what was proposed — you ' +
        'cannot change the terms here.',
      inputSchema: z.object({}),
      execute: async () => {
        const open = await findOpenNegotiation(userId);
        if (!open) return { applied: false, error: 'There is no open proposal to accept.' };

        // The terms being accepted must be ones the user has SEEN. If the
        // proposal was changed during this very turn (a counter-offer the
        // model just recorded), the user hasn't agreed to the new version.
        if (open.lastMessageAt >= turnStartedAt) {
          return {
            applied: false,
            error:
              'These terms were set in this same turn and the user has not seen them yet. ' +
              'Read them back and ask the user to confirm. Do NOT say it is done.',
          };
        }

        // Read from the STORED proposal, never from anything the model
        // passes in. Even a model that misreads "no, not that" as agreement
        // can only apply the change the user was actually shown.
        const proposal = open.proposal as {
          daysOfWeek?: number[];
          timeOfDay?: string;
          target?: number;
        };

        const changes = {
          ...(proposal.daysOfWeek ? { daysOfWeek: proposal.daysOfWeek } : {}),
          ...(proposal.timeOfDay ? { timeOfDay: proposal.timeOfDay } : {}),
          ...(proposal.target !== undefined ? { target: proposal.target } : {}),
        };

        // People write the number into the title ("Read 20 pages"). Seen
        // live: a negotiated target of 10 left the title saying 20, so every
        // reminder contradicted the goal it was reminding about. Swap the old
        // number only when it appears exactly once as a whole word — anything
        // more ambiguous is left alone rather than guessed at.
        const [current] = await db
          .select({ title: goals.title, target: goals.target })
          .from(goals)
          .where(and(eq(goals.id, open.goalId), eq(goals.ownerId, userId)));
        let title: string | undefined;
        if (current?.target != null && proposal.target !== undefined) {
          const oldNumber = new RegExp(`\\b${current.target}\\b`, 'g');
          if ((current.title.match(oldNumber) ?? []).length === 1) {
            title = current.title.replace(oldNumber, String(proposal.target));
          }
        }

        const [goal] = await db
          .update(goals)
          .set({ ...changes, ...(title ? { title } : {}), updatedAt: new Date() })
          .where(and(eq(goals.id, open.goalId), eq(goals.ownerId, userId)))
          .returning();
        if (!goal) return { applied: false, error: 'That goal no longer exists.' };

        await closeNegotiation(open.id, 'agreed');
        // New days or a new time means the old alarm is wrong. Touching the
        // goal also restarts the 7-day grace period, so the change gets a
        // fair run before anything can be renegotiated again.
        void syncGoalSchedule(goal);

        return {
          applied: true,
          goalTitle: goal.title,
          daysOfWeek: goal.daysOfWeek,
          timeOfDay: goal.timeOfDay,
          target: goal.target,
          note_to_model: 'Confirm warmly in one line, in plain words, and wish them luck.',
        };
      },
    }),

    counterNegotiation: tool({
      description:
        "The user wants something DIFFERENT from what the bot proposed (e.g. 'no, keep 5 " +
        "days but move it later'). Pass their counter-offer; it becomes the new proposal " +
        'for them to confirm.',
      inputSchema: z.object({
        daysOfWeek: DAYS_OF_WEEK.optional(),
        timeOfDay: TIME_OF_DAY.optional(),
        target: z.number().min(0).optional(),
        summary: z.string().max(300).describe('What they asked for, in one sentence'),
      }),
      execute: async ({ summary, ...changes }) => {
        const open = await findOpenNegotiation(userId);
        if (!open) return { recorded: false, error: 'There is no open proposal to counter.' };
        if (Object.keys(changes).length === 0) {
          return { recorded: false, error: 'No concrete change given — ask them what to change.' };
        }

        const round = await advanceRound(open.id, { ...changes, rationale: summary });

        // Three rounds in, this is a disagreement rather than a negotiation.
        // The bot stops rather than grinding on; the cooldown then leaves the
        // goal alone for two weeks.
        if (round > MAX_ROUNDS) {
          await closeNegotiation(open.id, 'declined');
          return {
            recorded: true,
            closed: true,
            note_to_model:
              "Say you'll leave the goal as it is for now and they can change it any time. " +
              'Do not propose anything else.',
          };
        }

        return {
          recorded: true,
          round,
          ...changes,
          note_to_model:
            'Read their version back as the new proposal and ask them to confirm it. ' +
            'Call acceptNegotiation when they do.',
        };
      },
    }),

    declineNegotiation: tool({
      description:
        "The user does NOT want to change the goal ('no, leave it', 'I want to keep it as " +
        "is'). Closes the conversation and leaves the goal untouched.",
      inputSchema: z.object({}),
      execute: async () => {
        const open = await findOpenNegotiation(userId);
        if (!open) return { closed: false, error: 'There is no open proposal to decline.' };

        await closeNegotiation(open.id, 'declined');
        return {
          closed: true,
          note_to_model:
            'Accept it gracefully in one line — no persuading, no second attempt. ' +
            'They know where to find you.',
        };
      },
    }),
  };
}

export interface ToolContext {
  /**
   * Whether the bot is waiting on an answer to a goal proposal right now.
   *
   * The negotiation tools are only handed over when one is open. Two reasons,
   * and the second matters more: every tool definition costs tokens in every
   * request, and a model given an `acceptNegotiation` tool WILL eventually
   * call it with nothing to accept — spending one of four allowed steps to
   * be told "there is no open proposal". The cheapest way to stop a model
   * doing something is not to offer it.
   */
  hasOpenNegotiation: boolean;

  /**
   * When THIS request began. A draft or proposal created at or after this
   * moment was made during the current turn, so the user has not seen it yet
   * and cannot have agreed to it.
   *
   * This is what actually enforces "nothing is written until a human says
   * yes". It used to be enforced only by a tool description ("call this ONLY
   * when the user confirms"), which is a prompt — and a capable model, asked
   * to "add a goal", drafted it and confirmed it in the same breath, telling
   * the user it was done before they had seen it. Being helpful is exactly
   * the failure mode here, so the rule has to live in code.
   */
  turnStartedAt: Date;
}

export function buildAssistantTools(
  userId: string,
  timezone: string,
  context: ToolContext = { hasOpenNegotiation: false, turnStartedAt: new Date() },
): ToolSet {
  const { turnStartedAt } = context;
  return withRepeatGuard({
    getGoals: tool({
      description: "List the user's active goals, with their schedule and target.",
      inputSchema: z.object({}),
      execute: async () => {
        const rows = await db
          .select()
          .from(goals)
          .where(and(eq(goals.ownerId, userId), eq(goals.status, 'active')));
        return rows.map((g) => ({
          id: g.id,
          title: g.title,
          daysOfWeek: g.daysOfWeek,
          timeOfDay: g.timeOfDay,
          target: g.target,
          targetUnit: g.targetUnit,
          // The user's reason for the goal. Without it the assistant knows
          // WHAT they're doing but never WHY — and "why" is what makes
          // encouragement or a suggested change actually land.
          ...(g.description ? { why: g.description } : {}),
        }));
      },
    }),

    getRecentCheckIns: tool({
      description: 'Get check-ins from the last 7 days, across all goals, with each goal title.',
      inputSchema: z.object({}),
      execute: async () => {
        const today = localDateInZone(timezone);
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const from = localDateInZone(timezone, weekAgo);

        // A JOIN: each check-in row is matched with the goal row it points
        // at, so the model gets "Gym — skipped" instead of a bare goal id it
        // would have to cross-reference against getGoals itself.
        //
        // SELECT goals.title, check_ins.date, check_ins.status, check_ins.note
        // FROM check_ins JOIN goals ON goals.id = check_ins.goal_id
        // WHERE check_ins.owner_id = $1 AND check_ins.date BETWEEN $2 AND $3
        // ORDER BY check_ins.date ASC
        return db
          .select({
            goalId: checkIns.goalId,
            goalTitle: goals.title,
            date: checkIns.date,
            status: checkIns.status,
            note: checkIns.note,
          })
          .from(checkIns)
          .innerJoin(goals, eq(goals.id, checkIns.goalId))
          .where(
            and(
              eq(checkIns.ownerId, userId),
              gte(checkIns.date, from),
              lte(checkIns.date, today),
            ),
          )
          .orderBy(asc(checkIns.date));
      },
    }),

    getSchedule: tool({
      description:
        "Get the user's recurring daily schedule blocks (work, sleep, etc), with the " +
        'blockId needed to change or remove one.',
      inputSchema: z.object({}),
      execute: async () => {
        return db
          .select({
            blockId: scheduleBlocks.id,
            label: scheduleBlocks.label,
            startTime: scheduleBlocks.startTime,
            endTime: scheduleBlocks.endTime,
            daysOfWeek: scheduleBlocks.daysOfWeek,
          })
          .from(scheduleBlocks)
          .where(eq(scheduleBlocks.ownerId, userId));
      },
    }),

    proposePauseWindow: tool({
      description:
        'Draft a pause window (vacation / do-not-disturb) for the user to confirm. ' +
        'Does NOT pause anything yet — only confirmPendingAction can do that.',
      inputSchema: z.object({
        from: LOCAL_DATE,
        to: LOCAL_DATE,
        reason: z.string().max(500).optional(),
      }),
      execute: async ({ from, to, reason }) => {
        // Caught here rather than by the database's CHECK at confirm time, so
        // the model can correct itself while the user is still in the chat.
        if (from > to) return { drafted: false, error: '`from` must be on or before `to`.' };

        const draft = await setPendingAction(userId, 'pauseWindow', { from, to, reason });
        return {
          drafted: true, ...draft,
          from,
          to,
          reason,
          note: 'Tell the user this is a DRAFT and ask them to confirm before it takes effect.',
        };
      },
    }),

    proposeCheckIn: tool({
      description:
        'Draft a check-in update for a goal (done/partial/skipped, with an optional note) ' +
        'for the user to confirm. Does NOT write it yet. Call getGoals first if you need a goalId. ' +
        `Pass \`date\` (YYYY-MM-DD) for a past day such as "yesterday" or "on Tuesday"; ` +
        `it defaults to today and cannot be in the future or more than ${MAX_BACKDATE_DAYS} days ago.`,
      inputSchema: z.object({
        goalId: z.string(),
        status: z.enum(['done', 'partial', 'skipped']),
        date: LOCAL_DATE.optional(),
        note: z.string().max(2000).optional(),
      }),
      execute: async ({ goalId, status, date: requestedDate, note }) => {
        // The model can hallucinate an id. A malformed one would make
        // Postgres throw, so it's answered like any unknown goal instead.
        const [goal] = isUuid(goalId)
          ? await db
              .select({ title: goals.title })
              .from(goals)
              .where(and(eq(goals.id, goalId), eq(goals.ownerId, userId)))
          : [];
        if (!goal) return { drafted: false, error: 'No goal with that id belongs to this user.' };

        // "Today" in the USER's timezone, so a user in Kolkata at 1am logs
        // the day they're actually living in, not the server's.
        const today = localDateInZone(timezone);
        const date = requestedDate ?? today;

        // A model can produce a date that parses but isn't real ("2026-02-31")
        // or one it invented for "last Tuesday" — checked here so the error
        // comes back while the user is still in the conversation.
        const dateLabel = formatLocalDate(date);
        if (!dateLabel) return { drafted: false, error: `${date} is not a real date.` };

        const age = daysBetween(date, today);
        if (age < 0) {
          return { drafted: false, error: "That date is in the future — you can't log it yet." };
        }
        if (age > MAX_BACKDATE_DAYS) {
          return {
            drafted: false,
            error:
              `Only the last ${MAX_BACKDATE_DAYS} days can be logged by chat. ` +
              'Tell the user to edit older days on the dashboard.',
          };
        }

        const draft = await setPendingAction(userId, 'checkIn', { goalId, date, status, note });
        return {
          drafted: true, ...draft,
          goalTitle: goal.title,
          date,
          // Handed to the model already formatted, so its reply can name the
          // day ("Thu 18 Sep") instead of echoing a database-looking string.
          dateLabel: age === 0 ? 'today' : age === 1 ? `yesterday (${dateLabel})` : dateLabel,
          status,
          note,
          note_to_model:
            'Tell the user this is a DRAFT, name the day it is for, and ask them to confirm.',
        };
      },
    }),

    /**
     * Goal editing over chat. The bot — not the dashboard — is the main way
     * this app is used, so everything the dashboard can do to a goal has to
     * be reachable from a message. Each one drafts; nothing is written until
     * the user confirms in their own next message.
     */
    /**
     * Takes a LIST of goals, drafted together and confirmed with one "yes".
     *
     * There can only ever be one draft per user — that rule stays, because a
     * stale draft must never be confirmable by accident. But a draft holding a
     * single goal turned "9 PM for an hour AND 6:30 AM for two hours" into
     * either a silently lost goal or three rounds of "confirm this one, now
     * that one". One draft, many goals, one confirmation, one transaction.
     */
    proposeGoal: tool({
      description:
        'Draft one or MORE new goals for the user to confirm in a single step. Put every goal ' +
        'they asked for in ONE call (e.g. "9 PM for 1 hour and 6:30 AM for 2 hours" = two ' +
        'entries). Ask for anything missing first: a title, which days, a time. daysOfWeek is ' +
        '0=Sunday..6=Saturday ("weekdays" = [1,2,3,4,5], "every day" = [0,1,2,3,4,5,6]). ' +
        'timeOfDay is 24-hour "HH:mm" (6pm = "18:00"). target/targetUnit are optional, e.g. ' +
        '30 + "minutes". When the same activity has two times, give each a distinguishing ' +
        'title (e.g. "Prep for job switch (evening)").',
      inputSchema: z.object({ goals: z.array(goalFieldsSchema).min(1).max(MAX_GOALS_PER_DRAFT) }),
      execute: async ({ goals: drafted }) => {
        // Duplicate guard. Seen live: right after two goals were created, the
        // user said "yeah reminders work" and the model drafted the SAME two
        // goals again — one more "yes" and there would have been four. An
        // active goal with an identical title (case and spacing ignored) is
        // almost certainly the same goal, so the draft is refused and the
        // model is told what already exists.
        const normalise = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase();
        const existing = await db
          .select({ title: goals.title })
          .from(goals)
          .where(and(eq(goals.ownerId, userId), eq(goals.status, 'active')));
        const existingTitles = new Set(existing.map((goal) => normalise(goal.title)));
        const duplicates = drafted.filter((goal) => existingTitles.has(normalise(goal.title)));

        if (duplicates.length > 0) {
          return {
            drafted: false,
            error:
              `These goals already exist and are active: ${duplicates.map((g) => `"${g.title}"`).join(', ')}. ` +
              'Nothing was drafted. If the user wants to change one, use proposeGoalUpdate; if ' +
              'they really want a second, separate goal, it needs a different title.',
          };
        }

        const draft = await setPendingAction(userId, 'goalCreate', { goals: drafted });
        return {
          drafted: true, ...draft,
          goals: drafted,
          note_to_model:
            'Read ALL of them back in plain words (days and time as people say them) and ask ' +
            'for ONE confirmation. A single yes creates every goal listed.',
        };
      },
    }),

    /**
     * A LIST of changes, one draft, one confirmation — for the same reason
     * proposeGoal takes a list. Seen live: "add this description to both job
     * goals" drafted the first update, then drafted the second (replacing
     * the first — one draft per user), and ran out of steps without a reply.
     */
    proposeGoalUpdate: tool({
      description:
        'Draft CHANGES to one or MORE existing goals (rename, days, time, target, or a ' +
        'description of WHY the goal matters) for the user to confirm in one step. Put every ' +
        'goal being changed in ONE call. Call getGoals first for the goalIds. Only include the ' +
        'fields that should change for each.',
      inputSchema: z.object({ updates: z.array(goalUpdateSchema).min(1).max(MAX_GOALS_PER_DRAFT) }),
      execute: async ({ updates }) => {
        const summaries: Array<{ goalTitle: string; changes: Record<string, unknown> }> = [];
        for (const { goalId, ...changes } of updates) {
          const goal = await findOwnGoal(goalId, userId);
          if (!goal) {
            return { drafted: false, error: `No goal with id ${goalId} belongs to this user.` };
          }
          if (Object.keys(changes).length === 0) {
            return { drafted: false, error: `Nothing to change for "${goal.title}".` };
          }
          summaries.push({ goalTitle: goal.title, changes });
        }

        const draft = await setPendingAction(userId, 'goalUpdate', { updates });
        return {
          drafted: true, ...draft,
          updates: summaries,
          note_to_model:
            'Say what will change for each goal (before → after) and ask for ONE confirmation.',
        };
      },
    }),

    proposeGoalArchive: tool({
      description:
        'Draft ARCHIVING a goal: reminders stop, but its history is kept and it can come ' +
        'back later. Use this when the user wants to stop, pause indefinitely, or drop a ' +
        'goal. Prefer this over deleting.',
      inputSchema: z.object({ goalId: z.string().uuid() }),
      execute: async ({ goalId }) => {
        const goal = await findOwnGoal(goalId, userId);
        if (!goal) return { drafted: false, error: 'No goal with that id belongs to this user.' };

        const draft = await setPendingAction(userId, 'goalArchive', { goalId, title: goal.title });
        return {
          drafted: true, ...draft,
          goalTitle: goal.title,
          note_to_model:
            'Tell them reminders will stop but their history stays, and ask them to confirm.',
        };
      },
    }),

    proposeGoalDelete: tool({
      description:
        'Draft PERMANENTLY DELETING a goal and every check-in ever logged for it. ' +
        'Irreversible. Only use when the user explicitly wants it erased — if they just ' +
        'want to stop doing it, use proposeGoalArchive instead.',
      inputSchema: z.object({ goalId: z.string().uuid() }),
      execute: async ({ goalId }) => {
        const goal = await findOwnGoal(goalId, userId);
        if (!goal) return { drafted: false, error: 'No goal with that id belongs to this user.' };

        // The exact number of check-ins that will disappear with it. "This
        // also deletes 47 check-ins" is a real warning; "history will be
        // lost" is a shrug.
        const [{ count: historyCount } = { count: 0 }] = await db
          .select({ count: count() })
          .from(checkIns)
          .where(eq(checkIns.goalId, goalId));

        const draft = await setPendingAction(userId, 'goalDelete', { goalId, title: goal.title });
        return {
          drafted: true, ...draft,
          goalTitle: goal.title,
          checkInsToDelete: historyCount,
          note_to_model:
            'Warn them this is permanent, say how many check-ins go with it, mention ' +
            'archiving as the reversible alternative, and ask them to confirm.',
        };
      },
    }),

    proposeScheduleBlock: tool({
      description:
        'Draft a recurring part of their normal day (work hours, sleep, commute, class) ' +
        'so reminders can avoid it. Times are 24-hour "HH:mm"; endTime before startTime ' +
        'means it crosses midnight (sleep 23:00-07:00).',
      inputSchema: scheduleBlockFieldsSchema,
      execute: async (fields) => {
        const draft = await setPendingAction(userId, 'scheduleBlockCreate', fields);
        return {
          drafted: true, ...draft,
          ...fields,
          note_to_model: 'Read it back in plain words and ask them to confirm.',
        };
      },
    }),

    proposeScheduleBlockUpdate: tool({
      description:
        'Draft a change to an existing schedule block. Call getSchedule first for the ' +
        'blockId. Only include fields that should change.',
      inputSchema: scheduleBlockUpdateSchema,
      execute: async ({ blockId, ...changes }) => {
        const block = await findOwnScheduleBlock(blockId, userId);
        if (!block) return { drafted: false, error: 'No schedule block with that id.' };
        if (Object.keys(changes).length === 0) {
          return { drafted: false, error: 'Nothing to change — include at least one field.' };
        }

        const draft = await setPendingAction(userId, 'scheduleBlockUpdate', { blockId, ...changes });
        return { drafted: true, ...draft, label: block.label, changes, note_to_model: 'Ask them to confirm.' };
      },
    }),

    proposeScheduleBlockDelete: tool({
      description:
        'Draft removing a schedule block. Call getSchedule first for the blockId.',
      inputSchema: z.object({ blockId: z.string().uuid() }),
      execute: async ({ blockId }) => {
        const block = await findOwnScheduleBlock(blockId, userId);
        if (!block) return { drafted: false, error: 'No schedule block with that id.' };

        const draft = await setPendingAction(userId, 'scheduleBlockDelete', { blockId, label: block.label });
        return { drafted: true, ...draft, label: block.label, note_to_model: 'Ask them to confirm.' };
      },
    }),

    confirmPendingAction: tool({
      description:
        "Commit the user's currently pending drafted action (whatever propose* tool ran " +
        'earlier in this conversation). Call this ONLY when their message clearly ' +
        'confirms — "yes", "confirm", "do it", etc.',
      inputSchema: z.object({}),
      execute: async () => {
        // One transaction: the draft is consumed and the real row written
        // together, or not at all.
        return db.transaction(async (tx) => {
          // DELETE ... WHERE user_id = $1 AND expires_at > now() RETURNING *
          //
          // Deleting and reading in ONE statement "claims" the draft. If the
          // same confirmation arrives twice at once (a duplicate Telegram
          // update), only one DELETE can remove the row; the other gets
          // nothing back and commits nothing. A read-then-delete would let
          // both read it first and both write.
          //
          // `createdAt < turnStartedAt` is the human-in-the-loop guarantee:
          // only a draft made in an EARLIER request — one the user has
          // actually seen — can be confirmed. A draft from this same turn is
          // left exactly where it is, waiting for a real answer.
          const [pending] = await tx
            .delete(pendingActions)
            .where(
              and(
                eq(pendingActions.userId, userId),
                gt(pendingActions.expiresAt, new Date()),
                lt(pendingActions.createdAt, turnStartedAt),
              ),
            )
            .returning();
          if (!pending) {
            // Tell the model WHY, so it does the right thing next instead of
            // retrying: a fresh draft needs showing, a missing one doesn't.
            const fresh = await findLivePendingAction(userId);
            if (fresh) {
              return {
                committed: false,
                error:
                  'You created this draft in this same turn — the user has not seen it, so it ' +
                  'cannot be confirmed yet. Show them what you drafted and ask them to confirm. ' +
                  'Do NOT say it is done.',
              };
            }
            return {
              committed: false,
              error: 'Nothing is pending (or the draft expired). There is nothing to confirm.',
            };
          }

          // Every branch re-validates the payload before writing: the draft
          // was written by an earlier request and has been sitting in jsonb,
          // where nothing checks its shape.
          switch (pending.kind) {
            case 'pauseWindow': {
              const { from, to, reason } = pauseWindowSchema.parse(pending.payload);
              await tx
                .insert(pauseWindows)
                .values({ ownerId: userId, from, to, ...(reason ? { reason } : {}) });
              return { committed: true, kind: pending.kind, from, to };
            }

            case 'checkIn': {
              const { goalId, date, status, note } = checkInSchema.parse(pending.payload);
              const changes = { status, ...(note !== undefined ? { note } : {}) };
              // Same upsert as PUT /checkins, so it can't collide with a
              // check-in logged some other way in the meantime.
              await tx
                .insert(checkIns)
                .values({ goalId, date, ownerId: userId, ...changes })
                .onConflictDoUpdate({
                  target: [checkIns.goalId, checkIns.date],
                  set: { ...changes, updatedAt: new Date() },
                });
              return { committed: true, kind: pending.kind, date, status };
            }

            case 'goalCreate': {
              // Current drafts hold { goals: [...] }. A draft saved by the
              // previous version held a single goal's fields directly; drafts
              // live 15 minutes, so a deploy can land in the middle of one —
              // both shapes are accepted rather than failing that user.
              const payload = pending.payload as { goals?: unknown };
              const fieldsList = Array.isArray(payload.goals)
                ? z.array(goalFieldsSchema).min(1).max(MAX_GOALS_PER_DRAFT).parse(payload.goals)
                : [goalFieldsSchema.parse(pending.payload)];

              // ONE insert with many rows, inside the transaction: all the
              // goals are created or none are. Never "two of three".
              const created = await tx
                .insert(goals)
                .values(fieldsList.map((fields) => ({ ...fields, ownerId: userId })))
                .returning();

              // Redis gets each reminder schedule, exactly as POST /goals
              // does. Not awaited and never throws: the goals are already
              // saved, and the worker's sweep repairs a missed sync.
              for (const goal of created) void syncGoalSchedule(goal);

              // Exactly what was created, so the reply is built from facts
              // rather than from what the model remembers drafting.
              return {
                committed: true,
                kind: pending.kind,
                created: created.map((goal) => ({
                  title: goal.title,
                  daysOfWeek: goal.daysOfWeek,
                  timeOfDay: goal.timeOfDay,
                  target: goal.target,
                  targetUnit: goal.targetUnit,
                })),
                note_to_model: 'Describe exactly the goals listed in `created`, nothing more.',
              };
            }

            case 'goalUpdate': {
              // { updates: [...] } now; a single update's fields directly in
              // drafts saved before that change (they live 15 minutes).
              const payload = pending.payload as { updates?: unknown };
              const updateList = Array.isArray(payload.updates)
                ? z.array(goalUpdateSchema).min(1).max(MAX_GOALS_PER_DRAFT).parse(payload.updates)
                : [goalUpdateSchema.parse(pending.payload)];

              const updated = [];
              for (const { goalId, ...changes } of updateList) {
                const [goal] = await tx
                  .update(goals)
                  .set({ ...changes, updatedAt: new Date() })
                  // The ownership check again, at write time: the draft was
                  // created in an earlier request, and this is the statement
                  // that actually touches the row.
                  .where(and(eq(goals.id, goalId), eq(goals.ownerId, userId)))
                  .returning();
                // One goal gone means the user agreed to a set that no longer
                // exists. Throwing rolls back the WHOLE transaction — none of
                // the changes apply, rather than some of them.
                if (!goal) throw new Error(`goal ${goalId} no longer exists`);
                updated.push(goal);
              }

              // A new time or new days means the old alarm is wrong.
              for (const goal of updated) void syncGoalSchedule(goal);
              return {
                committed: true,
                kind: pending.kind,
                updated: updated.map((goal) => ({
                  title: goal.title,
                  daysOfWeek: goal.daysOfWeek,
                  timeOfDay: goal.timeOfDay,
                  target: goal.target,
                  description: goal.description,
                })),
                note_to_model: 'Describe exactly the changes listed in `updated`, nothing more.',
              };
            }

            case 'goalArchive': {
              const { goalId } = goalIdSchema.parse(pending.payload);
              const [goal] = await tx
                .update(goals)
                .set({ status: 'archived', updatedAt: new Date() })
                .where(and(eq(goals.id, goalId), eq(goals.ownerId, userId)))
                .returning();
              if (!goal) return { committed: false, error: 'That goal no longer exists.' };
              // syncGoalSchedule removes the scheduler for a non-active goal.
              void syncGoalSchedule(goal);
              return { committed: true, kind: pending.kind, title: goal.title };
            }

            case 'goalDelete': {
              const { goalId } = goalIdSchema.parse(pending.payload);
              const [deleted] = await tx
                .delete(goals)
                .where(and(eq(goals.id, goalId), eq(goals.ownerId, userId)))
                .returning({ id: goals.id, title: goals.title });
              if (!deleted) return { committed: false, error: 'That goal no longer exists.' };
              // Check-ins went with it: ON DELETE CASCADE, same statement.
              void removeGoalSchedule(deleted.id);
              return { committed: true, kind: pending.kind, title: deleted.title };
            }

            case 'scheduleBlockCreate': {
              const fields = scheduleBlockFieldsSchema.parse(pending.payload);
              const [block] = await tx
                .insert(scheduleBlocks)
                .values({ ...fields, ownerId: userId })
                .returning();
              return { committed: true, kind: pending.kind, label: block?.label };
            }

            case 'scheduleBlockUpdate': {
              const { blockId, ...changes } = scheduleBlockUpdateSchema.parse(pending.payload);
              const [block] = await tx
                .update(scheduleBlocks)
                .set({ ...changes, updatedAt: new Date() })
                .where(and(eq(scheduleBlocks.id, blockId), eq(scheduleBlocks.ownerId, userId)))
                .returning();
              if (!block) return { committed: false, error: 'That schedule block is gone.' };
              return { committed: true, kind: pending.kind, label: block.label };
            }

            case 'scheduleBlockDelete': {
              const { blockId } = scheduleBlockUpdateSchema
                .pick({ blockId: true })
                .parse(pending.payload);
              const [deleted] = await tx
                .delete(scheduleBlocks)
                .where(and(eq(scheduleBlocks.id, blockId), eq(scheduleBlocks.ownerId, userId)))
                .returning({ label: scheduleBlocks.label });
              if (!deleted) return { committed: false, error: 'That schedule block is gone.' };
              return { committed: true, kind: pending.kind, label: deleted.label };
            }

            default: {
              // TypeScript proves this is unreachable while every kind is
              // handled: add a kind to PENDING_ACTION_KINDS without a case
              // here and this line stops compiling.
              const unhandled: never = pending.kind;
              throw new Error(`Unhandled pending action kind: ${String(unhandled)}`);
            }
          }
        });
      },
    }),

    /**
     * A WRITE that deliberately skips the draft-and-confirm gate.
     *
     * The gate exists for writes that change what the app DOES — pausing
     * reminders, marking a goal done. Remembering a sentence the user just
     * said changes nothing except what the bot can recall later, and asking
     * "shall I remember that?" after every message would be unbearable. The
     * blast radius of a wrong save is one irrelevant line in a future search
     * result, not a wrong streak or a silenced reminder.
     */
    rememberNote: tool({
      description:
        'Save something personal the user shared that explains their situation, mood, ' +
        'obstacles, or preferences — e.g. "work has been crazy this month", ' +
        '"knee injury, no running for 3 weeks", "mornings are impossible for me". ' +
        'Save their OWN words, lightly cleaned up, not your summary. ' +
        'Do NOT save: questions, small talk, requests to change goals, or anything ' +
        'already captured as a goal or check-in.',
      inputSchema: z.object({
        content: z.string().min(3).max(1000),
      }),
      execute: async ({ content }) => {
        const { id } = await getMemoryStore().add({ userId, content, source: 'chat' });
        return {
          saved: true,
          id,
          note_to_model:
            'Acknowledge briefly and naturally if it fits the conversation. Never say ' +
            '"saved to memory" like a database.',
        };
      },
    }),

    /**
     * The read half. This is what makes "why do I keep missing gym?"
     * answerable from something the user said weeks ago in different words.
     */
    recallNotes: tool({
      description:
        'Search everything the user has told you before, by MEANING rather than keywords. ' +
        'Use it whenever context about their life would help: they ask why a pattern keeps ' +
        'happening, mention something that may have come up before, or you need to know what ' +
        'was going on around a goal. Returns their past notes with the date each was said.',
      inputSchema: z.object({
        query: z
          .string()
          .min(2)
          .max(300)
          .describe('What to look for, in natural language. E.g. "reasons for missing the gym".'),
      }),
      execute: async ({ query }) => {
        const hits = await getMemoryStore().search({ userId, query, limit: 5 });

        // The model writes this search phrase, and it can differ a lot from
        // what the user typed — which changes the scores completely. Without
        // seeing it, "found nothing" is unexplainable. Logged for the search
        // phrase and scores only, never the notes themselves.
        console.log(
          `[memory] recall "${query}" → ${hits.length} hit(s)` +
            (hits[0] ? ` (top ${hits[0].score.toFixed(3)})` : ''),
        );
        if (hits.length === 0) {
          return {
            found: 0,
            note_to_model:
              "Nothing relevant was saved. Say you don't know rather than guessing a reason.",
          };
        }
        return {
          found: hits.length,
          notes: hits.map((hit) => ({
            said: hit.content,
            // The model needs WHEN to say "back in August" or "three weeks
            // ago" — a memory with no date can't support that.
            when: formatLocalDate(localDateInZone(timezone, hit.createdAt)),
            daysAgo: daysBetween(
              localDateInZone(timezone, hit.createdAt),
              localDateInZone(timezone),
            ),
          })),
          note_to_model:
            'These are the user\'s own past words. Quote or paraphrase them when explaining a ' +
            'pattern; never invent a reason that is not here.',
        };
      },
    }),

    /**
     * The user's side of a negotiation the BOT started.
     *
     * Spread in ONLY when a proposal is actually waiting: a tool that exists
     * is a tool a model will eventually call, and "acceptNegotiation" with
     * nothing to accept wastes one of four allowed steps to learn that.
     *
     * These three deliberately skip the draft-then-confirm gate, and the
     * reason is precise: the proposal WAS the draft. The bot said exactly
     * what it would change and asked; "yes" is the confirmation. Asking again
     * would be asking twice.
     *
     * The safety property is kept a different way — `acceptNegotiation` takes
     * NO arguments. What gets applied is read from the stored proposal, so
     * the model cannot quietly apply something other than what the user was
     * shown, even if it misreads the conversation.
     */
    ...(context.hasOpenNegotiation ? negotiationTools(userId, turnStartedAt) : {}),

    cancelPendingAction: tool({
      description: "Discard the user's currently pending drafted action without committing it.",
      inputSchema: z.object({}),
      execute: async () => {
        const deleted = await db
          .delete(pendingActions)
          .where(eq(pendingActions.userId, userId))
          .returning({ id: pendingActions.id });
        return { cancelled: deleted.length > 0 };
      },
    }),
  });
}
