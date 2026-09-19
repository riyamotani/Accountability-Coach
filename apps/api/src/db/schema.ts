import { sql } from 'drizzle-orm';
import {
  check,
  date,
  doublePrecision,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The whole database, described in TypeScript.
 *
 * This file is read twice, by two different tools:
 *   - drizzle-kit compares it against the previous migration and writes the
 *     SQL needed to get from there to here (`npm run db:generate`).
 *   - drizzle-orm uses it at runtime to type every query, so a typo in a
 *     column name is a compile error rather than a silently empty result.
 *
 * Column names are spelled out in snake_case (`text('display_name')`) even
 * though the TypeScript keys are camelCase. SQL folds unquoted identifiers to
 * lowercase, so snake_case is the Postgres convention, and spelling it out
 * keeps "what is this column called in psql?" answerable by reading this file.
 */

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * `timestamptz`, never plain `timestamp`: plain `timestamp` stores the digits
 * and throws the timezone away, so the same row reads back differently
 * depending on the server's zone. `timestamptz` stores an exact instant.
 *
 * A function rather than a shared object, so every table gets its own column
 * builders instead of several tables holding references to the same ones.
 */
const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Mongoose's `timestamps: true` did this automatically. Here it's explicit:
  // Drizzle sets it on every update it issues. A raw SQL UPDATE typed in psql
  // would not, which is fine for a dev convenience field.
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Enums are real Postgres types: the database itself rejects 'dnoe'. Adding a
 * value later is one `ALTER TYPE ... ADD VALUE`; removing one is awkward, so
 * enums are only used for sets that are genuinely closed.
 */
export const goalStatus = pgEnum('goal_status', ['active', 'archived']);
export const checkInStatus = pgEnum('check_in_status', ['done', 'partial', 'skipped']);
export const pendingActionKind = pgEnum('pending_action_kind', ['pauseWindow', 'checkIn']);

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    // gen_random_uuid() is built into Postgres 13+, so the database creates
    // ids itself. UUIDs over auto-increment integers: an id like 7 invites
    // guessing 8, and a UUID is also safe to generate outside the database.
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    // `passwordHash`, never `password`: there is no column a plaintext
    // password could be written into by mistake.
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    // A plain UNIQUE is enough for an optional column. Postgres treats NULLs
    // as distinct from each other, so any number of unlinked users can have
    // NULL here. Mongo needed `sparse: true` for the same effect.
    telegramChatId: text('telegram_chat_id').unique(),
    ...timestamps(),
  },
  (t) => [
    // Mongoose lowercased emails on save. The app still lowercases, and this
    // guarantees no mixed-case address can slip in by another path and then
    // bypass the unique check ("A@x.com" and "a@x.com" would both fit).
    check('users_email_lowercase', sql`${t.email} = lower(${t.email})`),
  ],
);

// ---------------------------------------------------------------------------
// goals
// ---------------------------------------------------------------------------

export const goals = pgTable(
  'goals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // ON DELETE CASCADE: deleting a user deletes their goals, done by the
    // database in the same transaction. No cleanup code to forget.
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),

    // Mongo embedded these in a `cadence` object. A relational table stores
    // them as two columns, and the serializer rebuilds the object for the API.
    // 0 = Sunday ... 6 = Saturday.
    daysOfWeek: smallint('days_of_week').array().notNull(),
    // "HH:mm" in the OWNER's timezone. Text rather than Postgres's `time`
    // type: `time` reads back as "18:00:00", and every caller works in
    // "18:00". The CHECK below keeps the text honest.
    timeOfDay: text('time_of_day').notNull(),

    // double precision reads back as a JS number. `numeric` would be exact
    // but reads back as a string, which isn't worth it for "30 minutes".
    target: doublePrecision('target'),
    targetUnit: text('target_unit'),
    status: goalStatus('status').notNull().default('active'),
    ...timestamps(),
  },
  (t) => [
    // "Which active goals does this user have?" is the scheduler's and the
    // dashboard's most common question.
    index('goals_owner_status_idx').on(t.ownerId, t.status),
    // `<@` means "is contained by": every element must be one of 0-6.
    check(
      'goals_days_of_week_valid',
      sql`cardinality(${t.daysOfWeek}) > 0 AND ${t.daysOfWeek} <@ ARRAY[0,1,2,3,4,5,6]::smallint[]`,
    ),
    // `~` is Postgres's "matches this regular expression" operator.
    check('goals_time_of_day_format', sql`${t.timeOfDay} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
    check('goals_target_non_negative', sql`${t.target} IS NULL OR ${t.target} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// check_ins
// ---------------------------------------------------------------------------

export const checkIns = pgTable(
  'check_ins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    goalId: uuid('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    // Derivable through goal_id -> goals.owner_id, but kept so "my check-ins"
    // and every ownership check need no join. Goals never change owner, so
    // the two can't disagree.
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // A real calendar-day type: no time, no timezone. Drizzle's default
    // `string` mode reads it back as "2026-09-15", the same LocalDate string
    // the rest of the app already uses.
    date: date('date').notNull(),
    status: checkInStatus('status').notNull(),
    value: doublePrecision('value'),
    note: text('note'),
    ...timestamps(),
  },
  (t) => [
    // One check-in per goal per day, enforced by the database: two requests
    // arriving at once (dashboard + bot) can't both insert. Also the conflict
    // target that makes upserts (`ON CONFLICT (goal_id, date)`) possible.
    unique('check_ins_goal_date_unique').on(t.goalId, t.date),
    // "My recent check-ins, newest first."
    index('check_ins_owner_date_idx').on(t.ownerId, t.date.desc()),
    check('check_ins_value_non_negative', sql`${t.value} IS NULL OR ${t.value} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// schedule_blocks
// ---------------------------------------------------------------------------

export const scheduleBlocks = pgTable(
  'schedule_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    // Owner's timezone. end <= start is allowed on purpose: it means the
    // block wraps past midnight (sleep 23:00-07:00).
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    daysOfWeek: smallint('days_of_week').array().notNull(),
    ...timestamps(),
  },
  (t) => [
    index('schedule_blocks_owner_idx').on(t.ownerId),
    check(
      'schedule_blocks_days_of_week_valid',
      sql`cardinality(${t.daysOfWeek}) > 0 AND ${t.daysOfWeek} <@ ARRAY[0,1,2,3,4,5,6]::smallint[]`,
    ),
    check('schedule_blocks_start_time_format', sql`${t.startTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
    check('schedule_blocks_end_time_format', sql`${t.endTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  ],
);

// ---------------------------------------------------------------------------
// pause_windows
// ---------------------------------------------------------------------------

export const pauseWindows = pgTable(
  'pause_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // `from` and `to` are reserved words in SQL (`SELECT ... FROM`), so the
    // columns are from_date/to_date. The TypeScript keys can keep the short
    // names; only the SQL spelling has to avoid the keywords.
    from: date('from_date').notNull(),
    to: date('to_date').notNull(),
    reason: text('reason'),
    ...timestamps(),
  },
  (t) => [
    // Serves the worker's "is this user paused on this date?" lookup.
    index('pause_windows_owner_range_idx').on(t.ownerId, t.from, t.to),
    check('pause_windows_range_valid', sql`${t.from} <= ${t.to}`),
  ],
);

// ---------------------------------------------------------------------------
// Short-lived rows: link_codes, pending_actions
//
// Mongo deleted these by itself with TTL indexes. Postgres has no TTL, so the
// reconcile job deletes expired rows, and the expires_at indexes make that
// sweep cheap. Expiry was never enforced by deletion anyway: every read
// checks expires_at, because a row can outlive its expiry until the sweep.
// ---------------------------------------------------------------------------

export const linkCodes = pgTable(
  'link_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('link_codes_user_idx').on(t.userId),
    index('link_codes_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * A draft the assistant proposed and the user hasn't confirmed yet. The
 * propose tools can ONLY write here; only the confirm tool turns a draft into
 * a real pause window or check-in. That code path, not a prompt instruction,
 * is what stops the model from writing data on its own.
 */
export type PendingActionPayload = Record<string, unknown>;

export const pendingActions = pgTable(
  'pending_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // UNIQUE: at most one draft per user. A new proposal replaces the old one
    // (`ON CONFLICT (user_id) DO UPDATE`), so a stale draft can't be
    // confirmed by accident later.
    userId: uuid('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: pendingActionKind('kind').notNull(),
    // jsonb: stored as parsed binary JSON, queryable, shape depends on `kind`.
    // Validated by the tool that writes it, like Mongoose's `Mixed` was.
    payload: jsonb('payload').$type<PendingActionPayload>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('pending_actions_expires_at_idx').on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// Row types, inferred from the tables above, so they can never drift from
// the schema. `$inferSelect` is what a query returns; `$inferInsert` is what
// an insert accepts (columns with defaults become optional).
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type GoalRow = typeof goals.$inferSelect;
export type NewGoal = typeof goals.$inferInsert;
export type CheckInRow = typeof checkIns.$inferSelect;
export type ScheduleBlockRow = typeof scheduleBlocks.$inferSelect;
export type PauseWindowRow = typeof pauseWindows.$inferSelect;
export type LinkCodeRow = typeof linkCodes.$inferSelect;
export type PendingActionRow = typeof pendingActions.$inferSelect;
