/** Pure rules for the wait after a 429 (`ApiError.retryAfter`, seconds). No React, no DOM. */

export const MAX_COOLDOWN_SECONDS = 60;

/** Milliseconds a write must wait after this error: only a 429 with a usable `retryAfter`, capped at 60 s; otherwise 0. */
export function cooldownMs(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const {status, retryAfter} = error as {status?: unknown; retryAfter?: unknown};
  if (status !== 429 || typeof retryAfter !== 'number' || !Number.isFinite(retryAfter) || retryAfter <= 0) return 0;
  return Math.min(MAX_COOLDOWN_SECONDS, Math.ceil(retryAfter)) * 1000;
}

/** Whole seconds left until `until` (epoch ms); 0 once it has passed. */
export function secondsLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** The later of the current deadline and a new one (a shorter answer never shortens a wait already running). */
export function extendUntil(current: number, error: unknown, now: number): number {
  const ms = cooldownMs(error);
  return ms > 0 ? Math.max(current, now + ms) : current;
}
