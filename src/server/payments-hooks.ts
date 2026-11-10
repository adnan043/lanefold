import {audit} from '../platform/auth';
import {config} from '../platform/config';
import {getDb} from '../platform/db';
import {cancelMembership, type Checkout, definePaymentHooks, grantsAccess, type PlatformMembership, type Refund} from '../platform/payments';
import {startGraceForOverLimit} from './entitlements';

/**
 * What this site does when money moves (docs/agent/payments.md). YOURS to change.
 *
 * Called with the platform's signed payment events (the live site) and by the thanks page's
 * confirm (`GET /site-api/checkout/:id`, everywhere, the Preview too). So a hook can run MORE THAN
 * ONCE for one payment: the defaults below upsert and say whether the row is new (`created`). Do
 * one-time work (a welcome email, a stock change) only when it is: `if (created) { … }`.
 *
 * Throw to have the event tried again later (1 min, 2 min, 10 min, 1 h). Keep each hook short:
 * slow work goes in a background job (`sendJob`, docs/agent/background-jobs.md).
 */

/**
 * `customerRef` is `<userId>` (the default checkout) or `<userId>:<workspaceId>` (a workspace's plan
 * checkout, set only by `routes/billing.ts`).
 */
export const refParts = (ref: string | null | undefined): [number | null, number | null] => {
  const [user, workspace] = (ref ?? '').split(':');
  const id = (part: string | undefined) => {
    const n = Number(part);
    return part && /^\d{1,10}$/.test(part) && Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  return [id(user), id(workspace)];
};
const userIdOf = (ref: string | null | undefined): number | null => refParts(ref)[0];
const dateOf = (value: string | null | undefined): Date | null => (value ? new Date(value) : null);

function database() {
  const db = getDb();
  // No Site Database: throwing makes the platform try again once there is one.
  if (!db) throw new Error('No Site Database: the payment is kept by the platform and sent again.');
  return db;
}

/** Records a paid checkout once. `created` is true the first time. */
export async function recordOrder(checkout: Checkout, status: 'paid' | 'failed'): Promise<{created: boolean}> {
  const db = database();
  const data = {
    priceKey: checkout.price,
    mode: checkout.mode,
    email: checkout.email?.toLowerCase() ?? null,
    userId: userIdOf(checkout.customerRef),
    quantity: checkout.quantity,
    amountCents: checkout.amountCents,
    currency: checkout.currency,
    metadata: checkout.metadata ?? {},
    paidAt: dateOf(checkout.paidAt),
  };
  const found = await db.order.findUnique({where: {checkoutId: checkout.id}, select: {id: true, status: true}});
  if (found) {
    // Never move a refunded order back to paid, or a paid one to failed.
    if (found.status === 'failed' && status === 'paid') await db.order.update({where: {id: found.id}, data: {...data, status}});
    return {created: false};
  }
  try {
    await db.order.create({data: {checkoutId: checkout.id, status, ...data}});
    return {created: true};
  } catch (error) {
    // P2002: the event and the confirm arrived together; the other one wrote it.
    if ((error as {code?: unknown} | null)?.code === 'P2002') return {created: false};
    throw error;
  }
}

/**
 * Keeps the site's copy of one membership in step. `created` is true the first time; `stale` is true when the
 * event is older than the newest one already applied (nothing was written: do not apply the plan either).
 * `eventAt` is the event's own time (the platform event's `createdAt`, or a confirm's `paidAt`). Without it (the
 * cancel route holds fresh state but no timestamp) the row is written unconditionally and `lastEventAt` is left
 * as it is, so an older real platform event is never dropped as stale because of a "now" we invented.
 * `userId`, `email` and `workspaceId` are written only when the event carries them (never blanked).
 */
export async function recordMembership(membership: PlatformMembership, mode: string, eventAt?: string | null): Promise<{created: boolean; stale: boolean}> {
  const db = database();
  const parsed = eventAt ? new Date(eventAt) : null;
  const at = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  const workspaceId = refParts(membership.customerRef)[1];
  const userId = userIdOf(membership.customerRef);
  const email = membership.email?.toLowerCase() ?? null;
  const data = {
    priceKey: membership.price,
    mode,
    ...(email ? {email} : {}),
    ...(userId ? {userId} : {}),
    ...(workspaceId ? {workspaceId} : {}),
    status: membership.status,
    currentPeriodEnd: dateOf(membership.currentPeriodEnd),
    accessEndsAt: dateOf(membership.accessEndsAt),
    ...(at ? {lastEventAt: at} : {}),
  };
  // One conditional write: a newer (or equal) event wins, an older one changes nothing.
  const write = async (where: {id: number} | {subscriptionId: string}) => {
    const {count} = await db.membership.updateMany({
      where: at ? {...where, OR: [{lastEventAt: null}, {lastEventAt: {lte: at}}]} : where,
      data,
    });
    return {created: false, stale: count === 0};
  };
  const found = await db.membership.findUnique({where: {subscriptionId: membership.id}, select: {id: true}});
  if (found) return write({id: found.id});
  try {
    await db.membership.create({data: {subscriptionId: membership.id, ...data}});
    return {created: true, stale: false};
  } catch (error) {
    if ((error as {code?: unknown} | null)?.code === 'P2002') return write({subscriptionId: membership.id});
    throw error;
  }
}

/**
 * A workspace's plan follows its subscriptions: it is the HIGHEST plan (by `plan_limits.storage_quota_bytes`) among
 * ALL memberships of the workspace that still grant access (the event's own one counts by its status), never the
 * plan of the event's price alone. So a late event of a lower plan cannot flip an upgrade back, and an ended old
 * subscription never undoes a newer one. With no granting membership the plan falls to `free`, but only when the
 * workspace is still on the event's plan (a plan set another way stays). Idempotent: nothing changes when the plan
 * is already right. Nothing is deleted: a workspace over its new limits gets the grace clock.
 */
export async function applyWorkspacePlan(membership: PlatformMembership): Promise<{changed: boolean}> {
  const workspaceId = refParts(membership.customerRef)[1];
  if (!workspaceId) return {changed: false};
  const db = database();
  const [bought, workspace, others] = await Promise.all([
    db.planLimit.findFirst({where: {priceKeyMonthly: membership.price}, select: {plan: true, storageQuotaBytes: true}}),
    db.workspace.findUnique({where: {id: workspaceId}, select: {plan: true}}),
    // Same predicate as the daily sweep; the highest plan among the OTHER memberships that still give access.
    db.$queryRaw<{plan: string; storage: bigint}[]>`
      SELECT p.plan AS plan, p.storage_quota_bytes AS storage
      FROM memberships m JOIN plan_limits p ON p.price_key_monthly = m.price_key
      WHERE m.workspace_id = ${workspaceId} AND m.subscription_id <> ${membership.id}
        AND (m.status IN ('active', 'trialing', 'past_due') OR m.access_ends_at > now())
      ORDER BY p.storage_quota_bytes DESC
      LIMIT 1`,
  ]);
  if (!bought || !workspace) return {changed: false};
  const grants = grantsAccess(membership.status, membership.accessEndsAt);
  const candidates = [...(grants ? [{plan: bought.plan, storage: bought.storageQuotaBytes}] : []), ...others];
  const best = candidates.reduce<{plan: string; storage: bigint} | null>((top, c) => (!top || c.storage > top.storage ? c : top), null);
  const target = best ? best.plan : workspace.plan === bought.plan ? 'free' : workspace.plan;
  if (target === workspace.plan) {
    // Idempotent: a retry after a failed grace start (or an audit) still starts the clock when over the limits.
    await startGraceForOverLimit(db, {workspaceId});
    return {changed: false};
  }
  const limits = await db.planLimit.findUnique({where: {plan: target}, select: {maxMembers: true}});
  if (!limits) return {changed: false};
  // Conditional on the plan we read: two events at once change it once.
  const {count} = await db.workspace.updateMany({where: {id: workspaceId, plan: workspace.plan}, data: {plan: target, memberLimit: limits.maxMembers}});
  if (!count) return {changed: false};
  await startGraceForOverLimit(db, {workspaceId});
  await audit(db, {actorUserId: null, action: 'workspace.plan_changed', target: ['workspace', workspaceId], meta: {from: workspace.plan, to: target}});
  return {changed: true};
}

const platformUrl = () => config.siteUrl ?? 'http://localhost';

/**
 * After an upgrade is paid (a membership that just started or renewed on a bigger plan), stops the workspace's OTHER
 * lower-plan subscriptions from billing again: cancelled AT PERIOD END (payments.md's default: what was already paid
 * stays valid, nothing renews, no double billing). `applyWorkspacePlan` already keeps the higher plan meanwhile.
 * Throws when the platform fails (not for "already gone") so the event is tried again; idempotent.
 */
export async function cancelSupersededMemberships(membership: PlatformMembership): Promise<number> {
  const workspaceId = refParts(membership.customerRef)[1];
  if (!workspaceId || (membership.status !== 'active' && membership.status !== 'trialing')) return 0;
  const db = database();
  const lower = await db.$queryRaw<{id: string; mode: string}[]>`
    SELECT m.subscription_id AS id, m.mode AS mode
    FROM memberships m JOIN plan_limits p ON p.price_key_monthly = m.price_key
    WHERE m.workspace_id = ${workspaceId} AND m.subscription_id <> ${membership.id}
      AND m.status IN ('active', 'trialing', 'past_due') AND m.access_ends_at IS NULL
      AND p.storage_quota_bytes < (SELECT storage_quota_bytes FROM plan_limits WHERE price_key_monthly = ${membership.price} LIMIT 1)
    LIMIT 5`;
  let cancelled = 0;
  for (const old of lower) {
    const done = await cancelMembership(platformUrl(), old.id, true);
    if (!done.ok) {
      if (done.status === 404) {
        // Gone on the platform: record it ended here too, so it is not tried on every event.
        await db.membership.updateMany({where: {subscriptionId: old.id, accessEndsAt: null}, data: {status: 'canceled', accessEndsAt: new Date()}});
        continue;
      }
      throw new Error(`Could not cancel the replaced plan (${done.code}): tried again later.`);
    }
    await recordMembership(done.data, old.mode);
    cancelled += 1;
  }
  return cancelled;
}

/** A fully refunded plan checkout ends its subscription now (the refund event does not say so itself). */
async function cancelRefundedPlan(order: {priceKey: string; userId: number | null; metadata: unknown}): Promise<void> {
  const raw = (order.metadata as {workspaceId?: unknown} | null)?.workspaceId;
  const workspaceId = typeof raw === 'string' && /^\d{1,10}$/.test(raw) ? Number(raw) : null;
  if (!workspaceId || !order.userId) return;
  const db = database();
  // memberships has no checkout id: cancel only when exactly ONE subscription can be the refunded one (after a
  // double purchase a guess could stop the wrong, still wanted, subscription: an admin cancels it by hand then).
  const candidates = await db.membership.findMany({
    where: {workspaceId, priceKey: order.priceKey, userId: order.userId, status: {in: ['active', 'trialing', 'past_due']}},
    orderBy: {id: 'desc'},
    select: {subscriptionId: true, mode: true},
    take: 2,
  });
  if (candidates.length > 1) {
    console.error(`[payments] refund: several active subscriptions match (workspace ${workspaceId}); none cancelled`);
    return;
  }
  const sub = candidates[0];
  if (!sub) return;
  const done = await cancelMembership(platformUrl(), sub.subscriptionId, false);
  if (!done.ok) {
    if (done.status === 404) return;
    throw new Error(`Could not cancel the refunded plan (${done.code}): tried again later.`);
  }
  await recordMembership(done.data, sub.mode);
  await applyWorkspacePlan(done.data);
}

export const paymentHooks = definePaymentHooks({
  async onCheckoutPaid(checkout) {
    const {created} = await recordOrder(checkout, 'paid');
    if (created) {
      // One-time work for a new order goes here (or send a background job from here).
    }
  },

  async onCheckoutFailed(checkout) {
    await recordOrder(checkout, 'failed');
  },

  async onMembershipChanged(membership, event) {
    const {stale} = await recordMembership(membership, event.mode, event.createdAt);
    // An older event (a retry arriving after a newer one) never changes the plan.
    if (!stale) {
      await applyWorkspacePlan(membership);
      if (event.source === 'confirm') {
        // The thanks-page confirm must not report "not recorded" because the platform could not cancel an old
        // subscription: the writes above stand; the live event (which throws, so it is retried) does the cancel.
        try {
          await cancelSupersededMemberships(membership);
        } catch (error) {
          console.error(`[payments] confirm: replaced plan not cancelled yet (subscription ${membership.id}): ${error instanceof Error ? error.message : 'error'}`.slice(0, 300));
        }
      } else {
        await cancelSupersededMemberships(membership);
      }
    }
  },

  async onRefund(refund: Refund) {
    const db = database();
    const order = await db.order.findUnique({
      where: {checkoutId: refund.checkoutId},
      select: {id: true, priceKey: true, userId: true, metadata: true},
    });
    // The refund came before the payment was recorded: throw so the platform sends it again (1 min, 2 min, 10 min, 1 h).
    if (!order) throw new Error('A refund arrived before its payment was recorded: tried again later.');
    // 'refunded' is final: a later partial event never moves it back; a full refund wins over anything but itself.
    if (refund.full) await db.order.updateMany({where: {id: order.id, status: {not: 'refunded'}}, data: {status: 'refunded'}});
    else await db.order.updateMany({where: {id: order.id, status: 'paid'}, data: {status: 'partially_refunded'}});
    if (refund.full) await cancelRefundedPlan(order);
  },
});
