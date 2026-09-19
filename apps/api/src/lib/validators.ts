import { z } from 'zod';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every id in the database is a uuid column, and Postgres REJECTS a
 * malformed uuid instead of just finding nothing: `WHERE id = 'abc'` throws
 * "invalid input syntax for type uuid", which would surface as a 500. A
 * garbage id in a URL is the client's mistake, and for the client it means
 * "no such thing", so routes check the shape first and answer 404.
 */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Validated by ASKING the runtime to use the zone, not by checking membership
 * in `Intl.supportedValuesOf('timeZone')`.
 *
 * That list contains only each zone's canonical name for the ICU data bundled
 * with this specific runtime — e.g. our Node build lists `Asia/Calcutta` but
 * not its modern alias `Asia/Kolkata`, even though the constructor accepts
 * both. Which name is "canonical" also varies between ICU versions, so a
 * membership check would accept different inputs on a Windows dev box than in
 * a Linux container. Try-and-catch against the constructor is the portable
 * test — and it's why registration works regardless of which alias a given
 * browser happens to report.
 *
 * Lives here rather than inline so registration and profile-update can't
 * drift apart on what counts as valid.
 */
export const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Unknown IANA timezone' },
);
