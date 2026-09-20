import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { and, asc, count, eq, gt, gte, lte } from 'drizzle-orm';
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

async function setPendingAction(
  userId: string,
  kind: PendingActionKind,
  payload: PendingActionPayload,
): Promise<void> {
  const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MS);

  // INSERT ... ON CONFLICT (user_id) DO UPDATE: one draft per user, and a new
  // proposal REPLACES any older one rather than piling up beside it.
  await db
    .insert(pendingActions)
    .values({ userId, kind, payload, expiresAt })
    .onConflictDoUpdate({
      target: pendingActions.userId,
      set: { kind, payload, expiresAt, createdAt: new Date() },
    });
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

export function buildAssistantTools(userId: string, timezone: string): ToolSet {
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

        await setPendingAction(userId, 'pauseWindow', { from, to, reason });
        return {
          drafted: true,
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

        await setPendingAction(userId, 'checkIn', { goalId, date, status, note });
        return {
          drafted: true,
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
    proposeGoal: tool({
      description:
        'Draft a NEW goal for the user to confirm. Ask for anything missing before calling: ' +
        'a title, which days, and a time. daysOfWeek is 0=Sunday..6=Saturday ' +
        '("weekdays" = [1,2,3,4,5], "every day" = [0,1,2,3,4,5,6]). timeOfDay is 24-hour "HH:mm" ' +
        '(6pm = "18:00"). target/targetUnit are optional, e.g. 30 + "minutes".',
      inputSchema: goalFieldsSchema,
      execute: async (fields) => {
        await setPendingAction(userId, 'goalCreate', fields);
        return {
          drafted: true,
          ...fields,
          note_to_model:
            'Read the goal back in plain words (days and time as people say them) and ask ' +
            'them to confirm.',
        };
      },
    }),

    proposeGoalUpdate: tool({
      description:
        'Draft a CHANGE to an existing goal (rename, different days, different time, new ' +
        'target) for the user to confirm. Call getGoals first for the goalId. Only include ' +
        'the fields that should change.',
      inputSchema: goalUpdateSchema,
      execute: async ({ goalId, ...changes }) => {
        const goal = await findOwnGoal(goalId, userId);
        if (!goal) return { drafted: false, error: 'No goal with that id belongs to this user.' };
        if (Object.keys(changes).length === 0) {
          return { drafted: false, error: 'Nothing to change — include at least one field.' };
        }

        await setPendingAction(userId, 'goalUpdate', { goalId, ...changes });
        return {
          drafted: true,
          goalTitle: goal.title,
          changes,
          note_to_model: 'Say what will change (before → after) and ask them to confirm.',
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

        await setPendingAction(userId, 'goalArchive', { goalId, title: goal.title });
        return {
          drafted: true,
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

        await setPendingAction(userId, 'goalDelete', { goalId, title: goal.title });
        return {
          drafted: true,
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
        await setPendingAction(userId, 'scheduleBlockCreate', fields);
        return {
          drafted: true,
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

        await setPendingAction(userId, 'scheduleBlockUpdate', { blockId, ...changes });
        return { drafted: true, label: block.label, changes, note_to_model: 'Ask them to confirm.' };
      },
    }),

    proposeScheduleBlockDelete: tool({
      description:
        'Draft removing a schedule block. Call getSchedule first for the blockId.',
      inputSchema: z.object({ blockId: z.string().uuid() }),
      execute: async ({ blockId }) => {
        const block = await findOwnScheduleBlock(blockId, userId);
        if (!block) return { drafted: false, error: 'No schedule block with that id.' };

        await setPendingAction(userId, 'scheduleBlockDelete', { blockId, label: block.label });
        return { drafted: true, label: block.label, note_to_model: 'Ask them to confirm.' };
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
          const [pending] = await tx
            .delete(pendingActions)
            .where(
              and(eq(pendingActions.userId, userId), gt(pendingActions.expiresAt, new Date())),
            )
            .returning();
          if (!pending) {
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
              const fields = goalFieldsSchema.parse(pending.payload);
              const [goal] = await tx
                .insert(goals)
                .values({ ...fields, ownerId: userId })
                .returning();
              if (!goal) throw new Error('INSERT ... RETURNING returned no row');
              // Redis gets the reminder schedule, exactly as POST /goals does.
              // Not awaited and never throws: the goal is already saved, and
              // the worker's sweep repairs a missed sync within minutes.
              void syncGoalSchedule(goal);
              return { committed: true, kind: pending.kind, title: goal.title };
            }

            case 'goalUpdate': {
              const { goalId, ...changes } = goalUpdateSchema.parse(pending.payload);
              const [goal] = await tx
                .update(goals)
                .set({ ...changes, updatedAt: new Date() })
                // The ownership check again, at write time: the draft was
                // created in an earlier request, and this is the statement
                // that actually touches the row.
                .where(and(eq(goals.id, goalId), eq(goals.ownerId, userId)))
                .returning();
              if (!goal) return { committed: false, error: 'That goal no longer exists.' };
              // A new time or new days means the old alarm is wrong.
              void syncGoalSchedule(goal);
              return { committed: true, kind: pending.kind, title: goal.title };
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
