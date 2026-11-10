import {generateKeyBetween, generateNKeysBetween} from 'fractional-indexing';

/** `position` columns are VarChar(64); keys longer than this are never written (see `keyOrNull`). */
export const MAX_KEY_LENGTH = 48;

/**
 * A key between two neighbours, or null when they are out of order, equal, or the key would be longer than
 * MAX_KEY_LENGTH (repeated inserts into one gap lengthen keys by about one character per six inserts; the
 * column holds 64, so an unbounded key would end in a database error).
 */
export function keyOrNull(before: string | null | undefined, after: string | null | undefined): string | null {
  if (before != null && after != null && before >= after) return null;
  try {
    const key = generateKeyBetween(before ?? null, after ?? null);
    return key.length > MAX_KEY_LENGTH ? null : key;
  } catch {
    return null;
  }
}

/** `n` fresh, strictly increasing, evenly spaced keys for renumbering a lane whose gap is exhausted. */
export function evenKeys(n: number): string[] {
  return n <= 0 ? [] : generateNKeysBetween(null, null, n);
}
