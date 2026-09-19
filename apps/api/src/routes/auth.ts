import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../db/errors.js';
import { createToken } from '../lib/jwt.js';
import { env } from '../lib/env.js';
import { toUser } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';
import { timezoneSchema } from '../lib/validators.js';
import { resyncUserGoals } from '../queue/reminders.js';

export const authRouter = Router();

/**
 * Cost factor 12: bcrypt runs 2^12 rounds, taking ~250ms on typical hardware.
 * That slowness is the point — it is what makes offline brute-forcing a
 * stolen password table impractical. Raising it by 1 doubles the work.
 */
const BCRYPT_ROUNDS = 12;

// `.toLowerCase()` here, because the database has a CHECK that rejects any
// email that isn't already lowercase. Normalizing at the edge means
// "Riya@x.com" and "riya@x.com" are one account, not two.
const email = z.string().email().transform((e) => e.trim().toLowerCase());

const registerSchema = z.object({
  email,
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(100),
  timezone: timezoneSchema,
});

authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }

  const { email, password, displayName, timezone } = parsed.data;

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  let user;
  try {
    // INSERT INTO users (...) VALUES (...) RETURNING *
    // RETURNING hands back the row as stored, including the id and
    // created_at the database generated, so no second query is needed.
    [user] = await db
      .insert(users)
      .values({ email, passwordHash, displayName, timezone })
      .returning();
  } catch (err) {
    // The UNIQUE constraint on email decides, rather than a
    // look-then-insert, which races: two signups with the same email at the
    // same moment would both see "not taken".
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }
    throw err;
  }
  if (!user) throw new Error('INSERT ... RETURNING returned no row');

  const token = await createToken(user.id, env.jwtSecret, env.jwtTtlSeconds);
  res.status(201).json({ token, user: toUser(user) });
});

const loginSchema = z.object({
  email,
  password: z.string(),
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body' });
    return;
  }

  // SELECT * FROM users WHERE email = $1
  // A query always returns a LIST of rows; `[user]` takes the first one, or
  // `undefined` if there were none.
  const [user] = await db.select().from(users).where(eq(users.email, parsed.data.email));

  // Deliberately identical response for "no such user" and "wrong password".
  // Distinguishing them turns the login form into an account-enumeration
  // oracle: an attacker learns which emails are registered.
  const ok = user ? await bcrypt.compare(parsed.data.password, user.passwordHash) : false;
  if (!user || !ok) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = await createToken(user.id, env.jwtSecret, env.jwtTtlSeconds);
  res.json({ token, user: toUser(user) });
});

/** Who am I? Used by the dashboard to restore a session from a stored token. */
authRouter.get('/me', requireAuth, async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.userId!));
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(toUser(user));
});

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  timezone: timezoneSchema.optional(),
});

/**
 * Change your own profile. Note there is no `:id` — you can only ever edit
 * yourself, because the id comes from the verified token rather than the URL.
 * An endpoint like PATCH /users/:id would need an explicit "is this you?"
 * check that someone could forget; this shape makes that class of bug
 * impossible to write.
 *
 * Timezone is deliberately NOT auto-synced from the browser on every load:
 * changing it silently would rewrite when every reminder fires, which is a
 * surprising thing to happen because you crossed a timezone for a weekend.
 * It changes only when the user explicitly says so — here.
 */
authRouter.patch('/me', requireAuth, async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  const { displayName, timezone } = parsed.data;

  // UPDATE users SET ... WHERE id = $1 RETURNING *
  // Only fields that were actually sent go into SET; updatedAt is always
  // included, which also keeps SET from ever being empty (invalid SQL).
  const [user] = await db
    .update(users)
    .set({
      ...(displayName !== undefined ? { displayName } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, req.userId!))
    .returning();
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // "7:15" in a new timezone is a different instant, so every one of this
  // user's schedules just went stale at once. Re-point them now rather than
  // leaving them firing in the old zone until the next reconciliation sweep.
  if (timezone) void resyncUserGoals(user.id);

  res.json(toUser(user));
});
