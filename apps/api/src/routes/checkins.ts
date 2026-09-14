import { Router } from 'express';
import { z } from 'zod';
import { CheckInModel } from '../models/CheckIn.js';
import { GoalModel } from '../models/Goal.js';
import { toCheckIn } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';

export const checkInsRouter = Router();

checkInsRouter.use(requireAuth);

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const listQuerySchema = z.object({
  goalId: z.string().optional(),
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

  // "YYYY-MM-DD" sorts and range-compares correctly as a plain string, because
  // the format is fixed-width and big-endian. That is why this date format is
  // worth the mild awkwardness of not being a Date object.
  const dateFilter = {
    ...(from ? { $gte: from } : {}),
    ...(to ? { $lte: to } : {}),
  };

  const checkIns = await CheckInModel.find({
    ownerId: req.userId,
    ...(goalId ? { goalId } : {}),
    ...(from || to ? { date: dateFilter } : {}),
  }).sort({ date: -1 });

  res.json(checkIns.map(toCheckIn));
});

const upsertSchema = z.object({
  goalId: z.string(),
  date: localDate,
  status: z.enum(['done', 'partial', 'skipped']),
  value: z.number().min(0).optional(),
  note: z.string().max(2000).optional(),
});

/**
 * Create-or-update, deliberately. Marking a goal done twice for the same day
 * should not be an error — it should just be done. The unique index on
 * (goalId, date) makes a plain insert throw, so we upsert instead.
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
  const { goalId, date, ...rest } = parsed.data;

  // Confirm the goal is THIS user's before writing a check-in against it.
  // Skipping this would let anyone attach check-ins to any goal id they guess.
  const goal = await GoalModel.findOne({ _id: goalId, ownerId: req.userId });
  if (!goal) {
    res.status(404).json({ error: 'Goal not found' });
    return;
  }

  const checkIn = await CheckInModel.findOneAndUpdate(
    { goalId, date },
    { $set: { ...rest, ownerId: req.userId } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  );

  res.json(toCheckIn(checkIn));
});

checkInsRouter.delete('/:id', async (req, res) => {
  const deleted = await CheckInModel.findOneAndDelete({
    _id: req.params.id,
    ownerId: req.userId,
  });
  if (!deleted) {
    res.status(404).json({ error: 'Check-in not found' });
    return;
  }
  res.status(204).end();
});
