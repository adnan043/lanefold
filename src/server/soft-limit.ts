import {cache, userKey} from '../platform/cache';

/**
 * Soft per-user rate limits on the Site Cache (no table, no migration), a counter per user, name and window.
 *
 * LIMITATION: the Site Cache offers get/set/del only, no atomic increment, so read-then-write can lose
 * a count under a burst (a few extra requests slip through) and everything fails open when the cache is
 * unreachable. Fine as a cost/abuse guard; NOT a security boundary. Switch to an atomic `incr` if the
 * platform ever adds one.
 */

const key = (userId: number, name: string, windowSec: number) => userKey(userId, `rl:${name}:${Math.floor(Date.now() / (windowSec * 1000))}`);

/** Hits so far in the current window. */
export async function softCount(userId: number, name: string, windowSec: number): Promise<number> {
  return (await cache.get<number>(key(userId, name, windowSec))) ?? 0;
}

/** Records one hit (the key lives a little past its window; TTL is at least the cache's 60 s minimum). */
export async function softHit(userId: number, name: string, windowSec: number): Promise<void> {
  const k = key(userId, name, windowSec);
  const used = (await cache.get<number>(k)) ?? 0;
  await cache.set(k, used + 1, Math.max(60, windowSec));
}

/** True when over `max` for this window; otherwise counts this call (one cache read, one write). */
export async function softLimited(userId: number, name: string, max: number, windowSec: number): Promise<boolean> {
  const k = key(userId, name, windowSec);
  const used = (await cache.get<number>(k)) ?? 0;
  if (used >= max) return true;
  await cache.set(k, used + 1, Math.max(60, windowSec));
  return false;
}
