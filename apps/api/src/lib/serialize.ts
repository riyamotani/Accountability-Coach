import type { User, Goal, CheckIn, ScheduleBlock } from '@coach/shared';
import type { CheckInRow, GoalRow, ScheduleBlockRow, UserRow } from '../db/schema.js';

/**
 * The boundary between "what the database stores" and "what the API returns".
 *
 * Without this layer, `res.json(userRow)` would happily ship `passwordHash` to
 * the browser. Mapping explicitly means a new sensitive column added to the
 * schema is invisible to clients until someone deliberately adds it here —
 * the safe default is "not exposed".
 *
 * Optional columns come back from Postgres as `null`. The API's shared types
 * express "not set" by leaving the field out, so nulls are dropped here.
 */

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    timezone: row.timezone,
    ...(row.telegramChatId ? { telegramChatId: row.telegramChatId } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    // Stored as two columns, returned as the one `cadence` object the API has
    // always exposed. Clients never learn the table layout changed.
    cadence: { daysOfWeek: [...row.daysOfWeek], timeOfDay: row.timeOfDay },
    ...(row.target != null ? { target: row.target } : {}),
    ...(row.targetUnit ? { targetUnit: row.targetUnit } : {}),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toScheduleBlock(row: ScheduleBlockRow): ScheduleBlock {
  return {
    id: row.id,
    ownerId: row.ownerId,
    label: row.label,
    startTime: row.startTime,
    endTime: row.endTime,
    daysOfWeek: [...row.daysOfWeek],
    createdAt: row.createdAt.toISOString(),
  };
}

export function toCheckIn(row: CheckInRow): CheckIn {
  return {
    id: row.id,
    goalId: row.goalId,
    ownerId: row.ownerId,
    date: row.date,
    status: row.status,
    ...(row.value != null ? { value: row.value } : {}),
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}
