import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { goals, users } from '../src/db/schema.js';
import { gatherEvidence } from '../src/lib/negotiation/trigger.js';
import { composeProposal } from '../src/lib/negotiation/propose.js';
import { createNegotiation, recordBotMessage } from '../src/lib/negotiation/state.js';
import { scheduleSilenceTimers } from '../src/queue/negotiations.js';
import { getMemoryStore } from '../src/lib/memory/index.js';
import { sendTelegramMessage } from '../src/lib/telegram.js';

/**
 * Dev tool: start a negotiation for one goal RIGHT NOW, skipping the trigger
 * rule, the cooldown, the grace period and the evening-only window.
 *
 *   npx tsx scripts/negotiation-force.ts "Read 20 pages"       # dry run
 *   npx tsx scripts/negotiation-force.ts "Read 20 pages" --send
 *
 * Why this exists: the real path needs a goal that has been failing for two
 * weeks, a user who is engaged, no recent negotiation, and the user's own
 * evening. All of that is correct for production and useless for testing on
 * a Tuesday afternoon.
 *
 * The dry run composes the proposal and prints it without writing anything
 * or messaging anyone — so the interesting part (what the model proposes
 * from the evidence) can be checked for free.
 *
 * COSTS: one AI call per run, plus one embedding for the memory lookup.
 */

const args = process.argv.slice(2);
const send = args.includes('--send');
const titleQuery = args.filter((a) => !a.startsWith('--')).join(' ').toLowerCase();

if (!titleQuery) {
  console.error('Usage: npx tsx scripts/negotiation-force.ts "<goal title>" [--send]');
  process.exit(1);
}

const rows = await db
  .select({
    id: goals.id,
    ownerId: goals.ownerId,
    title: goals.title,
    daysOfWeek: goals.daysOfWeek,
    createdAt: goals.createdAt,
    timeOfDay: goals.timeOfDay,
    target: goals.target,
    targetUnit: goals.targetUnit,
    description: goals.description,
    timezone: users.timezone,
    telegramChatId: users.telegramChatId,
    displayName: users.displayName,
  })
  .from(goals)
  .innerJoin(users, eq(users.id, goals.ownerId))
  .where(eq(goals.status, 'active'));

const row = rows.find((g) => g.title.toLowerCase().includes(titleQuery));
if (!row) {
  console.error(`No active goal matching "${titleQuery}". Available:`);
  for (const g of rows) console.error(`  - ${g.title}`);
  process.exit(1);
}
if (!row.telegramChatId) {
  console.error('That goal\'s owner has no Telegram linked.');
  process.exit(1);
}

const evidence = await gatherEvidence(row, row.timezone);
console.log(`\nGoal: ${row.title}`);
console.log(
  `Evidence: ${evidence.completed}/${evidence.due} done ` +
    `(done ${evidence.counts.done}, partial ${evidence.counts.partial}, ` +
    `skipped ${evidence.counts.skipped}, missed ${evidence.counts.missed})`,
);

const hits = await getMemoryStore()
  .search({ userId: row.ownerId, query: `struggling with ${row.title}`, limit: 3 })
  .catch(() => []);
console.log(`Memories used: ${hits.length}`);

const slipping = {
  goal: {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    daysOfWeek: row.daysOfWeek,
    timeOfDay: row.timeOfDay,
    target: row.target,
    targetUnit: row.targetUnit,
    description: row.description,
  },
  user: {
    id: row.ownerId,
    timezone: row.timezone,
    telegramChatId: row.telegramChatId,
    displayName: row.displayName,
  },
  evidence,
};

const proposal = await composeProposal(slipping, hits.map((h) => h.content));
if (!proposal) {
  console.error('The model did not produce a proposal (check AI_GATEWAY_API_KEY and the logs).');
  process.exit(1);
}

console.log('\n--- proposed change ---');
console.log(JSON.stringify({ ...proposal, message: undefined }, null, 2));
console.log('\n--- message ---');
console.log(proposal.message);

if (!send) {
  console.log('\nDry run. Nothing saved, nothing sent. Add --send to start it for real.');
  await pool.end();
  process.exit(0);
}

const created = await createNegotiation({
  goalId: row.id,
  ownerId: row.ownerId,
  proposal,
  evidence: evidence as unknown as Record<string, unknown>,
});
if (!created) {
  console.error('This goal already has an open negotiation (the partial unique index said no).');
  await pool.end();
  process.exit(1);
}

await sendTelegramMessage(row.telegramChatId, proposal.message);
await recordBotMessage(row.ownerId, proposal.message);
await scheduleSilenceTimers(created.id);

console.log(`\nSent. Negotiation ${created.id} is open — reply in Telegram.`);
await pool.end();
process.exit(0);
