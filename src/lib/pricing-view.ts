import {boardsLine, countCell, fileLine, flowsCell, membersLine, runsLine} from '../content/site';
import type {PublicPricing} from '../server/pricing';

/** The static plan copy (`PRICING.plans` in `src/content/site.ts`) and the numbers the page shows. */
export interface PlanCopy {
  key: string;
  name: string;
  features: string[];
  limits: {members: string; boards: string; file: string; flows: string; audit: boolean};
  [more: string]: unknown;
}

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
    const limits = {
      members: countCell(now.maxMembers),
      boards: countCell(now.maxBoards),
      file: `${now.fileMb} MB`,
      flows: flowsCell(now.flowRunsPerMonth),
      audit: now.auditLog,
    };
    const features = plan.features
      .map(feature => {
        if (/^(Up to [\d,]+|Unlimited) members$/.test(feature)) return membersLine(now.maxMembers);
        if (/^(Up to [\d,]+|Unlimited) boards$/.test(feature)) return boardsLine(now.maxBoards);
        if (/^[\d,]+ MB per file$/.test(feature)) return fileLine(now.fileMb);
        if (/^([\d,]+ automation runs a month|Unlimited automation runs)$/.test(feature)) {
          return now.flowRunsPerMonth === 0 ? null : runsLine(now.flowRunsPerMonth);
        }
        return feature;
      })
      .filter((feature): feature is string => feature !== null);
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
