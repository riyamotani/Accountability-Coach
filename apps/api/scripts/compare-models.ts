/**
 * Compare candidate models on the REAL reminder prompt, under the REAL
 * production limits, and report what each one actually costs.
 *
 *   cd apps/api
 *   npx tsx scripts/compare-models.ts
 *
 * Why this exists instead of just picking the cheapest model from a price
 * list: a price list can't tell you whether a model is general-purpose or
 * specialised (translation, safety classification), and list price times an
 * ASSUMED token count isn't the bill. Reasoning models spend hidden "thinking"
 * tokens that are billed as output and count against the output cap — they can
 * cost several times their estimate, or return nothing at all.
 *
 * This makes real API calls. The whole run costs a fraction of a cent.
 */
import { createGateway, generateText } from 'ai';
import { env } from '../src/lib/env.js';
import {
  buildPrompt,
  MAX_MESSAGE_LENGTH,
  MAX_OUTPUT_TOKENS,
  REQUEST_TIMEOUT_MS,
  type ReminderContext,
} from '../src/lib/ai.js';

// Only models available on the Gateway's free tier — anything else fails with
// "Free tier users do not have access to this model".
const CANDIDATES = [
  'mistral/ministral-14b', // current default — the baseline to beat
  'anthropic/claude-3-haiku',
];

/**
 * Three situations that stress the prompt differently. The mixed one is the
 * real test: the rules say "never invent a streak" — a model that
 * congratulates a streak that doesn't exist fails, however cheap it is.
 */
const SCENARIOS: { label: string; ctx: ReminderContext }[] = [
  {
    label: 'new goal, no history',
    ctx: { goalTitle: 'study', recentHistory: [] },
  },
  {
    label: 'strong week',
    ctx: {
      goalTitle: 'jogging',
      target: 30,
      targetUnit: 'minutes',
      recentHistory: [
        { date: '2026-09-08', status: 'done' },
        { date: '2026-09-09', status: 'done' },
        { date: '2026-09-10', status: 'done' },
        { date: '2026-09-11', status: 'done' },
        { date: '2026-09-12', status: 'done' },
      ],
    },
  },
  {
    label: 'mixed / slipping',
    ctx: {
      goalTitle: 'study',
      recentHistory: [
        { date: '2026-09-08', status: 'done' },
        { date: '2026-09-09', status: 'skipped' },
        { date: '2026-09-10', status: 'skipped' },
        { date: '2026-09-12', status: 'done' },
      ],
    },
  },
];

interface Pricing {
  input: number;
  output: number;
}

/** Live per-token prices from the Gateway's public catalog. */
async function fetchPricing(): Promise<Map<string, Pricing>> {
  const res = await fetch('https://ai-gateway.vercel.sh/v1/models');
  const body = (await res.json()) as {
    data: { id: string; pricing?: { input?: string; output?: string } }[];
  };
  const map = new Map<string, Pricing>();
  for (const m of body.data) {
    if (m.pricing?.input && m.pricing.output) {
      map.set(m.id, { input: Number(m.pricing.input), output: Number(m.pricing.output) });
    }
  }
  return map;
}

async function main() {
  if (!env.aiGatewayApiKey) throw new Error('AI_GATEWAY_API_KEY is not set in .env');

  const gateway = createGateway({ apiKey: env.aiGatewayApiKey });
  const pricing = await fetchPricing();

  for (const model of CANDIDATES) {
    console.log(`\n━━━ ${model} ━━━`);
    const price = pricing.get(model);
    let totalCost = 0;

    for (const { label, ctx } of SCENARIOS) {
      const started = Date.now();
      try {
        const { text, usage } = await generateText({
          model: gateway(model),
          prompt: buildPrompt(ctx),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          timeout: REQUEST_TIMEOUT_MS,
          maxRetries: 0,
        });

        const ms = Date.now() - started;
        const message = text.trim();
        const cost = price
          ? (usage.inputTokens ?? 0) * price.input + (usage.outputTokens ?? 0) * price.output
          : 0;
        totalCost += cost;

        // Mirror the production acceptance rules, so a model that "works"
        // here but would silently fall back to the template in real use is
        // flagged rather than looking fine.
        const verdict = !message
          ? '❌ EMPTY — production would fall back to template'
          : message.length > MAX_MESSAGE_LENGTH
            ? `❌ TOO LONG (${message.length} chars) — production would fall back`
            : `✅ ${message.length} chars`;

        console.log(`\n  [${label}]  ${ms}ms · ${verdict}`);
        console.log(`  "${message}"`);
        console.log(
          `  tokens in/out: ${usage.inputTokens}/${usage.outputTokens}` +
            `  details: ${JSON.stringify(usage.outputTokenDetails)}` +
            `  cost: $${cost.toFixed(7)}`,
        );
      } catch (err) {
        console.log(`\n  [${label}]  ❌ ERROR: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log(`\n  total for 3 calls: $${totalCost.toFixed(7)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
