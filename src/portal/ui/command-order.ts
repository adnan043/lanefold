type Row = {group?: string; always?: boolean; fallback?: boolean};

/** Orders matches into groups (first-seen group order), with `fallback` items last. */
export function groupResults<T extends Row>(found: T[]): T[] {
  const main = found.filter(item => !item.fallback);
  const order: string[] = [];
  for (const item of main) if (!order.includes(item.group ?? '')) order.push(item.group ?? '');
  return [...order.flatMap(group => main.filter(item => (item.group ?? '') === group)), ...found.filter(item => item.fallback)];
}

/** The row Enter runs before the user moves: while searching, the first server result, else the first non-fallback row. */
export function defaultActive(results: Row[], query: string): number {
  if (query.trim()) {
    const hit = results.findIndex(item => item.always && !item.fallback);
    if (hit >= 0) return hit;
  }
  const first = results.findIndex(item => !item.fallback);
  return first; // -1 when only fallbacks (Enter then does nothing)
}
