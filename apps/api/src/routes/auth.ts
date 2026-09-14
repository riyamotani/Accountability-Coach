import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { UserModel } from '../models/User.js';
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

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(100),
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
    user = await UserModel.create({ email, passwordHash, displayName, timezone });
  } catch (err) {
    // 11000 is Mongo's duplicate-key error. We let the unique index decide
    // rather than doing a findOne-then-insert, which races.
    if ((err as { code?: number }).code === 11000) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }
    throw err;
  }

  const token = await createToken(user._id.toString(), env.jwtSecret, env.jwtTtlSeconds);
  res.status(201).json({ token, user: toUser(user) });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body' });
    return;
  }

  const user = await UserModel.findOne({ email: parsed.data.email });

  // Deliberately identical response for "no such user" and "wrong password".
  // Distinguishing them turns the login form into an account-enumeration
  // oracle: an attacker learns which emails are registered.
  const ok = user ? await bcrypt.compare(parsed.data.password, user.passwordHash) : false;
  if (!user || !ok) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const token = await createToken(user._id.toString(), env.jwtSecret, env.jwtTtlSeconds);
  res.json({ token, user: toUser(user) });
});

/** Who am I? Used by the dashboard to restore a session from a stored token. */
authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await UserModel.findById(req.userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(toUser(user));
});

const updateProfileSchema = z.object({
  displayName: z.string().min(1).max(100).optional(),
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

  const user = await UserModel.findByIdAndUpdate(req.userId, parsed.data, {
    new: true,
    runValidators: true,
  });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // "7:15" in a new timezone is a different instant, so every one of this
  // user's schedules just went stale at once. Re-point them now rather than
  // leaving them firing in the old zone until the next reconciliation sweep.
  if (parsed.data.timezone) void resyncUserGoals(user._id.toString());

  res.json(toUser(user));
});
