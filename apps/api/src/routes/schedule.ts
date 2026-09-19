import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { scheduleBlocks } from '../db/schema.js';
import { toScheduleBlock } from '../lib/serialize.js';
import { isUuid } from '../lib/validators.js';
import { requireAuth } from '../middleware/auth.js';

export const scheduleRouter = Router();

scheduleRouter.use(requireAuth);

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

const createSchema = z.object({
  label: z.string().trim().min(1).max(60),
  startTime: timeOfDay,
  endTime: timeOfDay,
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
});

function ownBlock(id: string, userId: string) {
  return and(eq(scheduleBlocks.id, id), eq(scheduleBlocks.ownerId, userId));
}

scheduleRouter.get('/', async (req, res) => {
  // "HH:mm" text sorts correctly as plain text: fixed width, hours first.
  const rows = await db
    .select()
    .from(scheduleBlocks)
    .where(eq(scheduleBlocks.ownerId, req.userId!))
    .orderBy(asc(scheduleBlocks.startTime));
  res.json(rows.map(toScheduleBlock));
});

scheduleRouter.post('/', async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  const [block] = await db
    .insert(scheduleBlocks)
    .values({ ...parsed.data, ownerId: req.userId! })
    .returning();
  if (!block) throw new Error('INSERT ... RETURNING returned no row');
  res.status(201).json(toScheduleBlock(block));
});

scheduleRouter.patch('/:id', async (req, res) => {
  const parsed = createSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  if (!isUuid(req.params.id)) {
    res.status(404).json({ error: 'Schedule block not found' });
    return;
  }
  const { label, startTime, endTime, daysOfWeek } = parsed.data;

  const [block] = await db
    .update(scheduleBlocks)
    .set({
      ...(label !== undefined ? { label } : {}),
      ...(startTime !== undefined ? { startTime } : {}),
      ...(endTime !== undefined ? { endTime } : {}),
      ...(daysOfWeek !== undefined ? { daysOfWeek } : {}),
      updatedAt: new Date(),
    })
    .where(ownBlock(req.params.id, req.userId!))
    .returning();
  if (!block) {
    res.status(404).json({ error: 'Schedule block not found' });
    return;
  }
  res.json(toScheduleBlock(block));
});

scheduleRouter.delete('/:id', async (req, res) => {
  const [deleted] = isUuid(req.params.id)
    ? await db
        .delete(scheduleBlocks)
        .where(ownBlock(req.params.id, req.userId!))
        .returning({ id: scheduleBlocks.id })
    : [];
  if (!deleted) {
    res.status(404).json({ error: 'Schedule block not found' });
    return;
  }
  res.status(204).end();
});
