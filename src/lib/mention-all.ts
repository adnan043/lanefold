/**
 * `@all` in a chat message: names everyone who can read the conversation (a board chat: everyone who
 * can see the board). Shared by the server (who to notify) and the browser (what to highlight).
 */
export const ALL_TOKEN = 'all';

/** What may stand right before the `@`: the start, whitespace, or an opening/markup character. */
const PREFIX = /[\s(\["'>*_;]/;
const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}\p{M}_]/u.test(ch);

/** Where `@all` stands as a whole word (case-insensitive), in order. */
export function allMentionIndexes(body: string): number[] {
  const out: number[] = [];
  const lower = body.toLowerCase();
  let from = 0;
  for (;;) {
    const i = lower.indexOf('@all', from);
    if (i < 0) return out;
    if ((i === 0 || PREFIX.test(body[i - 1]!)) && !isWord(body[i + 4])) out.push(i);
    from = i + 4;
  }
}

export const mentionsAll = (body: string) => allMentionIndexes(body).length > 0;
