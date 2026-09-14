import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../lib/jwt.js';
import { env } from '../lib/env.js';
import { UserModel } from '../models/User.js';

/**
 * Teach TypeScript that an authenticated request carries a userId. Express's
 * own Request type knows nothing about our app, so we widen it here rather
 * than casting to `any` at every call site.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/** Constant-time compare, so a wrong secret can't be guessed byte-by-byte. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Turns a credential into `req.userId`, or rejects with 401.
 *
 * TWO kinds of client can authenticate here, and understanding why is the
 * whole point of this design:
 *
 * 1. A BROWSER (the dashboard) sends `Authorization: Bearer <jwt>`. The JWT
 *    identifies the user directly.
 *
 * 2. The TELEGRAM BOT sends `X-Bot-Secret` plus `X-Telegram-Chat-Id`. The bot
 *    is not a third-party app or a user's device — it's our own backend
 *    process, deployed alongside this API. That makes it a trusted
 *    first-party service, and the standard pattern for those is a shared
 *    secret rather than storing a token per user (which would mean the bot
 *    holds N credentials to expire and refresh instead of 1).
 *
 *    The chat id is safe to trust as an identity claim because it comes from
 *    TELEGRAM's servers, not from anything the user typed — a user cannot
 *    claim someone else's chat id without compromising the bot process.
 *
 * Accepting both here (rather than building a parallel /bot/* route tree) is
 * what lets /goals and /checkins serve the dashboard and the bot unchanged.
 *
 * This is AUTHENTICATION only — "who are you?". Authorization ("may you touch
 * this goal?") stays in each route as an `ownerId` filter on the query.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;

  if (header?.startsWith('Bearer ')) {
    try {
      const payload = await verifyToken(header.slice('Bearer '.length), env.jwtSecret);
      req.userId = payload.sub;
      next();
      return;
    } catch {
      // Never echo the reason ("bad signature" vs "expired") — it tells an
      // attacker which half of their guess was right.
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }
  }

  const botSecret = req.headers['x-bot-secret'];
  const chatId = req.headers['x-telegram-chat-id'];

  if (typeof botSecret === 'string' && secretMatches(botSecret, env.botServiceSecret)) {
    if (typeof chatId !== 'string') {
      res.status(400).json({ error: 'Missing X-Telegram-Chat-Id' });
      return;
    }

    const user = await UserModel.findOne({ telegramChatId: chatId });
    if (!user) {
      // Distinct from 401 on purpose: the BOT authenticated fine, it's the
      // end user who hasn't linked an account yet. The bot turns this into
      // "send /start to connect" rather than a generic failure.
      res.status(403).json({ error: 'Telegram account not linked' });
      return;
    }

    req.userId = user._id.toString();
    next();
    return;
  }

  res.status(401).json({ error: 'Missing or invalid credentials' });
}
