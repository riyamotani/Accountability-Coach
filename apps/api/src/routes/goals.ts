import { Router } from 'express';
import { z } from 'zod';
import { GoalModel } from '../models/Goal.js';
import { CheckInModel } from '../models/CheckIn.js';
import { toGoal } from '../lib/serialize.js';
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
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  cadence: cadenceSchema,
  target: z.number().min(0).optional(),
  targetUnit: z.string().max(32).optional(),
});

goalsRouter.get('/', async (req, res) => {
  // `ownerId: req.userId` is the authorization check. It is part of the query,
  // not a separate `if` after fetching — so there is no path where we read
  // someone else's row and then forget to compare.
  const goals = await GoalModel.find({ ownerId: req.userId }).sort({ createdAt: -1 });
  res.json(goals.map(toGoal));
});

goalsRouter.post('/', async (req, res) => {
  const parsed = createGoalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }

  const goal = await GoalModel.create({ ...parsed.data, ownerId: req.userId });

  // Deliberately NOT awaited. Mongo is the source of truth and the write above
  // already succeeded; the user's request must not wait on — or fail because
  // of — Redis. syncGoalSchedule never throws, and if it fails, the worker's
  // reconciliation sweep repairs the schedule within minutes.
  void syncGoalSchedule(goal);

  res.status(201).json(toGoal(goal));
});

goalsRouter.get('/:id', async (req, res) => {
  const goal = await GoalModel.findOne({ _id: req.params.id, ownerId: req.userId });
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

  const goal = await GoalModel.findOneAndUpdate(
    { _id: req.params.id, ownerId: req.userId },
    parsed.data,
    { new: true, runValidators: true },
  );
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
  const goal = await GoalModel.findOneAndDelete({ _id: req.params.id, ownerId: req.userId });
  if (!goal) {
    res.status(404).json({ error: 'Goal not found' });
    return;
  }

  // Mongo has no foreign keys and no ON DELETE CASCADE. Orphaned check-ins are
  // ours to prevent.
  await CheckInModel.deleteMany({ goalId: goal._id });

  // And the schedule. Even if this is lost, a deleted goal can't produce a
  // reminder: the worker re-reads Mongo, finds nothing, and stays silent.
  void removeGoalSchedule(goal._id.toString());

  res.status(204).end();
});
