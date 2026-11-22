import type {PrismaClient} from '../generated/prisma/client';

import {cache} from '../platform/cache';
import {listPrices, type Price} from '../platform/payments';
import {type BillingMode, getAppSettings} from './entitlements';
import {UNLIMITED_MEMBERS} from '../lib/plan-limits';

/**
 * What the public pricing page shows (SPEC Phase 9): the plan limits in `plan_limits`, read at request time
 * through the Site Cache. The route that edits plan limits (`PATCH /billing/plans/:plan`) calls
 * `clearPublicPlans()`; the day is the safety net. Nothing personal in it, so it is shared by every visitor.
 * A price appears only when the plan's sandbox/live price key exists in the platform catalogue (the owner
 * decides the amounts); the key itself never leaves the server.
 */
// v3: Trello-like limits (boards, flow runs a month, no storage); a new key so an older cached entry is never read.
export const PUBLIC_PLANS_KEY = 'pricing:plans:v3';
const PUBLIC_PLANS_TTL = 86_400;

const MB = 1024 * 1024;

export interface PublicPlan {
  plan: string;
  /** null = unlimited. */
  maxMembers: number | null;
  /** Open boards; null = unlimited. */
  maxBoards: number | null;
  fileMb: number;
  /** Flow runs (automations) a month; null = unlimited, 0 = not on this plan. */
  flowRunsPerMonth: number | null;
  auditLog: boolean;
  /** The price key the plan is sold under ('' = not for sale). Server only: stripped before sending. */
  priceKey: string;
}

export interface PublicPlanOut extends Omit<PublicPlan, 'priceKey'> {
  price: {amountCents: number; currency: string; interval: string; intervalCount: number} | null;
}

export interface PublicPricing {
  billingMode: BillingMode;
  plans: PublicPlanOut[];
}

export async function loadPublicPlans(db: PrismaClient): Promise<PublicPlan[]> {
  return cache.getOrSet(PUBLIC_PLANS_KEY, PUBLIC_PLANS_TTL, async () => {
    const rows = await db.planLimit.findMany({
      select: {plan: true, maxMembers: true, maxBoards: true, maxFileBytes: true, flowRunsPerMonth: true, auditLog: true, priceKeyMonthly: true},
      orderBy: {rank: 'asc'},
      take: 10,
    });
    return rows.map(row => ({
      plan: row.plan,
      maxMembers: row.maxMembers >= UNLIMITED_MEMBERS ? null : row.maxMembers,
      maxBoards: row.maxBoards,
      fileMb: Math.round(Number(row.maxFileBytes) / MB),
      flowRunsPerMonth: row.flowRunsPerMonth,
      auditLog: row.auditLog,
      priceKey: row.priceKeyMonthly,
    }));
  });
}

/** Pure: join the plans with the catalogue (prices only when one exists) and drop the price key. */
export function composePricing(billingMode: BillingMode, plans: PublicPlan[], prices: Price[]): PublicPricing {
  const byKey = new Map(prices.map(price => [price.key, price]));
  return {
    billingMode,
    plans: plans.map(({priceKey, ...plan}) => {
      const price = priceKey ? byKey.get(priceKey) : undefined;
      return {
        ...plan,
        price: price
          ? {amountCents: price.amountCents, currency: price.currency, interval: price.interval, intervalCount: price.intervalCount}
          : null,
      };
    }),
  };
}

export async function getPublicPricing(db: PrismaClient, requestUrl: string): Promise<PublicPricing> {
  const [settings, plans, catalogue] = await Promise.all([
    getAppSettings(db),
    loadPublicPlans(db),
    listPrices(requestUrl, {ttlSeconds: 60}).catch(() => null),
  ]);
  // Free for all: no plan is sold, so no price is shown.
  const prices = settings.billingMode === 'PAID' && catalogue?.ok ? catalogue.data.prices : [];
  return composePricing(settings.billingMode, plans, prices);
}

/** Call right after `plan_limits` or the plans' price keys changed. */
export async function clearPublicPlans(): Promise<void> {
  await cache.del(PUBLIC_PLANS_KEY);
}
