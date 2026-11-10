import {afterEach, describe, expect, it, vi} from 'vitest';

import {PRICING} from '../src/content/site';
import {formatPrice, withLiveLimits} from '../src/lib/pricing-view';
import {cache, setCacheModeForTests} from '../src/platform/cache';
import {composePricing, loadPublicPlans, clearPublicPlans, type PublicPlan} from '../src/server/pricing';

afterEach(() => setCacheModeForTests(null));

const MB = 1024 * 1024;
const GB = 1024 * MB;
const row = (plan: string, maxMembers: number, priceKeyMonthly = '') => ({
  plan,
  maxMembers,
  maxFileBytes: BigInt(10 * MB),
  storageQuotaBytes: BigInt(2 * GB),
  maxFlows: plan === 'free' ? 0 : 10,
  auditLog: plan === 'team',
  priceKeyMonthly,
});
const dbWith = (rows: ReturnType<typeof row>[]) => {
  const findMany = vi.fn(async () => rows);
  return {db: {planLimit: {findMany}} as never, findMany};
};
const price = {key: 'pro-monthly', name: 'Pro', description: null, amountCents: 900, currency: 'USD', interval: 'month' as const, intervalCount: 1, trialDays: 0};

describe('pricing reads limits at request time through the cache', () => {
  it('loads once, serves the cache, and shows the new limits after clearPublicPlans()', async () => {
    setCacheModeForTests('memory');
    const first = dbWith([row('free', 7)]);
    expect((await loadPublicPlans(first.db))[0]!.maxMembers).toBe(7);
    expect((await loadPublicPlans(first.db))[0]!.maxMembers).toBe(7);
    expect(first.findMany).toHaveBeenCalledTimes(1);
    await clearPublicPlans();
    const second = dbWith([row('free', 12)]);
    expect((await loadPublicPlans(second.db))[0]!.maxMembers).toBe(12);
    await cache.delPrefix('pricing:');
  });

  it('the edit route clears the pricing cache', async () => {
    const {readFileSync} = await import('node:fs');
    expect(readFileSync('src/server/routes/billing.ts', 'utf8')).toMatch(/clearPublicPlans\(\)/);
  });
});

describe('PAID billing mode', () => {
  const plans: PublicPlan[] = [
    {plan: 'free', maxMembers: 7, fileMb: 10, storageGb: 2, maxFlows: 0, auditLog: false, priceKey: ''},
    {plan: 'pro', maxMembers: 60, fileMb: 100, storageGb: 20, maxFlows: 25, auditLog: false, priceKey: 'pro-monthly'},
  ];

  it('shows a price only for a plan whose price exists, never the price key', () => {
    const out = composePricing('PAID', plans, [price]);
    expect(out.plans[0]!.price).toBeNull();
    expect(out.plans[1]!.price).toEqual({amountCents: 900, currency: 'USD', interval: 'month', intervalCount: 1});
    expect(JSON.stringify(out)).not.toContain('pro-monthly');
  });

  it('shows no price when the catalogue has none (owner has not chosen amounts)', () => {
    expect(composePricing('PAID', plans, []).plans.every(p => p.price === null)).toBe(true);
  });

  it('live limits replace the static copy, features included; null keeps the copy', () => {
    const live = composePricing('PAID', plans, []);
    const merged = withLiveLimits(PRICING.plans, live);
    const free = merged.find(p => p.key === 'free')!;
    expect(free.limits.members).toBe('7');
    expect(free.features).toContain('Up to 7 members');
    expect(free.limits.flows).toBe('Not included');
    const pro = merged.find(p => p.key === 'pro')!;
    expect(pro.limits.flows).toBe('Up to 25');
    expect(pro.features).toContain('Up to 25 flows (automations)');
    const team = merged.find(p => p.key === 'team')!;
    expect(team.limits).toEqual(PRICING.plans.find(p => p.key === 'team')!.limits);
    expect(withLiveLimits(PRICING.plans, null)).toBe(PRICING.plans);
  });

  it('formats prices', () => {
    expect(formatPrice({amountCents: 900, currency: 'USD', interval: 'month', intervalCount: 1})).toBe('$9 / month');
    expect(formatPrice({amountCents: 950, currency: 'USD', interval: 'year', intervalCount: 1})).toBe('$9.50 / year');
  });
});

describe('FREE_FOR_ALL billing mode', () => {
  it('has copy that says everything is free and limits are not enforced', () => {
    expect(PRICING.freeNote).toMatch(/free for everyone/);
    expect(PRICING.freeNote).toMatch(/not enforced/);
  });

  it('the page hides prices and the change-plan link in this mode', async () => {
    const {readFileSync} = await import('node:fs');
    const src = readFileSync('src/pages/pricing.astro', 'utf8');
    expect(src).toMatch(/price && !free/);
    expect(src).toMatch(/!free && <a/);
    expect(src).not.toMatch(/prerender = true/);
  });
});
