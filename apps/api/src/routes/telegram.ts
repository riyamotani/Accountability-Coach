import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { LinkCodeModel } from '../models/LinkCode.js';
import { UserModel } from '../models/User.js';
import { env } from '../lib/env.js';
import { toUser } from '../lib/serialize.js';
import { requireAuth } from '../middleware/auth.js';

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
  await LinkCodeModel.deleteMany({ userId: req.userId });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + env.linkCodeTtlSeconds * 1000);
  await LinkCodeModel.create({ code, userId: req.userId, expiresAt });

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
  if (req.headers['x-bot-secret'] !== env.botServiceSecret) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body' });
    return;
  }
  const { code, chatId } = parsed.data;

  const record = await LinkCodeModel.findOne({ code: code.toUpperCase() });

  // Checked explicitly rather than trusting the TTL index to have removed it:
  // Mongo's TTL sweeper only runs about once a minute, so an expired document
  // can still be sitting there. The index is housekeeping, not enforcement.
  if (!record || record.expiresAt.getTime() < Date.now()) {
    res.status(404).json({ error: 'That code is invalid or has expired' });
    return;
  }

  // A chat id can only ever belong to one account. Without this, two people
  // sharing a Telegram account — or one person re-linking after switching
  // accounts — would hit the unique index as a raw 500 instead of a message.
  const existing = await UserModel.findOne({ telegramChatId: chatId });
  if (existing && existing._id.toString() !== record.userId.toString()) {
    res.status(409).json({ error: 'This Telegram account is already linked elsewhere' });
    return;
  }

  const user = await UserModel.findByIdAndUpdate(
    record.userId,
    { telegramChatId: chatId },
    { new: true },
  );
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Single-use: burn it immediately on success.
  await LinkCodeModel.deleteOne({ _id: record._id });

  res.json(toUser(user));
});

/** Dashboard-only. Disconnects Telegram without touching anything else. */
telegramRouter.post('/unlink', requireAuth, async (req, res) => {
  const user = await UserModel.findByIdAndUpdate(
    req.userId,
    { $unset: { telegramChatId: '' } },
    { new: true },
  );
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(toUser(user));
});
