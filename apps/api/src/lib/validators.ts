import { z } from 'zod';

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
