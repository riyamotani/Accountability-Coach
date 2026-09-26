import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { goals, users } from '../src/db/schema.js';
import {
  findSlippingGoals,
  gatherEvidence,
  hasRecentEngagement,
  TRIGGER_RULE,
} from '../src/lib/negotiation/trigger.js';

/**
 * Dev tool: show what the negotiation trigger sees, for every active goal.
 *
 *   npx tsx scripts/negotiation-check.ts
 *
 * Read-only, no AI, no messages sent. The point is to check the RULE against
 * real data before letting it start conversations — a trigger that fires on
 * a goal you're doing fine at is the fastest way to get a bot muted.
 */

console.log('Trigger rule:', TRIGGER_RULE, '\n');

const rows = await db
  .select({
    id: goals.id,
    ownerId: goals.ownerId,
    title: goals.title,
    daysOfWeek: goals.daysOfWeek,
    createdAt: goals.createdAt,
    timeOfDay: goals.timeOfDay,
    target: goals.target,
    updatedAt: goals.updatedAt,
    timezone: users.timezone,
  })
  .from(goals)
  .innerJoin(users, eq(users.id, goals.ownerId))
  .where(eq(goals.status, 'active'));

for (const row of rows) {
  const evidence = await gatherEvidence(row, row.timezone);
  const rate = `${evidence.completed}/${evidence.due}`;
  const pct = evidence.due ? `${Math.round(evidence.completionRate * 100)}%` : '—';
  const { done, partial, skipped, missed } = evidence.counts;

  console.log(`${row.title}  (days ${row.daysOfWeek.join(',')} at ${row.timeOfDay})`);
  console.log(`  window     ${evidence.windowFrom} → ${evidence.windowTo}`);
  console.log(`  due        ${evidence.due}  (${evidence.pausedDays} day(s) removed by pauses)`);
  console.log(`  completed  ${rate}  = ${pct}  (partial counts as ${TRIGGER_RULE.PARTIAL_CREDIT})`);
  console.log(`  breakdown  done ${done}, partial ${partial}, skipped ${skipped}, missed ${missed}`);
  if (evidence.averageValue != null) {
    console.log(`  average    ${evidence.averageValue.toFixed(1)} logged vs target ${row.target ?? '—'}`);
  }
  if (evidence.weakDays.length) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    console.log(`  weak days  ${evidence.weakDays.map((d) => names[d]).join(', ')}`);
  }

  // Say WHY a goal is not a candidate, not just that it isn't. "Nothing
  // happened" is the least debuggable output a rule can produce.
  const reasons: string[] = [];
  if (evidence.due < TRIGGER_RULE.MIN_DUE_OCCURRENCES) {
    reasons.push(`only ${evidence.due} due, needs ${TRIGGER_RULE.MIN_DUE_OCCURRENCES}`);
  }
  if (evidence.completionRate >= TRIGGER_RULE.COMPLETION_THRESHOLD) {
    reasons.push(`doing fine (${pct} >= ${TRIGGER_RULE.COMPLETION_THRESHOLD * 100}%)`);
  }
  const graceCutoff = new Date(Date.now() - TRIGGER_RULE.GRACE_DAYS * 24 * 60 * 60 * 1000);
  if (row.updatedAt > graceCutoff) {
    reasons.push(`changed in the last ${TRIGGER_RULE.GRACE_DAYS} days`);
  }
  if (!(await hasRecentEngagement(row.ownerId))) {
    reasons.push(`user silent for ${TRIGGER_RULE.ENGAGEMENT_WINDOW_DAYS}+ days (dormant, not failing)`);
  }

  console.log(`  verdict    ${reasons.length ? `no — ${reasons.join('; ')}` : 'CANDIDATE'}\n`);
}

// The real function, including the cooldown and the Telegram-linked check.
const slipping = await findSlippingGoals();
console.log(`findSlippingGoals() → ${slipping.length} goal(s) would start a negotiation today`);
for (const item of slipping) console.log(`  - ${item.goal.title}`);

await pool.end();
process.exit(0);
