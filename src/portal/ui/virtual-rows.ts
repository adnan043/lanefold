/** A table windows its rows only from this many rows up; shorter lists render whole. */
export const VIRTUAL_MIN_ROWS = 100;

/** Height of the blank space above the first and below the last drawn row. */
export function spacerSizes(items: ReadonlyArray<{start: number; end: number}>, total: number): {top: number; bottom: number} {
  if (items.length === 0) return {top: 0, bottom: 0};
  const first = items[0]!;
  const last = items[items.length - 1]!;
  return {top: Math.max(0, first.start), bottom: Math.max(0, total - last.end)};
}
