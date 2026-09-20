import { QUEUE_NAME, RETRY_OPTS, reminderQueue } from './reminders.js';
import { env } from '../lib/env.js';

/**
 * Embedding a memory is a job, not part of the request that saved it.
 *
 * Reasons, in order: it's a network call the user shouldn't wait on; it can
 * fail, and a job retries by itself; and if the AI is down for an hour, the
 * memories are still safely written and simply get embedded when it's back.
 *
 * Shares the existing queue (jobs are told apart by NAME, not by queue), so
 * the single worker process handles it alongside reminders. A second queue
 * would earn its keep only if these needed separate concurrency or priority.
 */
export const EMBED_MEMORY_JOB = 'embed-memory';

export interface EmbedMemoryJobData {
  memoryId: string;
}

/**
 * Never throws, for the same reason syncGoalSchedule doesn't: the memory is
 * already stored, and a Redis hiccup must not fail the user's request. The
 * reconcile sweep re-queues anything left unembedded.
 */
export async function enqueueMemoryEmbedding(memoryId: string): Promise<void> {
  // Deterministic id: queueing the same memory twice (a retry, or the sweep
  // racing the original) is ignored by BullMQ rather than paying for the same
  // embedding twice.
  const jobId = `embed-${memoryId}`;

  try {
    // ...but that same de-duplication would also block a LEGITIMATE retry: a
    // job that exhausted its attempts stays in Redis as failed, under this
    // id, and `add` with an existing id is a silent no-op. The memory would
    // then never be embedded, however often the sweep tried.
    //
    // So a finished job is cleared first. `remove()` refuses while a job is
    // actively running, which is the case we WANT to skip — the add below is
    // then the harmless no-op it was designed to be.
    await reminderQueue.remove(jobId).catch(() => {});

    await reminderQueue.add(
      EMBED_MEMORY_JOB,
      { memoryId } satisfies EmbedMemoryJobData,
      {
        ...RETRY_OPTS,
        jobId,
        // Don't keep failures: the memories table already records what still
        // needs embedding (embedding IS NULL), and a retained failed job is
        // exactly what would block the sweep from retrying it.
        removeOnFail: true,
      },
    );
  } catch (err) {
    console.error(
      `[memory] could not queue embedding for ${memoryId} — the sweep will retry:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Copying a memory to the hosted provider (Mem0) is a job for the same
 * reasons embedding is: it's a network call the user must not wait on, it can
 * fail, and the memory is already safe in our own table by the time this runs.
 *
 * This is the "derived index" half of the design — our Postgres row is the
 * record, and this keeps the provider's copy in step with it.
 */
export const SYNC_MEMORY_JOB = 'sync-memory';

export interface SyncMemoryJobData {
  memoryId: string;
}

export async function enqueueMemorySync(memoryId: string): Promise<void> {
  // Includes the provider name: switching providers should queue a genuinely
  // new job for the same memory rather than being swallowed as a duplicate
  // of the one that already ran for the old provider.
  const jobId = `sync-${env.memoryProvider}-${memoryId}`;

  try {
    await reminderQueue.remove(jobId).catch(() => {});
    await reminderQueue.add(SYNC_MEMORY_JOB, { memoryId } satisfies SyncMemoryJobData, {
      ...RETRY_OPTS,
      jobId,
      removeOnFail: true,
    });
  } catch (err) {
    console.error(
      `[memory] could not queue provider sync for ${memoryId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export { QUEUE_NAME };
