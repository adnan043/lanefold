import {cache, userKey} from '../platform/cache';
import {config} from '../platform/config';

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

/**
 * The same soft limit for callers who are not signed in, keyed by their address (Cloudflare's `cf-connecting-ip`),
 * hashed with the site secret so the raw address is never a cache key. Same LIMITATION as above: a cost guard only.
 */
export async function ipLimited(ip: string | undefined, name: string, max: number, windowSec: number): Promise<boolean> {
  const bytes = new TextEncoder().encode(`${config.jwtSecret ?? ''}|soft-ip|${ip ?? 'local'}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  // 16 hex digits: the Site Cache refuses a longer hex segment as token-like, which would switch the limit off.
  const hash = Array.from(digest.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
  const k = `rl:ip:${name}:${hash}:${Math.floor(Date.now() / (windowSec * 1000))}`;
  const used = (await cache.get<number>(k)) ?? 0;
  if (used >= max) return true;
  await cache.set(k, used + 1, Math.max(60, windowSec));
  return false;
}

/**
 * softLimited() split in two, for a route that wants the cache read beside its own first read and the write after
 * its answer: `limited` is true when over `max` (nothing to record then); otherwise `record()` counts this call
 * (hand it to `afterResponse`). Same key, window and TTL as softLimited().
 */
export async function softCheck(
  userId: number,
  name: string,
  max: number,
  windowSec: number
): Promise<{limited: boolean; record: () => Promise<void>}> {
  const k = key(userId, name, windowSec);
  const used = (await cache.get<number>(k)) ?? 0;
  return {
    limited: used >= max,
    record: async () => {
      await cache.set(k, used + 1, Math.max(60, windowSec));
    },
  };
}
