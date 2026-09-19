import { Redis } from 'ioredis';
import { env } from '../lib/env.js';

/**
 * WHY WE CONSTRUCT CLIENTS OURSELVES
 *
 * BullMQ 5 bundled the `ioredis` client and would build one for you from a
 * plain options object. BullMQ 6 made the client an OPTIONAL dependency — you
 * bring your own, so you can choose ioredis or node-redis. It also warns that
 * under native ESM (which every package here is, via "type": "module"), you
 * must pass an already-constructed client rather than options, because it can
 * no longer load ioredis on your behalf.
 *
 * So: we build the clients, BullMQ uses them. Owning them is better anyway —
 * we attach our own error listeners, close them on shutdown, and ioredis takes
 * the URL directly, so there's no hand-parsing of REDIS_URL.
 *
 * TWO PROFILES, because producers and consumers want OPPOSITE behaviour when
 * Redis is unreachable.
 */

/**
 * PRODUCER connection — used by the API (and the worker) to ADD jobs.
 *
 * Should FAIL FAST. ioredis normally keeps an "offline queue": commands issued
 * while disconnected are buffered in memory and sent on reconnect.
 * `enableOfflineQueue: false` turns that off, so such a command rejects
 * immediately instead.
 *
 * Note what this is NOT for: keeping user requests from hanging. The routes
 * call `void syncGoalSchedule(...)` and never wait on Redis at all — `void` is
 * what protects the request. Fail-fast does two other jobs:
 *   1. No backlog during an outage. Buffering would grow an in-memory pile of
 *      commands for every goal saved while Redis is down, then flood Redis
 *      with all of them on recovery.
 *   2. Failures show up in the logs the moment they happen.
 * Dropping those commands is safe only because the reconciliation sweep
 * rebuilds every schedule from Postgres regardless.
 *
 * Created at import time because every process that imports the queue needs it.
 */
export const queueConnection = new Redis(env.redisUrl, {
  enableOfflineQueue: false,
});

// An unhandled 'error' event on a client is noisy at best and can crash the
// process at worst. Log it and let ioredis's built-in reconnect do its job.
queueConnection.on('error', (err) => {
  console.error('[redis:queue]', err.message);
});

/**
 * CONSUMER connection — used only by the worker to WAIT for jobs.
 *
 * Should do the opposite: wait patiently. A worker blocks on Redis until work
 * arrives, and a blocking command can legitimately wait forever — so
 * `maxRetriesPerRequest: null` stops the client treating a long wait as a
 * failure. BullMQ requires this for workers.
 *
 * A factory rather than a module-level constant, deliberately: the API server
 * also imports this file (through the queue), and it has no business opening
 * an idle blocking connection it will never use. Only worker.ts calls this.
 */
export function createWorkerConnection(): Redis {
  const connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', (err) => {
    console.error('[redis:worker]', err.message);
  });
  return connection;
}
