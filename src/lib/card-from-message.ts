/** Rules shared by the server route (`POST /messages/:id/card`) and its tests. */
export const CARD_TITLE_MAX = 200;
export const DERIVED_TITLE_MAX = 120;

/** The default card title: the first non-empty line of the message, whitespace collapsed, at most 120 characters. */
export function titleFromMessage(body: string, fallback = 'Untitled'): string {
  const line = body.split(/\r\n?|\n/).map(l => l.replace(/\s+/g, ' ').trim()).find(l => l.length > 0) ?? '';
  const chars = Array.from(line);
  const cut = chars.length > DERIVED_TITLE_MAX ? `${chars.slice(0, DERIVED_TITLE_MAX - 1).join('').trimEnd()}…` : line;
  return cut || fallback;
}

/** The card description: the message text, then a back-reference line. */
export function descriptionFromMessage(body: string, source: string, max = Infinity): string {
  const footer = `\n\n---\n*From chat: ${source}*`;
  const text = body.trim();
  const room = max - Array.from(footer).length;
  // Cut by code points (never inside a surrogate pair) and keep the footer.
  return Array.from(text).length > room ? `${Array.from(text).slice(0, Math.max(0, room)).join('')}${footer}` : `${text}${footer}`;
}
