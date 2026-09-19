/**
 * The domain vocabulary, defined once and shared by the API, the dashboard,
 * and (later) the Telegram bot and the BullMQ worker.
 *
 * These are transport types — the shape of JSON crossing the wire. The
 * database's own row types live on the server (inferred from the Drizzle
 * schema) and are mapped to these before anything is sent; this file is what
 * everyone else agrees on. Ids are uuid strings.
 */

export type Id = string;

/** ISO-8601 instant, e.g. "2026-09-12T09:00:00.000Z". Always UTC. */
export type IsoDateTime = string;

/** Calendar day in the user's own timezone, "YYYY-MM-DD". Not an instant. */
export type LocalDate = string;

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

export interface User {
  id: Id;
  email: string;
  displayName: string;
  /** IANA zone, e.g. "Asia/Kolkata". Every reminder time is resolved against this. */
  timezone: string;
  /** Set once the user links their Telegram account. Absent until then. */
  telegramChatId?: string;
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// Goal
// ---------------------------------------------------------------------------

/**
 * When a goal is due. One shape covers both "every day" and "Mon/Wed/Fri" —
 * daily is just all seven days — so there is no union to branch on.
 */
export interface Cadence {
  /** 0 = Sunday … 6 = Saturday. Must be non-empty. */
  daysOfWeek: number[];
  /** Wall-clock time in the OWNER's timezone, "HH:mm" 24h. Not UTC. */
  timeOfDay: string;
}

export type GoalStatus = 'active' | 'archived';

export interface Goal {
  id: Id;
  ownerId: Id;
  title: string;
  /** Optional free text: the "why", context for the AI layer later. */
  description?: string;
  cadence: Cadence;
  /** Optional numeric target for one occurrence, e.g. 30 (minutes), 5 (pages). */
  target?: number;
  /** Unit label for `target`, e.g. "minutes". Meaningless without it. */
  targetUnit?: string;
  status: GoalStatus;
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// CheckIn
// ---------------------------------------------------------------------------

export type CheckInStatus = 'done' | 'partial' | 'skipped';

export interface CheckIn {
  id: Id;
  goalId: Id;
  ownerId: Id;
  /** The day this check-in is FOR, in the owner's timezone. One per goal per day. */
  date: LocalDate;
  status: CheckInStatus;
  /** Actual amount achieved, compared against Goal.target. */
  value?: number;
  note?: string;
  createdAt: IsoDateTime;
}

// ---------------------------------------------------------------------------
// API request/response payloads
// ---------------------------------------------------------------------------

export interface RegisterBody {
  email: string;
  password: string;
  displayName: string;
  timezone: string;
}

export interface LoginBody {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

/** Fields a user can change about themselves after signup. */
export interface UpdateProfileBody {
  displayName?: string;
  timezone?: string;
}

export interface CreateGoalBody {
  title: string;
  description?: string;
  cadence: Cadence;
  target?: number;
  targetUnit?: string;
}

export type UpdateGoalBody = Partial<CreateGoalBody> & { status?: GoalStatus };

export interface CreateCheckInBody {
  goalId: Id;
  date: LocalDate;
  status: CheckInStatus;
  value?: number;
  note?: string;
}

// ---------------------------------------------------------------------------
// ScheduleBlock — the shape of a typical day
// ---------------------------------------------------------------------------

/**
 * A recurring block of the user's day: "Work 09:00-19:00, Mon-Fri".
 *
 * This is deliberately NOT a Goal. You don't check in on "work" — it isn't
 * something you're trying to do, it's a constraint that makes some reminder
 * times unrealistic. Its job is context: the scheduler avoids proposing
 * times that collide with it, and a planned negotiation feature will read it
 * to suggest slots that could actually happen (not built yet).
 */
export interface ScheduleBlock {
  id: Id;
  ownerId: Id;
  /** Short human label, e.g. "Work", "Sleep", "Dinner". */
  label: string;
  /** "HH:mm" 24h, in the owner's timezone. */
  startTime: string;
  /**
   * "HH:mm". If this is <= startTime the block wraps past midnight —
   * sleep at 23:00-07:00 is one block, not two.
   */
  endTime: string;
  /** Same 0=Sunday..6=Saturday convention as Cadence. */
  daysOfWeek: number[];
  createdAt: IsoDateTime;
}

export interface CreateScheduleBlockBody {
  label: string;
  startTime: string;
  endTime: string;
  daysOfWeek: number[];
}

export type UpdateScheduleBlockBody = Partial<CreateScheduleBlockBody>;

// ---------------------------------------------------------------------------
// PauseWindow — "on vacation, don't disturb me"
// ---------------------------------------------------------------------------

/**
 * A date range where the scheduler should stay silent for this user. Checked
 * by the worker before every reminder fires. A paused day is neither `done`
 * nor `skipped`: no CheckIn row
 * gets written for a paused day at all; it's simply excluded from whatever
 * later counts "days due".
 */
export interface PauseWindow {
  id: Id;
  ownerId: Id;
  from: LocalDate;
  to: LocalDate;
  reason?: string;
  createdAt: IsoDateTime;
}

export interface CreatePauseWindowBody {
  from: LocalDate;
  to: LocalDate;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Assistant — free-text Q&A and requests over Telegram
// ---------------------------------------------------------------------------

export interface AssistantAskBody {
  message: string;
}

export interface AssistantAskResponse {
  reply: string;
}

// ---------------------------------------------------------------------------
// Telegram linking
// ---------------------------------------------------------------------------

/** What the dashboard gets back when it asks for a linking code. */
export interface LinkCodeResponse {
  code: string;
  expiresAt: IsoDateTime;
  /** Ready-made deep link — clicking it sends `/start <code>` to the bot. */
  deepLink: string;
}

/** What the BOT sends to redeem a code on a user's behalf. */
export interface TelegramLinkBody {
  code: string;
  chatId: string;
}

/** Every error the API returns has this shape. */
export interface ApiError {
  error: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

/**
 * Today's calendar date in a given IANA timezone, as "YYYY-MM-DD".
 *
 * The server's own clock is irrelevant to "what day is it for this user".
 * At 1:00 AM in Kolkata it's still the previous evening in London, so a
 * server in one zone computing `new Date().getDate()` gets the wrong day for
 * users in another — the exact bug the bot's "today" had until now.
 *
 * `formatToParts` rather than parsing a formatted string: it hands back
 * labelled pieces (year / month / day) instead of relying on a locale's
 * separator and ordering conventions happening to produce YYYY-MM-DD.
 */
export function localDateInZone(timeZone: string, at: Date = new Date()): LocalDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Current wall-clock time in a given IANA timezone, as "HH:mm" (24h).
 *
 * Same technique as localDateInZone — ask the runtime what the clock actually
 * reads in that zone, rather than computing a UTC offset by hand (which gets
 * DST wrong twice a year).
 */
export function localTimeInZone(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('hour')}:${get('minute')}`;
}

/**
 * "18:00" -> "6:00 PM".
 *
 * Lives here rather than in each app because EVERY client has to agree on how
 * a time reads. It was previously copy-pasted into the dashboard, two web
 * components, and then nearly a fourth time into the bot — at which point the
 * bot was still printing raw "18:00" while the dashboard said "6:00 PM" for
 * the same goal.
 *
 * Storage stays 24-hour ("HH:mm") because it sorts and compares correctly as
 * a plain string; only the DISPLAY is 12-hour. Never store the formatted form.
 */
export function formatTimeOfDay(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const hour = h ?? 0;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(m ?? 0).padStart(2, '0')} ${suffix}`;
}
