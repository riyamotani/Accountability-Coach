import { createGateway, generateText } from 'ai';
import type { CheckInStatus } from '@coach/shared';
import { env } from './env.js';

/**
 * The AI layer, kept deliberately thin: fetch context -> build a prompt ->
 * call the model -> parse. No framework, no agent loop — that machinery is
 * reserved for the negotiation feature later, where the model actually needs
 * to decide what to do next. Here it only ever writes one sentence.
 *
 * ROUTING: Vercel AI SDK + Vercel AI Gateway. The SDK is just a library
 * (free, like any SDK); the Gateway is what routes the request to Anthropic
 * and bills it, with a recurring free monthly credit. The model underneath is
 * still Claude Haiku — only the path to it changed. Nothing outside this file
 * imports `ai`, so swapping providers again is a one-file change.
 *
 * THE RULE THIS WHOLE FILE IS BUILT AROUND: a reminder that already works
 * (the plain templated version from the scheduler) must NEVER break because
 * this got fancier. Every failure mode below — no key, a slow response, a
 * network error, an empty reply — returns `null`, and the caller falls back
 * to the exact same static text that shipped before this file existed.
 */

export interface CheckInHistoryEntry {
  date: string;
  status: CheckInStatus;
}

export interface ReminderContext {
  goalTitle: string;
  // `| undefined` alongside `?:` — Mongoose types an optional field as
  // `T | null | undefined`, and exactOptionalPropertyTypes distinguishes
  // "key absent" from "key present with value undefined". Passing
  // goal.target straight through needs both spellings accepted.
  target?: number | null | undefined;
  targetUnit?: string | null | undefined;
  /** Last ~7 days, oldest first. Empty is fine — a brand new goal has none. */
  recentHistory: CheckInHistoryEntry[];
}

// Exported so scripts/compare-models.ts tests candidates under exactly these
// production limits, not friendlier ones.

// A network call inside a job handler needs its own ceiling. If this fires,
// the job falls back to the template rather than delaying the reminder.
export const REQUEST_TIMEOUT_MS = 5000;
export const MAX_OUTPUT_TOKENS = 120;
// A second, cheap guard AFTER the response. maxOutputTokens bounds what the
// model CAN write; this bounds what we're willing to send — a Telegram nudge
// is one line, not an essay.
export const MAX_MESSAGE_LENGTH = 220;

export function buildPrompt(ctx: ReminderContext): string {
  const target =
    ctx.target && ctx.targetUnit ? `Target: ${ctx.target} ${ctx.targetUnit}.` : '';

  const history =
    ctx.recentHistory.length === 0
      ? 'No check-in history yet — this may be a new goal.'
      : ctx.recentHistory.map((h) => `${h.date}: ${h.status}`).join('\n');

  return [
    `You are a supportive accountability coach sending a short reminder`,
    `for the goal "${ctx.goalTitle}". ${target}`,
    ``,
    `Recent check-ins:`,
    history,
    ``,
    `Write ONE short, warm sentence encouraging them to do it now. Rules:`,
    `- Use ONLY the facts given above. Never invent a streak, a number, or a`,
    `  detail not present in the data.`,
    `- No greeting, no sign-off, no markdown, no emoji — plain text only,`,
    `  the header already has one.`,
    `- If history is empty or mixed, keep it neutral and forward-looking`,
    `  rather than congratulating a streak that may not exist.`,
    `- Under 160 characters.`,
  ].join('\n');
}

// Built lazily, and only once a key is known to exist — so a missing key
// never reaches the provider's own validation at all.
let gateway: ReturnType<typeof createGateway> | null = null;

export async function generateReminderMessage(ctx: ReminderContext): Promise<string | null> {
  // Fail closed with zero network activity when no key is configured. This is
  // the current, temporary, pre-BYO-key state (see CLAUDE.md): the caller just
  // gets its plain template, silently.
  if (!env.aiGatewayApiKey) return null;

  gateway ??= createGateway({ apiKey: env.aiGatewayApiKey });

  try {
    const { text } = await generateText({
      model: gateway(env.aiModel),
      prompt: buildPrompt(ctx),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeout: REQUEST_TIMEOUT_MS,
      // The job itself already retries with backoff (RETRY_OPTS). Letting the
      // SDK retry too would stack two retry layers on a call that has a
      // perfectly good fallback — fail fast and use the template instead.
      maxRetries: 0,
    });

    const message = text.trim();
    if (!message || message.length > MAX_MESSAGE_LENGTH) return null;
    return message;
  } catch (err) {
    // Never let an AI hiccup become a broken reminder. Log for visibility,
    // return "no personalized line", let the template carry the message.
    console.error(
      '[ai] reminder generation failed, falling back to template:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
