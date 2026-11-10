import {grantsAccess} from '../../platform/payments';

/** Pure rules for the scheduled jobs (no I/O): unit-tested in tests/jobs-logic.test.ts. */

export const PAGE_SIZE = 100;
/** Pages one run may handle; the rest is picked up by the next run (work is idempotent). */
export const MAX_PAGES = 40;
export const DELETE_BATCH = 500;
export const MAX_DELETE_BATCHES = 20;

export const DEFAULT_RETENTION = {inviteDays: 30, notificationDays: 90} as const;

/** A paid membership has ended: it no longer opens access (cancelled and `accessEndsAt` passed, or none). */
export const membershipEnded = (status: string, accessEndsAt: Date | string | null, now = Date.now()): boolean =>
  !grantsAccess(status, accessEndsAt, now);

/**
 * A workspace falls back to free only when it has ended membership(s) for its plan's price and NO
 * membership for it that still grants access. Plans given by staff (no membership at all) never fall.
 */
export function shouldFallToFree(
  plan: string,
  memberships: {status: string; accessEndsAt: Date | string | null}[],
  now = Date.now()
): boolean {
  if (plan === 'free' || memberships.length === 0) return false;
  return memberships.every(m => membershipEnded(m.status, m.accessEndsAt, now));
}

/** Whole days from the job's data, clamped so a bad value never wipes everything. */
export function keepDays(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? Math.floor(value) : NaN;
  return Number.isFinite(n) ? Math.min(Math.max(n, 7), 3650) : fallback;
}

export const cutoff = (now: number, days: number): Date => new Date(now - days * 86_400_000);

/** Keyset cursor for the next page: the last id when the page was full, else null (done). */
export const nextCursor = <T extends {id: number | bigint}>(rows: T[], size = PAGE_SIZE): number | null =>
  rows.length >= size ? Number(rows[rows.length - 1]!.id) : null;
