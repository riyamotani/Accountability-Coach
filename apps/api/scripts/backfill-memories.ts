import { asc } from 'drizzle-orm';
import { db, pool } from '../src/db/client.js';
import { memories } from '../src/db/schema.js';
import { getSyncTarget } from '../src/lib/memory/index.js';

/**
 * Copy every stored memory into the currently configured hosted provider.
 *
 *   npx tsx scripts/backfill-memories.ts            # dry run: counts only
 *   npx tsx scripts/backfill-memories.ts --write    # actually send them
 *
 * This is the answer to the question that shaped the whole memory design:
 * "if we switch from Mem0 to Supermemory, what happens to everything saved
 * before the switch?" Because our own table keeps every raw note, the new
 * provider can simply be replayed from it — nothing is stranded in the old
 * one, and no dual-writing was needed to achieve that.
 *
 * Run it after changing MEMORY_PROVIDER, or after a provider has been down
 * long enough that its sync jobs expired.
 *
 * COSTS MONEY / QUOTA: one provider write per memory. The dry run tells you
 * how many before you commit to it.
 */

const write = process.argv.includes('--write');

/**
 * Providers rate-limit, and a backfill is the one moment we deliberately hit
 * them in bulk. A small pause between writes keeps a few hundred memories
 * from turning into a 429 storm, at the cost of the script taking a minute.
 */
const DELAY_MS = 250;

const target = getSyncTarget();
if (!target) {
  console.error(
    'No hosted provider configured. Set MEMORY_PROVIDER=mem0 and MEM0_API_KEY in .env first.',
  );
  process.exit(1);
}

// Oldest first, so the provider sees the user's history in the order it
// happened — some providers use ordering when merging facts.
const rows = await db
  .select({
    id: memories.id,
    ownerId: memories.ownerId,
    content: memories.content,
    source: memories.source,
    createdAt: memories.createdAt,
  })
  .from(memories)
  .orderBy(asc(memories.createdAt));

console.log(`Provider: ${target.name}`);
console.log(`Memories in our database: ${rows.length}`);

if (!write) {
  console.log('\nDry run. Nothing was sent. Re-run with --write to copy them across.');
  await pool.end();
  process.exit(0);
}

let sent = 0;
let failed = 0;

for (const row of rows) {
  try {
    await target.store.add({ userId: row.ownerId, content: row.content, source: row.source });
    sent++;
    process.stdout.write(`\rSent ${sent}/${rows.length}…`);
  } catch (err) {
    failed++;
    // Keep going: one bad row (or one blip) shouldn't abandon the rest, and
    // re-running is safe — providers de-duplicate identical facts, and our
    // own table is untouched either way.
    console.error(`\nFailed for memory ${row.id}:`, err instanceof Error ? err.message : err);
  }
  await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
}

console.log(`\nDone. Sent ${sent}, failed ${failed}.`);
await pool.end();
