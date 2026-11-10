import {findCardNumberRefs} from '../../lib/card-number-refs';
import {safeUrl} from '../../lib/markdown';
import {allMentionIndexes} from '../../lib/mention-all';
import type {MemberT} from './api';

/** What mentions need of a person. */
export type PersonRef = Pick<MemberT, 'userId' | 'name'>;

/** Pure helpers for @mentions (unit tested): the server stores the text and the ids; the text is escaped on render. */
export const MAX_BODY = 4000;
export const MAX_MENTIONS = 20;

const isBoundary = (ch: string | undefined) => ch === undefined || !/[\p{L}\p{N}_]/u.test(ch);

/** The `@word` being typed at the caret, or null. The `@` must start the text or follow whitespace. */
export function mentionAt(text: string, caret: number): {start: number; query: string} | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (query.length > 30 || /\n/.test(query)) return null;
  return {start: at, query};
}

export const MAX_CARDS = 10;

/** The `#word` being typed at the caret (to attach a card), or null. The `#` must start the text or follow whitespace. */
export function cardTagAt(text: string, caret: number): {start: number; query: string} | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('#');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (query.length > 60 || /\n/.test(query)) return null;
  return {start: at, query};
}

/** Removes the `#query` being typed (the picked card shows as a chip under the box, not in the text). */
export function removeCardTag(text: string, caret: number, start: number): {text: string; caret: number} {
  return {text: text.slice(0, start) + text.slice(caret), caret: start};
}

/** People matching what was typed after `@`: name prefix first, then contains; at most `max`. */
export function matchPeople(people: readonly PersonRef[], query: string, max = 6): PersonRef[] {
  const q = query.trim().toLowerCase();
  const named = people.filter(p => p.name);
  const starts = named.filter(p => p.name!.toLowerCase().startsWith(q));
  const rest = q ? named.filter(p => !starts.includes(p) && p.name!.toLowerCase().includes(q)) : [];
  return [...starts, ...rest].slice(0, max);
}

/** Replaces the `@query` being typed with `@Name ` and returns the new text and caret. */
export function insertMention(text: string, caret: number, start: number, name: string): {text: string; caret: number} {
  const insert = `@${name} `;
  return {text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length};
}

/** Ids of the people whose `@Name` stands in the text (longest names first, so "Ann Lee" beats "Ann"). */
export function mentionedIds(text: string, people: readonly PersonRef[]): number[] {
  const out = new Set<number>();
  const named = people.filter(p => p.name).sort((a, b) => b.name!.length - a.name!.length);
  // Matched ranges are blanked, so "@Ann" inside "@Ann Lee" does not also mention Ann.
  let work = text;
  for (const p of named) {
    const needle = `@${p.name}`;
    let from = 0;
    for (;;) {
      const i = work.indexOf(needle, from);
      if (i < 0) break;
      if ((i === 0 || /\s/.test(work[i - 1]!)) && isBoundary(work[i + needle.length])) {
        out.add(p.userId);
        work = work.slice(0, i) + '\u0000'.repeat(needle.length) + work.slice(i + needle.length);
        break;
      }
      from = i + 1;
    }
    if (out.size >= MAX_MENTIONS) break;
  }
  return [...out];
}

export type Segment = {kind: 'text' | 'mention' | 'link'; value: string} | {kind: 'card'; value: string; number: number};

const URL_RE = /https?:\/\/[^\s<>"']+/g;

/** Splits a body into text, `@Name` of the mentioned people, and https links. Never HTML: React escapes every piece. */
export function segments(body: string, mentionNames: readonly string[], cardNumbers?: ReadonlySet<number>): Segment[] {
  const names = [...mentionNames].filter(Boolean).sort((a, b) => b.length - a.length);
  const out: Segment[] = [];
  // Text between links and mentions: a `#42` that the server resolved becomes a card segment (the rest stays text).
  const pushPlain = (value: string) => {
    if (!cardNumbers || cardNumbers.size === 0) return void out.push({kind: 'text', value});
    let at = 0;
    for (const ref of findCardNumberRefs(value)) {
      if (!cardNumbers.has(ref.number)) continue;
      if (ref.start > at) out.push({kind: 'text', value: value.slice(at, ref.start)});
      out.push({kind: 'card', value: value.slice(ref.start, ref.end), number: ref.number});
      at = ref.end;
    }
    if (at < value.length) out.push({kind: 'text', value: value.slice(at)});
  };
  const pushText = (value: string) => {
    if (!value) return;
    let last = 0;
    for (const m of value.matchAll(URL_RE)) {
      const trimmed = m[0].replace(/[.,;:!?)\]]+$/, '');
      const href = safeUrl(trimmed); // the same check as the card Markdown; a refused one stays plain text
      if (!href) continue;
      if (m.index! > last) pushPlain(value.slice(last, m.index));
      out.push({kind: 'link', value: href});
      last = m.index! + trimmed.length;
    }
    if (last < value.length) pushPlain(value.slice(last));
  };
  const all = new Set(allMentionIndexes(body));
  let i = 0;
  let buffer = '';
  while (i < body.length) {
    const named = body[i] === '@' && (i === 0 || /\s/.test(body[i - 1]!)) ? names.find(n => body.startsWith(n, i + 1) && isBoundary(body[i + 1 + n.length])) : undefined;
    // `@all` (everyone in the conversation) unless a person is really called "all…" and was named.
    const hit = named ?? (all.has(i) ? body.slice(i + 1, i + 4) : undefined);
    if (hit) {
      pushText(buffer);
      buffer = '';
      out.push({kind: 'mention', value: `@${hit}`});
      i += hit.length + 1;
    } else {
      buffer += body[i];
      i += 1;
    }
  }
  pushText(buffer);
  return out;
}

/** Same day? (for the day separators) */
export const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};
