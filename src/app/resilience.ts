/**
 * Pure rules for how the client reacts to a failed call (no React, no DOM): which code a bare status means,
 * when a read may retry and how long to wait, and which answers mean the session is gone.
 */

/** Error code for an answer that carried none (a managed guard, a proxy page, a platform outage). Keys: `errors.<code>`. */
export function codeForStatus(status: number): string | undefined {
  if (status === 0) return 'network';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return undefined;
}

/** Seconds from a `Retry-After` header (delta-seconds form only), capped at 5 minutes; undefined when absent or unusable. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value || !/^\d{1,6}$/.test(value.trim())) return undefined;
  return Math.min(300, Number(value));
}

type StatusLike = {status?: number} | null | undefined;
const statusOf = (error: unknown): number | undefined => (error && typeof error === 'object' ? (error as StatusLike)?.status : undefined);

/** Reads retry only for a network failure or a 5xx: never for 4xx, never in a storm. */
export function shouldRetryQuery(count: number, error: unknown): boolean {
  const status = statusOf(error);
  if (status === undefined) return count < 1;
  if (status === 0) return count < 2;
  if (status === 503 || status === 502 || status === 504) return count < 1;
  return false;
}

/** Exponential backoff with jitter: ~1 s, 2 s, 4 s ... capped at 30 s. `random` is injectable for tests. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt)) * (0.75 + random() * 0.5);
}

/** The session is gone for good (the shared fetch already tried one refresh): the shell must send the person to sign in. */
export function isSessionLost(error: unknown): boolean {
  return statusOf(error) === 401;
}
