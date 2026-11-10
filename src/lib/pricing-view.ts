import {flowsCell} from '../content/site';
import type {PublicPricing} from '../server/pricing';

/** The static plan copy (`PRICING.plans` in `src/content/site.ts`) and the numbers the page shows. */
export interface PlanCopy {
  key: string;
  name: string;
  features: string[];
  limits: {members: string; file: string; storage: string; flows: string; audit: boolean};
  [more: string]: unknown;
}

const size = (gb: number) => (gb >= 1 ? `${gb} GB` : `${Math.round(gb * 1024)} MB`);

/**
 * Put the live limits (`GET /site-api/billing/public-plans`) over the static copy, plan by plan. A plan the API
 * does not know keeps the copy's numbers; `null` (database down) keeps all of them.
 */
export function withLiveLimits<T extends PlanCopy>(plans: T[], live: PublicPricing | null): T[] {
  if (!live) return plans;
  const byKey = new Map(live.plans.map(plan => [plan.plan, plan]));
  return plans.map(plan => {
    const now = byKey.get(plan.key);
    if (!now) return plan;
    const limits = {members: String(now.maxMembers), file: `${now.fileMb} MB`, storage: size(now.storageGb), flows: flowsCell(now.maxFlows), audit: now.auditLog};
    const features = plan.features.map(feature => {
      if (/^Up to \d+ members$/.test(feature)) return `Up to ${limits.members} members`;
      if (/^\d+ MB per file$/.test(feature)) return `${limits.file} per file`;
      if (/ of storage$/.test(feature)) return `${limits.storage} of storage`;
      if (/^Up to \d+ flows \(automations\)$/.test(feature)) return now.maxFlows > 0 ? `Up to ${now.maxFlows} flows (automations)` : null;
      return feature;
    }).filter((feature): feature is string => feature !== null);
    return {...plan, limits, features};
  });
}

/** "$9" / "$9.50 / month": the amount a plan's price shows, from minor units. */
export function formatPrice(price: {amountCents: number; currency: string; interval: string; intervalCount: number}, locale = 'en'): string {
  const amount = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: price.currency,
    minimumFractionDigits: price.amountCents % 100 === 0 ? 0 : 2,
  }).format(price.amountCents / 100);
  if (price.interval === 'one_time') return amount;
  const unit = price.interval === 'year' ? 'year' : 'month';
  return price.intervalCount > 1 ? `${amount} / ${price.intervalCount} ${unit}s` : `${amount} / ${unit}`;
}
