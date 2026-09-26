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
  uniqueIndex,
  uuid,
  vector,
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
/**
 * What kind of change a draft represents.
 *
 * `text` + CHECK rather than a Postgres enum, changed once the assistant
 * gained the ability to create and edit goals: an enum is right for a CLOSED
 * set (a check-in is done/partial/skipped, and always will be), but every new
 * thing the bot learns to do adds a kind here. Adding a value to an enum type
 * needs its own migration; adding one to this list is a CHECK change, and the
 * list lives next to the code that reads it.
 */
export const PENDING_ACTION_KINDS = [
  'pauseWindow',
  'checkIn',
  'goalCreate',
  'goalUpdate',
  'goalArchive',
  'goalDelete',
  'scheduleBlockCreate',
  'scheduleBlockUpdate',
  'scheduleBlockDelete',
] as const;
export type PendingActionKind = (typeof PENDING_ACTION_KINDS)[number];

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

    /**
     * Set when the bot has gone quiet because the user stopped responding,
     * and cleared the moment they do anything again.
     *
     * Without this, someone who ignores the bot for a month keeps receiving
     * daily reminders — which is how an app gets muted or blocked, and it
     * spends AI budget on messages nobody reads. Silence is an answer.
     *
     * A column rather than a derived query because it records that the ONE
     * goodbye message was already sent; recomputing "has been silent for 7
     * days" would send it again every single day.
     */
    dormantSince: timestamp('dormant_since', { withTimezone: true }),

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
    kind: text('kind').$type<PendingActionKind>().notNull(),
    // jsonb: stored as parsed binary JSON, queryable, shape depends on `kind`.
    // Validated by the tool that writes it, like Mongoose's `Mixed` was.
    payload: jsonb('payload').$type<PendingActionPayload>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pending_actions_expires_at_idx').on(t.expiresAt),
    // sql.raw, not `${kind}` interpolation: a CHECK is part of the stored
    // table definition, so the values must be written into it literally.
    // Interpolation would send them as query PARAMETERS ($1, $2, …), which is
    // right for a query and invalid in a constraint — Postgres rejects a
    // definition that references parameters. The values here are our own
    // constants, never user input.
    check(
      'pending_actions_kind_valid',
      sql.raw(`"kind" IN (${PENDING_ACTION_KINDS.map((kind) => `'${kind}'`).join(', ')})`),
    ),
  ],
);

// ---------------------------------------------------------------------------
// negotiations — the bot renegotiating a goal that isn't working
// ---------------------------------------------------------------------------

/**
 * Where a negotiation currently is. `proposed` is the only OPEN state; the
 * other three are terminal and all start the cooldown before this goal can
 * be raised again.
 */
export const NEGOTIATION_STATUSES = ['proposed', 'agreed', 'declined', 'abandoned'] as const;
export type NegotiationStatus = (typeof NEGOTIATION_STATUSES)[number];

/**
 * The durable half of the negotiation loop.
 *
 * The bot notices a goal is being missed, proposes a change, and the user
 * replies — maybe in ten minutes, maybe tomorrow. Between those moments
 * NOTHING is running: the model is stateless, the process may restart, days
 * may pass. So "we are mid-negotiation, round 2, this is what was proposed"
 * has to live in a row, and a job has to wake it up.
 *
 * That separation is the whole design: CODE decides when to speak and
 * enforces the rules that need guarantees (cooldown, round limit, applying
 * the agreed change exactly once); the MODEL decides what to say inside a
 * turn. A prompt can be persuaded to do the former; it cannot be relied on.
 */
export const negotiations = pgTable(
  'negotiations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    goalId: uuid('goal_id')
      .notNull()
      .references(() => goals.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    status: text('status').$type<NegotiationStatus>().notNull().default('proposed'),

    /**
     * Counting from 1. Each user counter-offer that the bot answers is a new
     * round; at MAX_ROUNDS the bot stops and leaves the goal alone, so a
     * disagreement can't become an endless exchange.
     */
    round: smallint('round').notNull().default(1),

    /**
     * What the bot is proposing, as `{ kind, ...fields }`. jsonb rather than
     * columns because the SHAPES will multiply: today "fewer days" or "a
     * different time", later "lower the monthly budget". A new kind of
     * proposal should be a new payload through this same machine, not a new
     * machine.
     */
    proposal: jsonb('proposal').$type<Record<string, unknown>>().notNull(),

    /**
     * The numbers that triggered it ("1 of 4 due days in the last fortnight"),
     * frozen at trigger time. Stored rather than recomputed so the bot can
     * quote the same figures three days later, when a check-in since would
     * otherwise change them mid-conversation.
     */
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),

    /** When the bot last said something — the clock for nudging and giving up. */
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the single reminder-of-a-pending-proposal has been sent. */
    nudgedAt: timestamp('nudged_at', { withTimezone: true }),
    /** Set when the negotiation reached a terminal state. Drives the cooldown. */
    closedAt: timestamp('closed_at', { withTimezone: true }),

    ...timestamps(),
  },
  (t) => [
    /**
     * At most ONE open negotiation per goal, enforced by the database.
     *
     * A partial unique index: the uniqueness applies only to rows where
     * status = 'proposed', so a goal can have many closed negotiations in its
     * history but never two live ones. Without it, the daily sweep racing
     * itself (or running on two workers) could open a second conversation
     * about the same goal.
     */
    uniqueIndex('negotiations_one_open_per_goal')
      .on(t.goalId)
      .where(sql`status = 'proposed'`),

    // "Has this goal been negotiated recently?" — the cooldown check.
    index('negotiations_goal_created_idx').on(t.goalId, t.createdAt.desc()),
    // "Does this user have an open negotiation?" — asked on every message.
    index('negotiations_owner_status_idx').on(t.ownerId, t.status),

    check(
      'negotiations_status_valid',
      sql.raw(`"status" IN (${NEGOTIATION_STATUSES.map((s) => `'${s}'`).join(', ')})`),
    ),
    check('negotiations_round_positive', sql`${t.round} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// chat_messages — the running conversation with the assistant
// ---------------------------------------------------------------------------

/**
 * SHORT-TERM memory, and a different thing from the `memories` table below.
 *
 * Each call to the model is a fresh HTTP request that remembers nothing about
 * the last one. Without this table, "actually make it 10pm" arrives with no
 * idea what "it" is, because the goal was created in a request that no longer
 * exists anywhere. (Seen live: the bot created a goal, then said it didn't
 * know which goal the user meant, seconds later.)
 *
 * The split is worth keeping clear:
 *   chat_messages — what was SAID recently, in order. Resolves "it", "that
 *                   one", "make it later". Read by RECENCY.
 *   memories      — what is TRUE about the user, however long ago they said
 *                   it. Read by MEANING, via embeddings.
 *
 * Semantic search cannot do the first job: "actually make it 10pm" has almost
 * no meaning in common with "read 20 pages every weekday at 9pm", so it would
 * score low — while "the turn immediately before this one" is trivially
 * correct and needs no AI at all.
 */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Only the two ends of the conversation are stored. Tool calls and their
    // results are deliberately left out: replaying them later would show the
    // model an hour-old goal list as if it were current.
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "The last N messages for this user" — the only query this table serves.
    index('chat_messages_owner_created_idx').on(t.ownerId, t.createdAt.desc()),
    check('chat_messages_role_valid', sql.raw(`"role" IN ('user', 'assistant')`)),
  ],
);

// ---------------------------------------------------------------------------
// memories — the freeform things a user tells the bot
// ---------------------------------------------------------------------------

/**
 * Where a memory came from. Not an enum type, because new sources are likely
 * (a weekly digest, an imported journal) and adding a value to a Postgres
 * enum needs a migration, while text + CHECK does not.
 */
export const MEMORY_SOURCES = ['chat', 'checkIn', 'digest'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** Must match the embedding model in env.ts. Changing it means re-embedding. */
export const EMBEDDING_DIMENSIONS = 1536;

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    // The user's own words, stored exactly as written and NEVER edited.
    // This table is the source of truth for recall: summaries and any
    // external memory provider are rebuilt from it, so it must keep the
    // history those would otherwise overwrite.
    content: text('content').notNull(),
    source: text('source').$type<MemorySource>().notNull(),

    /**
     * The meaning of `content` as 1536 numbers, from the embedding model.
     * Nullable on purpose: the row is written first and embedded after (a
     * retryable job), so a temporary AI outage can't lose what the user said.
     * A row with NULL here is simply not searchable yet.
     */
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    // Which model produced `embedding`. Vectors from different models aren't
    // comparable, so a model change has to be detectable rather than silently
    // corrupting search results.
    embeddingModel: text('embedding_model'),

    ...timestamps(),
  },
  (t) => [
    // "This user's memories, newest first" — and the owner filter every
    // similarity search starts from.
    index('memories_owner_created_idx').on(t.ownerId, t.createdAt.desc()),

    /**
     * An HNSW index over the vectors: the thing that makes "find the nearest
     * points" fast instead of comparing against every row. `vector_cosine_ops`
     * must match the distance function the query uses (cosine distance here);
     * an index built for one distance can't serve another.
     *
     * Unlike a B-tree, this index is APPROXIMATE — it can miss a true nearest
     * neighbour occasionally, in exchange for being dramatically faster. For
     * "remind me what they said about this", that trade is fine.
     */
    index('memories_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    check('memories_content_not_empty', sql`length(trim(${t.content})) > 0`),
    check(
      'memories_source_valid',
      sql`${t.source} IN ('chat', 'checkIn', 'digest')`,
    ),
  ],
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
export type MemoryRow = typeof memories.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type NegotiationRow = typeof negotiations.$inferSelect;
