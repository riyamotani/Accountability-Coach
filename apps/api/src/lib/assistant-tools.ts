import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { and, asc, eq, gt, gte, lte } from 'drizzle-orm';
import { localDateInZone, type CheckInStatus } from '@coach/shared';
import { db } from '../db/client.js';
import {
  checkIns,
  goals,
  pauseWindows,
  pendingActions,
  scheduleBlocks,
  type PendingActionPayload,
} from '../db/schema.js';
import { isUuid } from './validators.js';

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

/** The user's draft, only if it hasn't expired yet. */
export async function findLivePendingAction(userId: string) {
  const [pending] = await db
    .select()
    .from(pendingActions)
    .where(and(eq(pendingActions.userId, userId), gt(pendingActions.expiresAt, new Date())));
  return pending;
}

async function setPendingAction(
  userId: string,
  kind: 'pauseWindow' | 'checkIn',
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

export function buildAssistantTools(userId: string, timezone: string): ToolSet {
  return {
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
      description: "Get the user's recurring daily schedule blocks (work, sleep, etc).",
      inputSchema: z.object({}),
      execute: async () => {
        return db
          .select({
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
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
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
        'for the user to confirm. Does NOT write it yet. Call getGoals first if you need a goalId.',
      inputSchema: z.object({
        goalId: z.string(),
        status: z.enum(['done', 'partial', 'skipped']),
        note: z.string().max(2000).optional(),
      }),
      execute: async ({ goalId, status, note }) => {
        // The model can hallucinate an id. A malformed one would make
        // Postgres throw, so it's answered like any unknown goal instead.
        const [goal] = isUuid(goalId)
          ? await db
              .select({ title: goals.title })
              .from(goals)
              .where(and(eq(goals.id, goalId), eq(goals.ownerId, userId)))
          : [];
        if (!goal) return { drafted: false, error: 'No goal with that id belongs to this user.' };

        const date = localDateInZone(timezone);
        await setPendingAction(userId, 'checkIn', { goalId, date, status, note });
        return {
          drafted: true,
          goalTitle: goal.title,
          date,
          status,
          note,
          note_to_model: 'Tell the user this is a DRAFT and ask them to confirm.',
        };
      },
    }),

    confirmPendingAction: tool({
      description:
        "Commit the user's currently pending drafted action (a proposePauseWindow or " +
        'proposeCheckIn from earlier in this conversation). Call this ONLY when the user\'s ' +
        'message clearly confirms — "yes", "confirm", "do it", etc.',
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

          if (pending.kind === 'pauseWindow') {
            const { from, to, reason } = pending.payload as {
              from: string;
              to: string;
              reason?: string;
            };
            await tx
              .insert(pauseWindows)
              .values({ ownerId: userId, from, to, ...(reason ? { reason } : {}) });
            return { committed: true, kind: 'pauseWindow', from, to };
          }

          // kind === 'checkIn'
          const { goalId, date, status, note } = pending.payload as {
            goalId: string;
            date: string;
            status: CheckInStatus;
            note?: string;
          };
          const changes = { status, ...(note !== undefined ? { note } : {}) };
          // Same upsert as PUT /checkins, so it can't collide with a check-in
          // logged some other way in the meantime.
          await tx
            .insert(checkIns)
            .values({ goalId, date, ownerId: userId, ...changes })
            .onConflictDoUpdate({
              target: [checkIns.goalId, checkIns.date],
              set: { ...changes, updatedAt: new Date() },
            });
          return { committed: true, kind: 'checkIn', date, status };
        });
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
  };
}
