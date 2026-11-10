/**
 * `#42` in a chat message: a reference to the card with that number on the board of the board chat.
 * Pure helpers shared by the server (which numbers to look up) and the client (where to draw a link).
 *
 * Rules (unit tested): 1 to 7 digits, no leading zero; the `#` starts the text or follows a character that is
 * not a letter, digit or `_` (so `C#1`, `a#1b`, `foo#42`, `##42` are plain text) and the digits are not followed by a
 * letter, digit or `_` (`#42abc`, `#1_000` are plain text); never inside a `code span` or a ``` block, and
 * never inside a web address (`https://x.test/#42`).
 */
export const MAX_REF_DIGITS = 7;
/** Distinct numbers looked up for one message, and for one page of messages. */
export const MAX_REFS_PER_MESSAGE = 10;
export const MAX_REFS_PER_PAGE = 20;

export type CardNumberRef = {start: number; end: number; number: number};

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;
const REF_RE = /#([1-9]\d{0,6})/g;
const WORD = /[\p{L}\p{M}\p{N}_]/u;

/** Ranges of the text where a `#42` is NOT a reference (code, web addresses). */
function blocked(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const re of [CODE_RE, URL_RE]) {
    for (const m of text.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  }
  return out;
}

/** Every `#N` reference in the text, in order, up to `max` (default: the per-message cap on distinct numbers is applied by `distinctCardNumbers`). */
export function findCardNumberRefs(text: string, max = 200): CardNumberRef[] {
  if (!text.includes('#')) return [];
  const skip = blocked(text);
  const out: CardNumberRef[] = [];
  for (const m of text.matchAll(REF_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (start > 0 && (WORD.test(text[start - 1]!) || text[start - 1] === '#')) continue;
    if (end < text.length && WORD.test(text[end]!)) continue;
    if (skip.some(([a, b]) => start >= a && start < b)) continue;
    out.push({start, end, number: Number(m[1])});
    if (out.length >= max) break;
  }
  return out;
}

/** The distinct numbers a text refers to (at most `MAX_REFS_PER_MESSAGE`, first seen first). */
export function distinctCardNumbers(text: string): number[] {
  const seen = new Set<number>();
  for (const ref of findCardNumberRefs(text)) {
    seen.add(ref.number);
    if (seen.size >= MAX_REFS_PER_MESSAGE) break;
  }
  return [...seen];
}
