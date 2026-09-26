import { Router } from 'express';
import { z } from 'zod';
import { createGateway, generateText, stepCountIs } from 'ai';
import { formatLocalDate, localDateInZone } from '@coach/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { describeError } from '../db/errors.js';
import { buildAssistantTools, findLivePendingAction } from '../lib/assistant-tools.js';
import { getMemoryStore } from '../lib/memory/index.js';
import { loadRecentTurns, saveTurn } from '../lib/conversation.js';
import { touchUserActivity } from '../lib/engagement.js';
import { findOpenNegotiation } from '../lib/negotiation/state.js';
import { requireAuth } from '../middleware/auth.js';
import { env } from '../lib/env.js';

export const assistantRouter = Router();

assistantRouter.use(requireAuth);

const askSchema = z.object({ message: z.string().min(1).max(1000) });

// Same reasoning as the reminder timeout in lib/ai.ts, just a wider budget:
// this can take a few tool-calling round trips, but a request handler still
// needs a ceiling.
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Model calls allowed per message, including every tool round trip.
 *
 * Each step is a separate request to the provider, and the free tier allows
 * 5 per MINUTE for the whole account — so a 6-step message could exhaust the
 * budget on its own, and two tool-using messages in a row certainly did.
 *
 * Four covers the realistic paths: read a tool, maybe a second, then answer.
 * Relevant memories are already in the context before the model runs, which
 * removed the most common reason for an extra round trip.
 *
 * The honest cost: a genuinely complex request (look up goals, draft a
 * change, check the schedule) can now run out of steps and give a vaguer
 * answer. That is a better failure than a rate-limit wall.
 */
const MAX_STEPS = 4;
const MAX_REPLY_LENGTH = 800;

/**
 * How many past notes to put in the context before the model runs. Small on
 * purpose: these are added to EVERY message, and a context full of
 * half-relevant history makes the model drag old topics into new
 * conversations.
 */
const PRELOADED_MEMORIES = 3;

/**
 * Shorter than this and a message is almost certainly not a fact worth
 * keeping ("ok", "9pm", "yes do it"). Long enough to be a sentence is a crude
 * but surprisingly effective test.
 */
const MIN_AUTOSAVE_LENGTH = 25;

/** Replies that are pure acknowledgement, whatever their length. */
const ACKNOWLEDGEMENT = /^(y(es|eah|ep|up)?|no(pe)?|ok(ay)?|sure|thanks|ty|cool|great|nice|done|got it|go ahead|sounds good)\b/i;

/**
 * Is there anything here worth searching memory for? "yes", "ok", "9pm" and
 * "do it" carry no topic — embedding them spends a request and returns the
 * nearest rows to nothing in particular.
 */
function isSearchableMessage(message: string): boolean {
  const text = message.trim();
  return text.length >= 12 && !ACKNOWLEDGEMENT.test(text);
}

/**
 * Should this message be remembered without the model being asked?
 *
 * The model has a `rememberNote` tool and keeps forgetting to use it — it
 * didn't save "I've fixed my sleep, mornings feel great", which is exactly
 * the kind of fact the memory layer exists for. Same lesson as stripping
 * Markdown and formatting dates: if something must happen, our code does it;
 * the model is left the parts where judgment actually helps.
 *
 * Deliberately crude. A cleverer filter would need another model call per
 * message, which costs latency and a rate-limit slot to decide whether to
 * store one sentence. Storing a bit too much is cheap: a weak memory simply
 * loses the similarity contest at retrieval time.
 */
function shouldAutoRemember(message: string): boolean {
  const text = message.trim();
  if (text.length < MIN_AUTOSAVE_LENGTH) return false;
  if (text.startsWith('/')) return false; // a command, not a statement
  if (ACKNOWLEDGEMENT.test(text) && text.length < 40) return false;
  // Questions are what memory is SEARCHED with, not what it should contain.
  // Storing "why do I keep missing gym?" means future searches match the
  // user's own past questions instead of the answers. A long question often
  // carries context too ("...when work has been this crazy?"), so only short
  // ones are dropped outright.
  if (text.endsWith('?') && text.length < 80) return false;
  return true;
}

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

/**
 * Same idea as stripMarkdown: the instructions ask for friendly dates, and
 * this guarantees it. Tool results hand the model YYYY-MM-DD, and small
 * models tend to echo them straight back.
 */
export function humanizeDates(text: string): string {
  // formatLocalDate returns null for an impossible date ("2026-13-45"): leave
  // those exactly as the model wrote them.
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (iso) => formatLocalDate(iso) ?? iso);
}

/**
 * Seconds to wait if this error is a provider rate limit, otherwise undefined.
 *
 * The free tier allows 5 model requests per MINUTE, and one chat message can
 * easily use several: every tool call is another round trip (ask → run tool →
 * ask again → answer). A few quick messages in a row will hit it.
 */
function rateLimitRetrySeconds(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { statusCode, responseHeaders } = err as {
    statusCode?: number;
    responseHeaders?: Record<string, string>;
  };
  // Checked on the error itself and on its cause: the Gateway wraps the
  // provider's error, and the headers live on the inner one.
  const cause = (err as { cause?: unknown }).cause;
  if (statusCode !== 429) return cause ? rateLimitRetrySeconds(cause) : undefined;

  const header = responseHeaders?.['retry-after'];
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) ? Math.ceil(seconds) : 30;
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

  // Any message is a sign of life: if the bot had gone quiet after a week of
  // silence, this is what brings the reminders back. Not awaited — waking up
  // is bookkeeping, and must never fail someone's message.
  void touchUserActivity(user.id);

  // Only a draft that hasn't expired counts. An expired one is invisible
  // here and unconfirmable in the tools, even before the sweep deletes it.
  const pending = await findLivePendingAction(user.id);

  /**
   * RETRIEVE BEFORE THE MODEL RUNS, rather than leaving recall to the
   * recallNotes tool alone.
   *
   * Two things were learned the hard way here. First, a small model often
   * doesn't call the tool at all: asked about "work deadlines" it checked
   * goals and check-ins twice and never looked at the notes, though a note
   * about work deadlines existed. Second, when it does call it, the model
   * writes its OWN search phrase — "reasons for struggling" scored 0.239
   * where the user's actual words scored 0.333, which was the difference
   * between finding the notes and finding nothing.
   *
   * Searching with the user's real message avoids both. The tool stays, for
   * follow-up digging the message itself wouldn't find. One embedding call
   * per message (~$0.000001), and a failure here must never break the chat —
   * an assistant with no memory is still a working assistant.
   */
  const negotiation = await findOpenNegotiation(user.id);

  let recalled: Awaited<ReturnType<ReturnType<typeof getMemoryStore>['search']>> = [];
  let history: Awaited<ReturnType<typeof loadRecentTurns>> = [];
  try {
    // Both lookups at once: neither depends on the other, and this is in the
    // path of every single message.
    //
    // The memory search is skipped for messages with nothing to search FOR
    // ("yes", "ok", "9pm"): embedding them costs a request and returns
    // whatever happens to be nearest to a word with no content. The previous
    // turns still carry the context those replies depend on.
    [recalled, history] = await Promise.all([
      isSearchableMessage(parsed.data.message)
        ? getMemoryStore().search({
            userId: user.id,
            query: parsed.data.message,
            limit: PRELOADED_MEMORIES,
          })
        : Promise.resolve([]),
      loadRecentTurns(user.id),
    ]);
  } catch (err) {
    // describeError, not err.message: a failed query's message includes its
    // PARAMETERS, which here are the user's own words. Logs travel further
    // than databases do.
    console.error('[assistant] context load failed (continuing without it):', describeError(err));
  }

  // The model has no innate sense of "today" or who it's talking to — both
  // have to be handed in explicitly, or "in 10 days" and "confirm that" have
  // nothing to resolve against.
  const today = localDateInZone(user.timezone);
  const context = [
    // The weekday is included so "on Tuesday" or "this weekend" can be
    // resolved without the model doing calendar arithmetic from a bare date.
    `Today is ${formatLocalDate(today)} (${today}), timezone ${user.timezone}.`,
    `The user's name is ${user.displayName}.`,
    pending
      ? `There is a PENDING, unconfirmed draft: ${JSON.stringify(pending.kind)} — ${JSON.stringify(pending.payload)}. If the user's message confirms it, call confirmPendingAction. If they reject or change their mind, call cancelPendingAction.`
      : 'There is no pending draft right now.',
    // An OPEN negotiation is loaded by state, not by which message the user
    // replied to — so "yeah ok" works two days and several reminders later,
    // which is how people actually answer.
    negotiation
      ? [
          `YOU ALREADY PROPOSED a change to the goal "${negotiation.goalTitle}" ` +
            `(round ${negotiation.round}) and they have not answered yet:`,
          JSON.stringify(negotiation.proposal),
          'If this message agrees → acceptNegotiation. If they want different terms →',
          'counterNegotiation. If they want no change at all → declineNegotiation.',
          'If the message is about something else entirely, just answer that and leave the',
          'proposal open.',
        ].join('\n')
      : 'There is no open goal negotiation.',
    // Dated, because "you mentioned this in August" and "you said this
    // yesterday" call for very different responses. Marked as possibly
    // irrelevant so a weak match doesn't get forced into the answer.
    recalled.length > 0
      ? [
          'Things this user told you earlier, most relevant to their message first.',
          'Use them only if they genuinely fit; ignore them otherwise:',
          ...recalled.map(
            (memory) =>
              `- "${memory.content}" (said ${formatLocalDate(localDateInZone(user.timezone, memory.createdAt))})`,
          ),
        ].join('\n')
      : 'Nothing they told you earlier looks related to this message.',
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
        '- If the user asks you to change something, call the matching propose* tool.',
        '  NEVER claim something is done unless a confirmPendingAction or a propose*',
        '  tool result says so.',
        '',
        'Changing things (all of this works here in chat — never tell them to use a website):',
        '- New goal: proposeGoal. Ask for whatever is missing first — what, which days,',
        '  what time. Suggest a sensible time if they have no preference.',
        '- Change one: proposeGoalUpdate. Stop reminders for one: proposeGoalArchive',
        '  (keeps history). proposeGoalDelete only if they clearly want it erased.',
        '- Their normal day (work hours, sleep, class): proposeScheduleBlock, plus',
        '  proposeScheduleBlockUpdate / proposeScheduleBlockDelete. Knowing their day is',
        '  what lets reminders avoid bad moments, so it is worth asking about.',
        '- Going away: proposePauseWindow. Logging progress: proposeCheckIn.',
        '- Keep replies short — a few sentences at most, plain text, no markdown.',
        '',
        'Memory:',
        '- When they share something personal that explains their situation (stress, an',
        '  injury, a busy month, what does or does not work for them), call rememberNote',
        '  with their own words. Do it quietly, as part of replying.',
        '- Anything relevant they told you before is already in the context above.',
        '  Use it naturally ("you mentioned deadlines this month"), never as a list.',
        '- Never call rememberNote for something already shown there — it is saved.',
        '  Only save what is NEW in their latest message.',
        '- Call recallNotes only to search for something MORE specific than their last',
        '  message, e.g. one topic they raised. If nothing relevant is found or shown,',
        '  say you are not sure rather than guessing a reason.',
      ].join('\n'),
      // `messages` rather than `prompt`: the earlier turns come first, then
      // what they just said. This is what makes "actually make it 10pm"
      // resolvable — "it" is in the message above.
      messages: [...history, { role: 'user', content: parsed.data.message }],
      tools: buildAssistantTools(user.id, user.timezone, {
        hasOpenNegotiation: Boolean(negotiation),
      }),
      stopWhen: stepCountIs(MAX_STEPS),
      timeout: REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    });

    // WHICH tools the model chose is the single most useful thing to see when
    // an answer looks wrong: "it never called recallNotes" and "it called it
    // and got nothing back" look identical from the outside, and have
    // completely different fixes. Names and result sizes only — the contents
    // are the user's private notes and don't belong in a log.
    const toolCalls = result.steps.flatMap((step) =>
      step.toolCalls.map((call) => {
        const output = step.toolResults.find((r) => r.toolCallId === call.toolCallId)?.output as
          | { found?: number; drafted?: boolean; committed?: boolean; saved?: boolean }
          | undefined;
        const outcome =
          output?.found !== undefined
            ? `found ${output.found}`
            : Object.entries(output ?? {})
                .filter(([, v]) => typeof v === 'boolean')
                .map(([k, v]) => `${k}=${v}`)
                .join(' ');
        return outcome ? `${call.toolName}(${outcome})` : call.toolName;
      }),
    );
    console.log(
      `[assistant] ${negotiation ? `negotiation open (round ${negotiation.round}) | ` : ''}` +
        `${history.length} prior turn(s) | preloaded ${recalled.length} memor(ies)` +
        (recalled[0] ? ` (top ${recalled[0].score.toFixed(3)})` : '') +
        ` | ${toolCalls.length ? toolCalls.join(' → ') : 'no tools called'}`,
    );

    const reply = humanizeDates(stripMarkdown(result.text)).trim().slice(0, MAX_REPLY_LENGTH);

    // Stored only when there IS a reply: a half-exchange in the history would
    // read, next turn, as though the bot had ignored the user. Not awaited —
    // the reply must not wait on bookkeeping — but errors are logged.
    if (reply) {
      void saveTurn(user.id, parsed.data.message, reply).catch((err: unknown) =>
        console.error('[assistant] could not save the turn:', describeError(err)),
      );
    }

    // Auto-remember, unless the model already saved something this turn —
    // it may well have saved a tidier version of the same thing, and the
    // store's echo guard only catches EXACT repeats.
    const modelSaved = toolCalls.some((call) => call.startsWith('rememberNote'));
    if (!modelSaved && shouldAutoRemember(parsed.data.message)) {
      void getMemoryStore()
        .add({ userId: user.id, content: parsed.data.message, source: 'chat' })
        .then(() => console.log('[memory] auto-saved this message'))
        .catch((err: unknown) =>
          console.error('[memory] auto-save failed:', describeError(err)),
        );
    }

    res.json({ reply: reply || "Sorry, I didn't quite catch that — could you try again?" });
  } catch (err) {
    console.error('[assistant] failed:', describeError(err));

    // A rate limit is a WAIT, not a failure, and it deserves its own message:
    // "something went wrong" invites the user to rephrase and try immediately,
    // which only burns another request. The provider tells us how long.
    //
    // Note a draft is untouched by this — it stays pending for 15 minutes, so
    // "yes" a minute later still confirms what was proposed.
    const retryAfter = rateLimitRetrySeconds(err);
    if (retryAfter !== undefined) {
      res.status(429).json({
        error: `I'm being rate-limited right now — give me about ${retryAfter}s and say that again.`,
      });
      return;
    }

    res.status(502).json({ error: 'The assistant had trouble responding. Try again in a moment.' });
  }
});
