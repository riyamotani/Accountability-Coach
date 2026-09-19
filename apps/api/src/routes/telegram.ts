import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { linkCodes, users } from '../db/schema.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../db/errors.js';
import { env } from '../lib/env.js';
import { toUser } from '../lib/serialize.js';
import { requireAuth, secretMatches } from '../middleware/auth.js';

export const telegramRouter = Router();

/**
 * Ambiguous characters removed on purpose (no 0/O, no 1/I/L). This code gets
 * read off a screen and typed into a phone; "was that a zero or an O?" is a
 * support problem you design away rather than answer.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode(length = 6): string {
  let out = '';
  // randomInt (CSPRNG) rather than Math.random: Math.random is predictable
  // enough that someone observing a few codes could guess the next one, and
  // this code is a credential — it links a Telegram account to a real user.
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * Dashboard-only (JWT). Issues a fresh one-time code for the logged-in user.
 * Being logged into the dashboard IS the proof of identity — that's the whole
 * point of the flow.
 */
telegramRouter.post('/link-code', requireAuth, async (req, res) => {
  // One live code per user: a new request invalidates the previous one, so a
  // code glimpsed over someone's shoulder stops working the moment you
  // generate another.
  await db.delete(linkCodes).where(eq(linkCodes.userId, req.userId!));

  const code = generateCode();
  const expiresAt = new Date(Date.now() + env.linkCodeTtlSeconds * 1000);
  await db.insert(linkCodes).values({ code, userId: req.userId!, expiresAt });

  res.status(201).json({
    code,
    expiresAt: expiresAt.toISOString(),
    deepLink: env.telegramBotUsername
      ? `https://t.me/${env.telegramBotUsername}?start=${code}`
      : '',
  });
});

const linkSchema = z.object({
  code: z.string().min(4).max(16),
  chatId: z.string().min(1),
});

/**
 * Bot-only. Redeems a code and attaches the chat id to the user.
 *
 * Deliberately NOT using requireAuth: that middleware resolves a user FROM an
 * already-linked chat id, and this is the endpoint that does the linking —
 * there is nothing to resolve yet. So it checks the bot secret directly.
 */
telegramRouter.post('/link', async (req, res) => {
  const botSecret = req.headers['x-bot-secret'];
  if (typeof botSecret !== 'string' || !secretMatches(botSecret, env.botServiceSecret)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body' });
    return;
  }
  const { code, chatId } = parsed.data;

  const [record] = await db
    .select()
    .from(linkCodes)
    .where(eq(linkCodes.code, code.toUpperCase()));

  // Expiry is checked here, on every read. Expired rows are only deleted
  // periodically by the worker's sweep, so "the row exists" never means "the
  // code is valid".
  if (!record || record.expiresAt.getTime() < Date.now()) {
    res.status(404).json({ error: 'That code is invalid or has expired' });
    return;
  }

  // A chat id can only ever belong to one account. Checked up front for a
  // clear message; the UNIQUE constraint on telegram_chat_id is what actually
  // guarantees it, even if two requests race past this check.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.telegramChatId, chatId));
  if (existing && existing.id !== record.userId) {
    res.status(409).json({ error: 'This Telegram account is already linked elsewhere' });
    return;
  }

  let user;
  try {
    // A TRANSACTION: both statements take effect, or neither does. Without
    // it, a crash between them could link the account but leave the code
    // usable, or burn the code without linking anything.
    user = await db.transaction(async (tx) => {
      const [linked] = await tx
        .update(users)
        .set({ telegramChatId: chatId, updatedAt: new Date() })
        .where(eq(users.id, record.userId))
        .returning();
      // Single-use: burn it in the same transaction as the link.
      await tx.delete(linkCodes).where(eq(linkCodes.id, record.id));
      return linked;
    });
  } catch (err) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      res.status(409).json({ error: 'This Telegram account is already linked elsewhere' });
      return;
    }
    throw err;
  }
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json(toUser(user));
});

/** Dashboard-only. Disconnects Telegram without touching anything else. */
telegramRouter.post('/unlink', requireAuth, async (req, res) => {
  // Setting the column to NULL is "not linked". Mongo needed $unset to
  // remove the field; in SQL every row has every column, so it's emptied.
  const [user] = await db
    .update(users)
    .set({ telegramChatId: null, updatedAt: new Date() })
    .where(eq(users.id, req.userId!))
    .returning();
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(toUser(user));
});
