/** Shared by the Site API (`GET /cards/refs`) and the chat chips: one rule for a batch of card ids. */
export const CARD_REFS_MAX = 20;

/** Positive ints from "1,2,3" (or a list), deduped and sorted. `null` when any is not a positive int or more than the cap. */
export function parseCardRefIds(raw: unknown): number[] | null {
  const parts = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : [];
  const out = new Set<number>();
  for (const part of parts) {
    const p = part.trim();
    if (!/^\d{1,10}$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647) return null;
    out.add(n);
  }
  if (out.size === 0 || out.size > CARD_REFS_MAX) return null;
  return [...out].sort((a, b) => a - b);
}

/** The TanStack Query key of a batch: sorted, deduped ids (the same set in any order is one key). */
export const cardRefsKey = (ids: readonly number[]) => ['chat', 'card-refs', [...new Set(ids)].sort((a, b) => a - b).join(',')] as const;
