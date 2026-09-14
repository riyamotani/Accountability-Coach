import { Router } from 'express';
import { z } from 'zod';
import { ScheduleBlockModel } from '../models/ScheduleBlock.js';
import { toScheduleBlock } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';

export const scheduleRouter = Router();

scheduleRouter.use(requireAuth);

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

const createSchema = z.object({
  label: z.string().min(1).max(60),
  startTime: timeOfDay,
  endTime: timeOfDay,
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
});

scheduleRouter.get('/', async (req, res) => {
  const blocks = await ScheduleBlockModel.find({ ownerId: req.userId }).sort({ startTime: 1 });
  res.json(blocks.map(toScheduleBlock));
});

scheduleRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  const block = await ScheduleBlockModel.create({ ...parsed.data, ownerId: req.userId });
  res.status(201).json(toScheduleBlock(block));
});

scheduleRouter.patch('/:id', async (req, res) => {
  const parsed = createSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  const block = await ScheduleBlockModel.findOneAndUpdate(
    { _id: req.params.id, ownerId: req.userId },
    parsed.data,
    { new: true, runValidators: true },
  );
  if (!block) {
    res.status(404).json({ error: 'Schedule block not found' });
    return;
  }
  res.json(toScheduleBlock(block));
});

scheduleRouter.delete('/:id', async (req, res) => {
  const deleted = await ScheduleBlockModel.findOneAndDelete({
    _id: req.params.id,
    ownerId: req.userId,
  });
  if (!deleted) {
    res.status(404).json({ error: 'Schedule block not found' });
    return;
  }
  res.status(204).end();
});
