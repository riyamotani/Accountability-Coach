import { createGateway, generateObject } from 'ai';
import { z } from 'zod';
import { formatTimeOfDay } from '@coach/shared';
import { env } from '../env.js';
import { providerOptionsFor } from '../model-options.js';
import type { SlippingGoal } from './trigger.js';

/**
 * The bot's turn: read the evidence, decide what to propose, and say it.
 *
 * This is the AGENTIC half of the loop. The trigger decided there is
 * something to talk about; what to suggest is judgment, and judgment is what
 * the model is for. It gets the raw per-day record — not a summary — so it
 * can say "weekends never happen and you average 12 of 30 minutes" rather
 * than "you've been missing this".
 *
 * generateObject rather than generateText: the reply has to contain both a
 * MESSAGE for the user and a machine-readable CHANGE we can apply if they
 * agree. Parsing a change back out of prose would be guesswork; asking for a
 * typed object makes the model fill in fields the code can act on.
 */

const REQUEST_TIMEOUT_MS = 20000;
const MAX_MESSAGE_LENGTH = 600;

/**
 * What the bot may propose. Deliberately narrow: fewer days, a different
 * time, or a smaller target. Each maps onto a field the goal already has, so
 * accepting is an UPDATE we already know how to do — no new write path, and
 * nothing the model can invent that the app can't honour.
 */
export const proposalSchema = z.object({
  kind: z
    .enum(['fewerDays', 'differentTime', 'smallerTarget', 'combination'])
    .describe('The main shape of the change'),
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1)
    .max(7)
    .optional()
    .describe('New days, 0=Sunday. Omit to keep the current days.'),
  timeOfDay: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional()
    .describe('New time, 24-hour HH:mm. Omit to keep the current time.'),
  target: z.number().min(0).optional().describe('New numeric target. Omit to keep it.'),
  rationale: z.string().max(300).describe('Why this change, in one sentence, for our logs'),
  message: z
    .string()
    .max(MAX_MESSAGE_LENGTH)
    .describe(
      'The Telegram message to send. Warm, specific, names the real numbers, ends with a ' +
        'question. Plain text, no markdown.',
    ),
});

export type Proposal = z.infer<typeof proposalSchema>;

let gateway: ReturnType<typeof createGateway> | null = null;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function describeEvidence({ goal, evidence }: SlippingGoal): string {
  const lines = [
    `Goal: "${goal.title}"`,
    `Currently: ${goal.daysOfWeek.map((d) => DAY_NAMES[d]).join(', ')} at ${formatTimeOfDay(goal.timeOfDay)}`,
    goal.target != null ? `Target each time: ${goal.target} ${goal.targetUnit ?? ''}`.trim() : '',
    // Their own reason. A proposal that keeps the PURPOSE intact ("still
    // ready for the March interviews, just 3 days a week") is far easier to
    // say yes to than one that only shrinks the numbers.
    goal.description ? `Why they set this goal: "${goal.description.slice(0, 300)}"` : '',
    '',
    `Last ${evidence.due} due occurrences (${evidence.windowFrom} to ${evidence.windowTo}):`,
    ...evidence.occurrences.map((o) => {
      const parts = [`  ${o.date} (${DAY_NAMES[new Date(`${o.date}T00:00:00Z`).getUTCDay()]}): ${o.status}`];
      if (o.value != null) parts.push(`logged ${o.value}`);
      if (o.note) parts.push(`note: "${o.note}"`);
      return parts.join(' — ');
    }),
    '',
    `Done ${evidence.counts.done}, partial ${evidence.counts.partial}, ` +
      `skipped ${evidence.counts.skipped}, missed entirely ${evidence.counts.missed}.`,
    evidence.averageValue != null
      ? `When they logged an amount it averaged ${evidence.averageValue.toFixed(1)}` +
        (goal.target != null ? ` against a target of ${goal.target}.` : '.')
      : '',
    evidence.weakDays.length
      ? `Weakest days: ${evidence.weakDays.map((d) => DAY_NAMES[d]).join(', ')}.`
      : '',
    evidence.pausedDays > 0
      ? `${evidence.pausedDays} day(s) were excluded because they were paused.`
      : '',
  ];
  return lines.filter(Boolean).join('\n');
}

export async function composeProposal(
  slipping: SlippingGoal,
  memories: string[],
): Promise<Proposal | null> {
  if (!env.aiGatewayApiKey) return null;
  gateway ??= createGateway({ apiKey: env.aiGatewayApiKey });

  try {
    const providerOptions = providerOptionsFor(env.aiAssistantModel);
    const { object } = await generateObject({
      // Judgment, not just wording: what change fits the evidence. Same
      // model as the assistant, for the same reason.
      model: gateway(env.aiAssistantModel),
      ...(providerOptions ? { providerOptions } : {}),
      schema: proposalSchema,
      system: [
        `You are a warm, practical accountability coach talking to ${slipping.user.displayName}`,
        'over Telegram. A goal of theirs is not working, and your job is to propose ONE',
        'concrete, smaller change that makes it achievable — then ask if they agree.',
        '',
        'Rules:',
        '- Lead with what the numbers actually show. Be specific: days, counts, amounts.',
        '- Propose a change that fits the evidence. If weekends are always missed, drop',
        '  weekends. If they average a third of the target, cut the target. If they skip',
        '  early mornings, move it later.',
        '- Suggest something EASIER, never harder. The goal is to restart momentum.',
        '- No blame, no guilt, no lecture. Missing things is normal and you are on their side.',
        '- End with a clear question they can answer with yes, no, or a counter-offer.',
        '- Keep it under 5 sentences. Plain text, no markdown, at most one emoji.',
        '- Never invent facts. Only use what is given below.',
      ].join('\n'),
      prompt: [
        describeEvidence(slipping),
        memories.length
          ? `\nThings they have told you that may explain it:\n${memories.map((m) => `- "${m}"`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    return object;
  } catch (err) {
    // A failed proposal is not worth retrying loudly: the goal will still be
    // slipping tomorrow, and the sweep will try again. Better a quiet day
    // than a half-formed message.
    console.error(
      `[negotiation] could not compose a proposal for "${slipping.goal.title}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
