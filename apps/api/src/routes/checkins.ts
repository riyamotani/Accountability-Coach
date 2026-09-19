import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { checkIns, goals } from '../db/schema.js';
import { toCheckIn } from '../lib/serialize.js';
import { isUuid } from '../lib/validators.js';
import { requireAuth } from '../middleware/auth.js';

export const checkInsRouter = Router();

checkInsRouter.use(requireAuth);

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const listQuerySchema = z.object({
  goalId: z.string().uuid().optional(),
  from: localDate.optional(),
  to: localDate.optional(),
});

checkInsRouter.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query', details: parsed.error.flatten() });
    return;
  }
  const { goalId, from, to } = parsed.data;

  // SELECT * FROM check_ins
  // WHERE owner_id = $1 [AND goal_id = $2] [AND date >= $3] [AND date <= $4]
  // ORDER BY date DESC
  //
  // `and()` skips `undefined` entries, so each optional filter is simply
  // left out when it wasn't asked for.
  const rows = await db
    .select()
    .from(checkIns)
    .where(
      and(
        eq(checkIns.ownerId, req.userId!),
        goalId ? eq(checkIns.goalId, goalId) : undefined,
        from ? gte(checkIns.date, from) : undefined,
        to ? lte(checkIns.date, to) : undefined,
      ),
    )
    .orderBy(desc(checkIns.date));

  res.json(rows.map(toCheckIn));
});

const upsertSchema = z.object({
  goalId: z.string().uuid(),
  date: localDate,
  status: z.enum(['done', 'partial', 'skipped']),
  value: z.number().min(0).optional(),
  note: z.string().max(2000).optional(),
});

/**
 * Create-or-update, deliberately. Marking a goal done twice for the same day
 * should not be an error — it should just be done.
 *
 * This also matters because two different clients — the dashboard and the
 * Telegram bot — can both write a check-in for the same goal at nearly the
 * same moment. Neither should error because of the other.
 */
checkInsRouter.put('/', async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  const { goalId, date, status, value, note } = parsed.data;

  // Confirm the goal is THIS user's before writing a check-in against it.
  // The foreign key only proves the goal EXISTS, not whose it is — skipping
  // this would let anyone attach check-ins to any goal id they got hold of.
  const [goal] = await db
    .select({ id: goals.id })
    .from(goals)
    .where(and(eq(goals.id, goalId), eq(goals.ownerId, req.userId!)));
  if (!goal) {
    res.status(404).json({ error: 'Goal not found' });
    return;
  }

  // Fields the client didn't send stay as they were on an existing row.
  const changes = {
    status,
    ...(value !== undefined ? { value } : {}),
    ...(note !== undefined ? { note } : {}),
  };

  // INSERT INTO check_ins (...) VALUES (...)
  // ON CONFLICT (goal_id, date) DO UPDATE SET status = ..., updated_at = ...
  // RETURNING *
  //
  // One atomic statement: if a row for this goal+day exists, the UNIQUE
  // constraint on (goal_id, date) turns the insert into an update. Two
  // clients racing can't create two rows or make each other fail.
  const [checkIn] = await db
    .insert(checkIns)
    .values({ goalId, date, ownerId: req.userId!, ...changes })
    .onConflictDoUpdate({
      target: [checkIns.goalId, checkIns.date],
      set: { ...changes, updatedAt: new Date() },
    })
    .returning();
  if (!checkIn) throw new Error('upsert returned no row');

  res.json(toCheckIn(checkIn));
});

checkInsRouter.delete('/:id', async (req, res) => {
  const [deleted] = isUuid(req.params.id)
    ? await db
        .delete(checkIns)
        .where(and(eq(checkIns.id, req.params.id), eq(checkIns.ownerId, req.userId!)))
        .returning({ id: checkIns.id })
    : [];
  if (!deleted) {
    res.status(404).json({ error: 'Check-in not found' });
    return;
  }
  res.status(204).end();
});
