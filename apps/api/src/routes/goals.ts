import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { goals } from '../db/schema.js';
import { toGoal } from '../lib/serialize.js';
import { isUuid } from '../lib/validators.js';
import { requireAuth } from '../middleware/auth.js';
import { removeGoalSchedule, syncGoalSchedule } from '../queue/reminders.js';

export const goalsRouter = Router();

// Applied to every route in this router — there is no unauthenticated path
// into goal data, by construction rather than by remembering.
goalsRouter.use(requireAuth);

const cadenceSchema = z.object({
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm'),
});

const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  cadence: cadenceSchema,
  target: z.number().min(0).optional(),
  targetUnit: z.string().trim().max(32).optional(),
});

/**
 * `WHERE id = $1 AND owner_id = $2` — the authorization check, written as
 * part of the query itself. There is no path where we read someone else's
 * row and then forget to compare owners: a goal that isn't yours simply
 * doesn't match.
 */
function ownGoal(id: string, userId: string) {
  return and(eq(goals.id, id), eq(goals.ownerId, userId));
}

goalsRouter.get('/', async (req, res) => {
  // SELECT * FROM goals WHERE owner_id = $1 ORDER BY created_at DESC
  const rows = await db
    .select()
    .from(goals)
    .where(eq(goals.ownerId, req.userId!))
    .orderBy(desc(goals.createdAt));
  res.json(rows.map(toGoal));
});

goalsRouter.post('/', async (req, res) => {
  const parsed = createGoalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  const { cadence, ...fields } = parsed.data;

  // The API's `cadence` object is split into its two columns here.
  const [goal] = await db
    .insert(goals)
    .values({
      ...fields,
      daysOfWeek: cadence.daysOfWeek,
      timeOfDay: cadence.timeOfDay,
      ownerId: req.userId!,
    })
    .returning();
  if (!goal) throw new Error('INSERT ... RETURNING returned no row');

  // Deliberately NOT awaited. Postgres is the source of truth and the write
  // above already succeeded; the user's request must not wait on — or fail
  // because of — Redis. syncGoalSchedule never throws, and if it fails, the
  // worker's reconciliation sweep repairs the schedule within minutes.
  void syncGoalSchedule(goal);

  res.status(201).json(toGoal(goal));
});

goalsRouter.get('/:id', async (req, res) => {
  const [goal] = isUuid(req.params.id)
    ? await db.select().from(goals).where(ownGoal(req.params.id, req.userId!))
    : [];
  if (!goal) {
    // 404, not 403. Telling a stranger "this exists but isn't yours" confirms
    // the id is real; a flat 404 leaks nothing.
    res.status(404).json({ error: 'Goal not found' });
    return;
  }
  res.json(toGoal(goal));
});

const updateGoalSchema = createGoalSchema.partial().extend({
  status: z.enum(['active', 'archived']).optional(),
});

goalsRouter.patch('/:id', async (req, res) => {
  const parsed = updateGoalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  if (!isUuid(req.params.id)) {
    res.status(404).json({ error: 'Goal not found' });
    return;
  }
  const { cadence, title, description, target, targetUnit, status } = parsed.data;

  // UPDATE goals SET <only the sent fields> WHERE id = $1 AND owner_id = $2
  // RETURNING *. A field left out of the request is left out of SET, so it
  // keeps its current value.
  const [goal] = await db
    .update(goals)
    .set({
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(target !== undefined ? { target } : {}),
      ...(targetUnit !== undefined ? { targetUnit } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(cadence ? { daysOfWeek: cadence.daysOfWeek, timeOfDay: cadence.timeOfDay } : {}),
      updatedAt: new Date(),
    })
    .where(ownGoal(req.params.id, req.userId!))
    .returning();
  if (!goal) {
    res.status(404).json({ error: 'Goal not found' });
    return;
  }

  // Covers every kind of edit in one call: a new time or days re-points the
  // schedule, and archiving removes it (syncGoalSchedule checks the status).
  void syncGoalSchedule(goal);

  res.json(toGoal(goal));
});

goalsRouter.delete('/:id', async (req, res) => {
  // DELETE FROM goals WHERE id = $1 AND owner_id = $2 RETURNING id
  const [deleted] = isUuid(req.params.id)
    ? await db
        .delete(goals)
        .where(ownGoal(req.params.id, req.userId!))
        .returning({ id: goals.id })
    : [];
  if (!deleted) {
    res.status(404).json({ error: 'Goal not found' });
    return;
  }

  // No check-in cleanup here: check_ins.goal_id is ON DELETE CASCADE, so the
  // database removed this goal's check-ins in the same statement.

  // The schedule lives in Redis, which the database can't cascade into.
  // Even if this is lost, a deleted goal can't produce a reminder: the worker
  // re-reads Postgres, finds nothing, and stays silent.
  void removeGoalSchedule(deleted.id);

  res.status(204).end();
});
