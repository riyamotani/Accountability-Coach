import { DrizzleQueryError } from 'drizzle-orm';

/**
 * Postgres reports every failure with a five-character SQLSTATE code. These
 * are the ones the app reacts to on purpose; anything else is a real bug and
 * becomes a 500.
 */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Drizzle wraps the driver's error in a DrizzleQueryError, and the Postgres
 * code lives on the ORIGINAL error, `.cause`. Checking both keeps this working
 * whether or not a given code path goes through Drizzle.
 */
export function pgErrorCode(err: unknown): string | undefined {
  const candidates = [err, err instanceof DrizzleQueryError ? err.cause : undefined];
  for (const candidate of candidates) {
    if (typeof candidate === 'object' && candidate !== null && 'code' in candidate) {
      const code = (candidate as { code: unknown }).code;
      if (typeof code === 'string') return code;
    }
  }
  return undefined;
}

/**
 * What to log for a failed query. A DrizzleQueryError's own message includes
 * the query's PARAMETERS, and those can be a password hash, an email, or a
 * user's private note. Logs get copied around far more casually than
 * databases, so log the SQL and the database's reason, never the values.
 */
export function describeError(err: unknown): unknown {
  if (err instanceof DrizzleQueryError) {
    return { query: err.query, cause: err.cause?.message ?? 'unknown' };
  }
  return err;
}
