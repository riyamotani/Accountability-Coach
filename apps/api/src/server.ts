import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { env } from './lib/env.js';
import { pool } from './db/client.js';
import { describeError } from './db/errors.js';
import { authRouter } from './routes/auth.js';
import { goalsRouter } from './routes/goals.js';
import { checkInsRouter } from './routes/checkins.js';
import { scheduleRouter } from './routes/schedule.js';
import { telegramRouter } from './routes/telegram.js';
import { assistantRouter } from './routes/assistant.js';

export function createApp() {
  const app = express();

  // The browser refuses cross-origin requests unless the server opts in.
  // The dashboard is :3000 and this API is :4000 — different origins, so CORS
  // is required. The Telegram bot and the BullMQ worker are NOT browsers and
  // ignore this entirely; it exists purely for the web client.
  app.use(cors({ origin: env.webOrigin }));

  app.use(express.json({ limit: '100kb' }));

  app.get('/health', async (_req, res) => {
    // Actually asks the database, rather than trusting a cached "connected"
    // flag: a pool can hold connections to a server that has since gone away.
    const db = await pool.query('SELECT 1').then(
      () => true,
      () => false,
    );
    res.json({ ok: true, db });
  });

  app.use('/auth', authRouter);
  app.use('/goals', goalsRouter);
  app.use('/checkins', checkInsRouter);
  app.use('/schedule', scheduleRouter);
  app.use('/telegram', telegramRouter);
  app.use('/assistant', assistantRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Express 5 forwards rejected promises from async handlers here automatically
  // (Express 4 did not — it silently swallowed them into an unhandled
  // rejection). This is why the routes above can `throw` and simply not worry.
  // Four parameters is what marks this as error middleware; `_next` is unused
  // but must be present or Express treats it as a normal handler.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Some errors are already meaningful client mistakes, not server failures —
    // e.g. body-parser rejects malformed JSON with `status: 400` before our
    // route code ever runs. Passing those through as their own code (with a
    // generic message, so we don't leak parser internals) is more honest than
    // flattening every error to 500; a 500 should mean "we broke," not "you
    // sent bad input."
    const status =
      typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
        ? err.status
        : 500;

    // describeError keeps query parameters (password hashes, notes) out of
    // the log for failed database queries.
    if (status >= 500) console.error('[api] unhandled error:', describeError(err));
    res.status(status).json({ error: status < 500 ? 'Malformed request' : 'Internal server error' });
  });

  return app;
}

async function main() {
  // The pool connects lazily, on the first query. Running one now means a
  // wrong DATABASE_URL or a stopped container fails at startup, not on the
  // first user's request.
  await pool.query('SELECT 1');
  console.log('[api] postgres connected');

  createApp().listen(env.port, () => {
    console.log(`[api] listening on http://localhost:${env.port}`);
  });
}

main().catch((err) => {
  console.error('[api] failed to start:', err);
  process.exit(1);
});
