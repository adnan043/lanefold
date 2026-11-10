/** Stale card warning: the choices of a board's "remind me about cards that sit in a lane" setting (days; null = off). */
export const STALE_DAY_OPTIONS = [3, 7, 14, 30] as const;
export type StaleDays = (typeof STALE_DAY_OPTIONS)[number];

export const isStaleDays = (value: unknown): value is StaleDays =>
  typeof value === 'number' && (STALE_DAY_OPTIONS as readonly number[]).includes(value);

const DAY = 86_400_000;

/**
 * Pure rule, the same one the job's SQL applies: a card is stale when it has been in its current lane for at least
 * `staleDays` whole days (`now - enteredAt >= staleDays * 24 h`). `staleDays` null (setting off) is never stale.
 */
export function isStale(enteredAt: Date, staleDays: number | null, now: Date): boolean {
  if (staleDays === null || !isStaleDays(staleDays)) return false;
  return now.getTime() - enteredAt.getTime() >= staleDays * DAY;
}
