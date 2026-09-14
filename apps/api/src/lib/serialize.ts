import type { User, Goal, CheckIn, ScheduleBlock } from '@coach/shared';
import type { UserDoc } from '../models/User.js';
import type { GoalDoc } from '../models/Goal.js';
import type { CheckInDoc } from '../models/CheckIn.js';
import type { ScheduleBlockDoc } from '../models/ScheduleBlock.js';

/**
 * The boundary between "what Mongo stores" and "what the API returns".
 *
 * Without this layer, `res.json(userDoc)` would happily ship `passwordHash`,
 * `__v`, and raw ObjectIds to the browser. Mapping explicitly means a new
 * sensitive field added to a schema is invisible to clients until someone
 * deliberately adds it here — the safe default is "not exposed".
 */

export function toUser(doc: UserDoc): User {
  return {
    id: doc._id.toString(),
    email: doc.email,
    displayName: doc.displayName,
    timezone: doc.timezone,
    ...(doc.telegramChatId ? { telegramChatId: doc.telegramChatId } : {}),
    createdAt: doc.createdAt.toISOString(),
  };
}

export function toGoal(doc: GoalDoc): Goal {
  return {
    id: doc._id.toString(),
    ownerId: doc.ownerId.toString(),
    title: doc.title,
    ...(doc.description ? { description: doc.description } : {}),
    cadence: { daysOfWeek: [...doc.cadence.daysOfWeek], timeOfDay: doc.cadence.timeOfDay },
    ...(doc.target != null ? { target: doc.target } : {}),
    ...(doc.targetUnit ? { targetUnit: doc.targetUnit } : {}),
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
  };
}

export function toScheduleBlock(doc: ScheduleBlockDoc): ScheduleBlock {
  return {
    id: doc._id.toString(),
    ownerId: doc.ownerId.toString(),
    label: doc.label,
    startTime: doc.startTime,
    endTime: doc.endTime,
    daysOfWeek: [...doc.daysOfWeek],
    createdAt: doc.createdAt.toISOString(),
  };
}

export function toCheckIn(doc: CheckInDoc): CheckIn {
  return {
    id: doc._id.toString(),
    goalId: doc.goalId.toString(),
    ownerId: doc.ownerId.toString(),
    date: doc.date,
    status: doc.status,
    ...(doc.value != null ? { value: doc.value } : {}),
    ...(doc.note ? { note: doc.note } : {}),
    createdAt: doc.createdAt.toISOString(),
  };
}
