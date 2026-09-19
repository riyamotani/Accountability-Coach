import { Router } from 'express';
import { z } from 'zod';
import { createGateway, generateText, stepCountIs } from 'ai';
import { localDateInZone } from '@coach/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { buildAssistantTools, findLivePendingAction } from '../lib/assistant-tools.js';
import { requireAuth } from '../middleware/auth.js';
import { env } from '../lib/env.js';

export const assistantRouter = Router();

assistantRouter.use(requireAuth);

const askSchema = z.object({ message: z.string().min(1).max(1000) });

// Same reasoning as the reminder timeout in lib/ai.ts, just a wider budget:
// this can take a few tool-calling round trips, but a request handler still
// needs a ceiling.
const REQUEST_TIMEOUT_MS = 15000;
const MAX_STEPS = 6;
const MAX_REPLY_LENGTH = 800;

let gateway: ReturnType<typeof createGateway> | null = null;

/**
 * Removes Markdown the model wasn't supposed to write. The instructions
 * already say "plain text, no markdown", and models still slip — telling a
 * model something is a request, not a guarantee. Telegram shows `**bold**`
 * as literal asterisks, so the reply is cleaned in code, every time.
 *
 * Stripped rather than converted to real Telegram bold: that needs the
 * message's HTML mode, where every stray `<` or `&` in the text must be
 * escaped or Telegram rejects the whole message. Not worth that risk for
 * cosmetics.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1') // **bold**
    .replace(/__(.+?)__/g, '$1') // __bold__
    .replace(/(^|\W)\*(\S(?:.*?\S)?)\*(?=\W|$)/g, '$1$2') // *italic*
    .replace(/`([^`]+)`/g, '$1') // `code`
    .replace(/^#{1,6}\s+/gm, '') // # headings
    .replace(/^\s*[-*]\s+/gm, '• '); // - list items
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "2026-09-20" -> "Sun 20 Sep". Built from fixed names rather than
 * toLocaleDateString, whose output varies with the runtime's locale data
 * (some versions write "Sept").
 */
function friendlyDate(localDate: string): string {
  // Read in UTC on purpose: a LocalDate is a calendar day, not an instant,
  // so no timezone may shift it to the day before or after.
  const d = new Date(`${localDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'Invalid Date';
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * Same idea as stripMarkdown: the instructions ask for friendly dates, and
 * this guarantees it. Tool results hand the model YYYY-MM-DD, and small
 * models tend to echo them straight back.
 */
export function humanizeDates(text: string): string {
  return text.replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (iso) => {
    const formatted = friendlyDate(iso);
    // An impossible date ("2026-13-45") formats as "Invalid Date": leave it.
    return formatted === 'Invalid Date' ? iso : formatted;
  });
}

/**
 * The one route the bot's free-text handler (and, later, a dashboard chat
 * box) calls. Everything else — which tools exist, what's safe to write —
 * lives in lib/assistant-tools.ts; this route is just wiring: load context,
 * hand the model its tools, run the loop, return what it said.
 */
assistantRouter.post('/ask', async (req, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, req.userId!));
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (!env.aiGatewayApiKey) {
    res.status(503).json({ error: 'The assistant is not configured yet.' });
    return;
  }

  // Only a draft that hasn't expired counts. An expired one is invisible
  // here and unconfirmable in the tools, even before the sweep deletes it.
  const pending = await findLivePendingAction(user.id);

  // The model has no innate sense of "today" or who it's talking to — both
  // have to be handed in explicitly, or "in 10 days" and "confirm that" have
  // nothing to resolve against.
  const today = localDateInZone(user.timezone);
  const context = [
    // The weekday is included so "on Tuesday" or "this weekend" can be
    // resolved without the model doing calendar arithmetic from a bare date.
    `Today is ${friendlyDate(today)} (${today}), timezone ${user.timezone}.`,
    `The user's name is ${user.displayName}.`,
    pending
      ? `There is a PENDING, unconfirmed draft: ${JSON.stringify(pending.kind)} — ${JSON.stringify(pending.payload)}. If the user's message confirms it, call confirmPendingAction. If they reject or change their mind, call cancelPendingAction.`
      : 'There is no pending draft right now.',
  ].join('\n');

  gateway ??= createGateway({ apiKey: env.aiGatewayApiKey });

  try {
    const result = await generateText({
      model: gateway(env.aiModel),
      instructions: [
        'You are a warm, upbeat accountability coach chatting with the user over Telegram,',
        'like a friend who genuinely wants them to win.',
        context,
        '',
        'Tone:',
        '- Casual and human. Short sentences, contractions, their first name now and then.',
        '- Celebrate wins specifically. When they miss something, be kind and practical,',
        '  never guilt-tripping or preachy.',
        '- At most one emoji per message, and only when it fits.',
        '- No stock phrases like "Let me know if you need anything else" or',
        '  "I hope this helps". Just end naturally.',
        '- Write dates the way people say them: "Sat 20 Sep", "tomorrow", "Tuesday".',
        '  Never write YYYY-MM-DD in a reply (tools still take YYYY-MM-DD as input).',
        '',
        'Rules:',
        '- Use tools to answer questions about their goals, check-ins, or schedule.',
        '  Never state a number or fact you did not get from a tool.',
        '- If the user asks you to change something (pause reminders, log a check-in),',
        '  call the matching propose* tool. NEVER claim something is done unless a',
        '  confirmPendingAction or a propose* tool result says so.',
        '- Keep replies short — a few sentences at most, plain text, no markdown.',
      ].join('\n'),
      prompt: parsed.data.message,
      tools: buildAssistantTools(user.id, user.timezone),
      stopWhen: stepCountIs(MAX_STEPS),
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    });

    const reply = humanizeDates(stripMarkdown(result.text)).trim().slice(0, MAX_REPLY_LENGTH);
    res.json({ reply: reply || "Sorry, I didn't quite catch that — could you try again?" });
  } catch (err) {
    console.error('[assistant] failed:', err instanceof Error ? err.message : err);
    res.status(502).json({ error: 'The assistant had trouble responding. Try again in a moment.' });
  }
});
