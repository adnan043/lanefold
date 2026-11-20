import * as workers from 'cloudflare:workers';

import {inCurrentMode} from './keys';
import type {SubscriptionStatus} from './types';

/**
 * Who may open what, from a subscription row the SITE keeps (`docs/agent/payments-providers.md`
 * "Access rules"). Same rule as the built-in memberships: `active`, `trialing` and `past_due` open
 * the content until the period end; a `canceled` one until `accessEndsAt`; `incomplete` never.
 *
 * A row whose period ended (plus a short grace) without the site hearing of a renewal is STALE: it
 * opens nothing until the provider is asked again (`get…Subscription`) and the row is updated. So a
 * missed webhook never gives access for ever, and never takes it away from someone who renewed.
 */

/** How long past the period end an open row still counts while a renewal event may be on its way. */
export const RENEWAL_GRACE_MS = 3 * 24 * 3600_000;
/** How often one stale row may be re-read from its provider (keep the last check on the row). */
export const RECHECK_MS = 10 * 60_000;
/** How long a page waits on a re-read before the stored row decides (the re-read then finishes after the answer). */
export const RECHECK_WAIT_MS = 1_500;

export interface AccessRow {
  provider: string;
  mode: string;
  status: SubscriptionStatus | string;
  currentPeriodEnd: Date | null;
  accessEndsAt: Date | null;
}

const OPEN = new Set(['active', 'trialing', 'past_due']);

/** Open status, but the period (plus the grace) is over: re-read it from the provider before it opens anything. */
export function needsRecheck(row: AccessRow, now = Date.now()): boolean {
  if (!OPEN.has(row.status)) return false;
  return !row.currentPeriodEnd || row.currentPeriodEnd.getTime() + RENEWAL_GRACE_MS <= now;
}

/**
 * Does this row open the content now? Only in the mode the keys are in now (a test row never opens
 * anything on the live site), and never a stale one (`needsRecheck`).
 */
export function grantsAccess(row: AccessRow, now = Date.now()): boolean {
  if (!inCurrentMode(row)) return false;
  if (OPEN.has(row.status)) return !needsRecheck(row, now);
  if (row.status === 'canceled') return Boolean(row.accessEndsAt && row.accessEndsAt.getTime() > now);
  return false;
}

/**
 * A re-read a page waits on for `ms` at most (`needsRecheck`): its result, or null when it is slower.
 * Then it goes on after the answer (`waitUntil`), so it still updates the row for the next request,
 * and the page decides from the STORED row now. A re-read that fails is null too. Never throws.
 */
export async function settleWithin<T>(work: Promise<T>, ms = RECHECK_WAIT_MS): Promise<T | null> {
  const settled = work.catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const LATE = Symbol('late');
  const late = new Promise<typeof LATE>(resolve => {
    timer = setTimeout(() => resolve(LATE), ms);
  });
  const first = await Promise.race([settled, late]);
  clearTimeout(timer);
  if (first !== LATE) return first as T | null;
  const waitUntil = (workers as {waitUntil?: (p: Promise<unknown>) => void}).waitUntil;
  if (typeof waitUntil === 'function') waitUntil(settled);
  return null;
}
