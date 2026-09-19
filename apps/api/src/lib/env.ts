import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// `dotenv/config`'s default behavior reads `.env` from `process.cwd()`. In an
// npm workspace, cwd is the WORKSPACE's directory (apps/api), not the repo
// root where our single shared `.env` actually lives — so the plain import
// silently found nothing. Resolving the path relative to this file (not cwd)
// makes it work the same regardless of which directory `npm run` was invoked
// from.
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../../.env') });

/**
 * Read and validate configuration ONCE, at startup.
 *
 * The alternative — `process.env.JWT_SECRET` scattered through the codebase —
 * fails at 3am on the first request that happens to need it. Validating here
 * means a missing variable kills the process immediately on boot, where you
 * will actually see it.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  // postgresql://USER:PASSWORD@HOST:PORT/DATABASE
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS ?? 60 * 60 * 24 * 7), // 7 days
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',

  // Shared with the bot process. Treat with exactly the same care as
  // JWT_SECRET — anyone holding it can act as any user.
  botServiceSecret: required('BOT_SERVICE_SECRET'),

  // Used to build the t.me deep link the dashboard shows. Not a secret.
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME ?? '',

  linkCodeTtlSeconds: Number(process.env.LINK_CODE_TTL_SECONDS ?? 600), // 10 min

  // --- Scheduler ---
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',

  // Optional for the API server; REQUIRED for the worker, which checks it at
  // startup. The worker sends reminders with the same token the bot polls
  // with — sending from two processes is fine, only receiving conflicts.
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',

  // TESTING OVERRIDE ONLY. Unset in real use — the real delay is computed per
  // goal from its target (see followupDelayMsFor). Set this while developing
  // to force every follow-up to a short, predictable delay instead of the
  // computed one, so you don't wait hours to see the flow work.
  followupDelayMinutesOverride: process.env.FOLLOWUP_DELAY_MINUTES
    ? Number(process.env.FOLLOWUP_DELAY_MINUTES)
    : undefined,

  // --- AI layer ---

  // Vercel AI Gateway key. Optional, not required: if unset, the worker falls
  // back to a plain templated reminder rather than crash-looping on every job.
  // This is a temporary shared key — it becomes per-user and encrypted before
  // the app has real users other than its owner.
  aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY ?? '',

  // Gateway model ids are `provider/model`, and can be spelled differently
  // from the provider's own API — always copy them from the Gateway catalog.
  //
  // Ministral 14B, chosen because it is: available on the Gateway's free
  // tier (Claude Haiku 4.5 is not); NOT a reasoning model, so no hidden
  // "thinking" tokens eat the output cap or inflate the cost; zero data
  // retention and no training on prompts — which matters because prompts
  // contain users' goals and check-in history; fast (~0.4s, well inside our
  // 5s timeout); and from an established provider.
  aiModel: process.env.AI_MODEL ?? 'mistral/ministral-14b',
} as const;
