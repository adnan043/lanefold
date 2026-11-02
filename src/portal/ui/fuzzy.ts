/**
 * Tiny fuzzy matcher for the command palette: every query character must
 * appear in order. Higher score = better; null = no match. Prefix, word-start
 * and consecutive matches score more; a gap costs.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 + (t.startsWith(q) ? 50 : 0) - t.indexOf(q) - (t.length - q.length) * 0.1;
  let score = 0;
  let at = -1;
  let run = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, at + 1);
    if (found === -1) return null;
    const wordStart = found === 0 || /[\s\-_/.:]/.test(t[found - 1] ?? '');
    run = found === at + 1 ? run + 1 : 0;
    score += 1 + run * 2 + (wordStart ? 3 : 0) - Math.min(found - at - 1, 5) * 0.2;
    at = found;
  }
  return score;
}

/** Best score of a query over several fields (label, hint, keywords), null when none match. */
export function bestScore(query: string, fields: Array<string | undefined>): number | null {
  let best: number | null = null;
  fields.forEach((field, i) => {
    if (!field) return;
    const s = fuzzyScore(query, field);
    if (s !== null) {
      const weighted = s - i * 2; // the label outranks hint and keywords
      if (best === null || weighted > best) best = weighted;
    }
  });
  return best;
}
