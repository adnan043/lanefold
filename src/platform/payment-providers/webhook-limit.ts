/**
 * A per-IP limit for `/site-api/payment-webhooks/*` (`docs/agent/payments-providers.md` "Webhooks"):
 * the routes take posts from anyone, and each unsigned Ezypay post or fresh PayPal post costs a call
 * to the provider. Run it FIRST, before reading the body. In memory, per isolate: it holds back one
 * address flooding the routes at no cost (no database row, no call); a real provider sends far
 * fewer. The signature and freshness checks stay the actual gate. Server only.
 */

/** Posts one address may make to the webhook routes per minute, per isolate. */
export const WEBHOOK_POSTS_PER_MINUTE = 60;
/** Addresses remembered at most (the oldest window is dropped first). */
const MAX_ADDRESSES = 5_000;
const WINDOW_MS = 60_000;

const windows = new Map<string, {start: number; count: number}>();
export const resetWebhookLimitForTests = () => windows.clear();

/**
 * May this address post again now? `ip`: `c.req.header('cf-connecting-ip')`. No address (a local
 * run): allowed. False: answer 429 and read nothing.
 */
export function webhookIpAllowed(
  ip: string | null | undefined,
  {nowMs = Date.now(), perMinute = WEBHOOK_POSTS_PER_MINUTE}: {nowMs?: number; perMinute?: number} = {}
): boolean {
  if (!ip) return true;
  const key = ip.slice(0, 64);
  const w = windows.get(key);
  if (!w || nowMs - w.start >= WINDOW_MS) {
    windows.delete(key);
    if (windows.size >= MAX_ADDRESSES) windows.delete(windows.keys().next().value as string);
    windows.set(key, {start: nowMs, count: 1});
    return true;
  }
  w.count += 1;
  return w.count <= perMinute;
}
