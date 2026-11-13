import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import type {Viewer} from '../../lib/types';
import {cookieName, CSRF_COOKIE, readCookie} from '../../platform/auth/cookies';
import {getDb} from '../../platform/db';
import {formCsrf, problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {
  cancelMembership,
  type Checkout,
  checkoutAttemptKey,
  createCheckout,
  getCheckout,
  isSitePath,
  listGateways,
  membershipOf,
  type PaymentEventInfo,
} from '../../platform/payments';
import {softLimited} from '../soft-limit';
import {membership} from '../workspaces';
import {applyWorkspacePlan, paymentHooks, recordMembership} from '../payments-hooks';

/**
 * Payments, the site's side (docs/agent/payments.md).
 *
 *   POST /site-api/checkout          start a checkout for a price key. JSON (the Buy button's
 *                                    script, the dashboard) → {id, redirectUrl, embedded};
 *                                    a plain form post (no JavaScript) → 303 to the same place.
 *                                    Several ways to pay and none chosen → `redirectUrl` is the
 *                                    checkout page's chooser (`/checkout/?price=…`); the buyer
 *                                    already had the price's free trial (409) → the same page,
 *                                    asking to continue without it (`noTrial`).
 *   GET  /site-api/checkout/gateways?price=   the ways to pay that price ({gateways})
 *   GET  /site-api/checkout/:id      what happened, for the thanks page; records a paid checkout
 *                                    through the hooks (the Preview gets no events).
 *   GET  /site-api/memberships       the signed-in member's memberships
 *   POST /site-api/memberships/:id/cancel   {atPeriodEnd?} cancel one of them
 *
 * `checkoutRoutes` is mounted BEFORE `csrf` in app.ts (with `formCsrf`), so the Buy button works
 * without JavaScript; `membershipRoutes` after it, like every other route.
 */

/** Where an embedded checkout's payment form is shown (`src/pages/checkout/index.astro`). */
const CHECKOUT_PAGE = '/checkout/';
const PRICE_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const GATEWAY = /^[a-z0-9_-]{1,40}$/;
const ATTEMPT_KEY = /^[A-Za-z0-9_-]{16,64}$/;

type CheckoutForm = {
  price: string;
  quantity: number;
  successPath: string;
  cancelPath: string;
  email?: string;
  metadata?: Record<string, string>;
  gateway?: string;
  noTrial: boolean;
  idempotencyKey?: string;
};

const isForm = (type: string | undefined) =>
  Boolean(type?.startsWith('application/x-www-form-urlencoded') || type?.startsWith('multipart/form-data'));

/** JSON or a form post, checked field by field. Never an amount: the catalogue decides it. */
const checkoutBody = createMiddleware<{Variables: {input: CheckoutForm; form: boolean}}>(async (c, next) => {
  const form = isForm(c.req.header('content-type'));
  let raw: Record<string, unknown>;
  try {
    raw = form ? ((await c.req.parseBody()) as Record<string, unknown>) : ((await c.req.json()) as Record<string, unknown>);
  } catch {
    return c.json(problem('invalid_input', 'That request could not be read.'), 400);
  }
  if (!raw || typeof raw !== 'object') return c.json(problem('invalid_input', 'That request could not be read.'), 400);
  const price = typeof raw.price === 'string' ? raw.price.trim() : '';
  const quantity = raw.quantity === undefined || raw.quantity === '' ? 1 : Number(raw.quantity);
  const successPath = typeof raw.successPath === 'string' && raw.successPath ? raw.successPath : '/thanks/';
  const cancelPath = typeof raw.cancelPath === 'string' && raw.cancelPath ? raw.cancelPath : '/';
  const email = typeof raw.email === 'string' && raw.email.trim() ? raw.email.trim().toLowerCase() : undefined;
  const gateway = typeof raw.gateway === 'string' && raw.gateway.trim() ? raw.gateway.trim() : undefined;
  const noTrial = raw.noTrial === true || raw.noTrial === '1' || raw.noTrial === 'true';
  const sentKey = typeof raw.idempotencyKey === 'string' ? raw.idempotencyKey : c.req.header('idempotency-key');
  const idempotencyKey = sentKey?.trim() || undefined;
  const fields: Record<string, string> = {};
  if (idempotencyKey !== undefined && !ATTEMPT_KEY.test(idempotencyKey)) fields.price = 'Start the purchase again.';
  if (gateway !== undefined && !GATEWAY.test(gateway)) fields.gateway = 'Choose a way to pay.';
  if (!PRICE_KEY.test(price)) fields.price = 'Choose something to buy.';
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) fields.quantity = 'Choose a quantity from 1 to 99.';
  if (!isSitePath(successPath) || !isSitePath(cancelPath)) fields.price = 'This button points outside the site.';
  if (email !== undefined && !EMAIL.test(email)) fields.email = 'Enter an email address like name@example.com.';
  let metadata: Record<string, string> | undefined;
  if (!form && raw.metadata !== undefined) {
    const pairs = raw.metadata && typeof raw.metadata === 'object' ? Object.entries(raw.metadata) : null;
    if (!pairs || pairs.length > 20 || pairs.some(([k, v]) => typeof v !== 'string' || k.length > 40 || v.length > 500)) {
      fields.metadata = 'Notes are up to 20 short text pairs.';
    } else {
      // `workspaceId` and `plan` name a workspace's plan checkout (set only by routes/billing.ts, read by the refund hook): never the browser's.
      metadata = Object.fromEntries(pairs.filter(([k]) => k !== 'workspaceId' && k !== 'plan')) as Record<string, string>;
    }
  }
  if (Object.keys(fields).length) {
    return c.json({...problem('invalid_input', Object.values(fields)[0]!), fields}, 422);
  }
  c.set('input', {price, quantity, successPath, cancelPath, email, metadata, gateway, noTrial, idempotencyKey});
  c.set('form', form);
  await next();
});

/** What the browser may see of a checkout (no email, no metadata, no customer reference). */
const publicCheckout = (checkout: Checkout) => ({
  id: checkout.id,
  mode: checkout.mode,
  status: checkout.status,
  price: checkout.price,
  quantity: checkout.quantity,
  amountCents: checkout.amountCents,
  currency: checkout.currency,
  paidAt: checkout.paidAt,
  subscription: checkout.subscription
    ? {
        status: checkout.subscription.status,
        currentPeriodEnd: checkout.subscription.currentPeriodEnd,
        accessEndsAt: checkout.subscription.accessEndsAt,
      }
    : null,
  embedded: checkout.status === 'open' ? (checkout.embedded ?? null) : null,
});

const CHECKOUT_ID = /^pcs_[A-Za-z0-9]{8,64}$/;

/** The checkout page that asks the buyer something first: which way to pay, or "without the trial". */
function askPage(input: CheckoutForm, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    price: input.price,
    quantity: String(input.quantity),
    successPath: input.successPath,
    cancelPath: input.cancelPath,
    ...(input.email ? {email: input.email} : {}),
    ...extra,
  });
  return `${CHECKOUT_PAGE}?${q.toString()}`;
}

export const checkoutRoutes = new Hono()
  .use(bodyLimit({maxSize: 8 * 1024, onError: c => c.json(problem('too_large', 'That request is too large.'), 413)}))
  .use(formCsrf)

  .post('/', checkoutBody, withViewer, async c => {
    const input = c.var.input;
    const viewer: Viewer = c.var.viewer;
    const signedIn = viewer.state === 'user' && viewer.id !== null;
    const answer = (redirectUrl: string, status: 200 | 409 = 200, extra: Record<string, unknown> = {}) => {
      c.header('Cache-Control', 'private, no-store');
      if (c.var.form) return c.redirect(redirectUrl, 303);
      return c.json({redirectUrl, ...extra}, status);
    };
    // Plans are sold ONLY through the workspace route (`POST /workspaces/:id/billing/checkout`): a plan's price key
    // here would charge without ever naming a workspace.
    if (signedIn && (await softLimited(viewer.id!, 'checkout-start', 20, 600))) {
      if (c.var.form) return c.redirect(`${CHECKOUT_PAGE}?error=E_RATE_LIMITED`, 303);
      c.header('Retry-After', '60');
      return c.json(problem('rate_limited', 'Too many checkout attempts. Wait a few minutes and try again.'), 429);
    }
    const planPrice = await getDb()?.planLimit.findFirst({where: {priceKeyMonthly: input.price}, select: {plan: true}});
    if (planPrice) {
      if (c.var.form) return c.redirect(`${CHECKOUT_PAGE}?error=E_PRICE_NOT_FOUND`, 303);
      return c.json(problem('e_price_not_found', 'That price cannot be bought here.'), 404);
    }
    // Several ways to pay this price and none chosen yet: the buyer chooses on the checkout page.
    let gateway = input.gateway;
    if (!gateway) {
      const ways = await listGateways(c.req.url, input.price);
      if (ways.ok && ways.data.length > 1) return answer(askPage(input), 200, {choose: true});
      if (ways.ok && ways.data.length === 1) gateway = ways.data[0]!.slug;
    }
    // The script sends one key per attempt. A plain form post has none: a resend of it within 2
    // minutes, from this browser, is the same attempt.
    const visitor = readCookie(c.req.header('cookie'), cookieName(CSRF_COOKIE, c.req.url));
    const idempotencyKey =
      input.idempotencyKey ??
      (!signedIn && visitor
        ? await checkoutAttemptKey([visitor, input.price, input.quantity, gateway ?? null, input.noTrial, input.email ?? null])
        : undefined);
    const started = await createCheckout(c.req.url, {
      price: input.price,
      quantity: input.quantity,
      successPath: input.successPath,
      cancelPath: input.cancelPath,
      metadata: input.metadata,
      ...(gateway ? {gateway} : {}),
      ...(input.noTrial ? {noTrial: true} : {}),
      ...(idempotencyKey ? {idempotencyKey} : {}),
      // A signed-in buyer pays as themselves: their own address, their id as the reference.
      ...(signedIn
        ? {email: viewer.email || undefined, name: viewer.name ?? undefined, customerRef: String(viewer.id)}
        : {email: input.email}),
    });
    if (!started.ok && started.code === 'E_SITE_PAYMENTS_TRIAL_USED') {
      // The buyer decides whether to pay now without the trial.
      return answer(askPage(input, {...(gateway ? {gateway} : {}), trialUsed: '1'}), 409, {
        code: 'E_SITE_PAYMENTS_TRIAL_USED',
        message: "You've already used the free trial for this. Continue to pay now without a trial.",
      });
    }
    if (!started.ok) {
      const status =
        started.status === 404 ? 404 : started.status === 409 ? 409 : started.status === 422 ? 422 : started.status === 0 ? 503 : 502;
      if (c.var.form) return c.redirect(`${CHECKOUT_PAGE}?error=${encodeURIComponent(started.code)}`, 303);
      return c.json(problem(started.code.toLowerCase(), started.message), status);
    }
    const {id, mode, embedded, paid} = started.data;
    if (paid) {
      // Already paid under this key: the thanks page, nothing new.
      const sep = input.successPath.includes('?') ? '&' : '?';
      return answer(`${input.successPath}${sep}checkout=${encodeURIComponent(id)}`, 200, {id, mode, paid: true});
    }
    return answer(`${CHECKOUT_PAGE}?id=${encodeURIComponent(id)}`, 200, {id, mode, embedded: embedded ?? null});
  })

  .get('/gateways', validator('query', value => ({price: typeof value.price === 'string' ? value.price : ''})), async c => {
    const {price} = c.req.valid('query');
    if (!PRICE_KEY.test(price)) return c.json(problem('invalid_input', 'Choose something to buy.'), 422);
    const ways = await listGateways(c.req.url, price);
    if (!ways.ok) return c.json(problem('payments_unavailable', ways.message), ways.status === 404 ? 404 : 503);
    c.header('Cache-Control', 'private, no-store');
    return c.json({gateways: ways.data});
  })

  .get('/:id', async c => {
    const id = c.req.param('id');
    if (!CHECKOUT_ID.test(id)) return c.json(problem('not_found', 'No such checkout.'), 404);
    const found = await getCheckout(c.req.url, id);
    if (!found.ok) {
      if (found.status === 404) return c.json(problem('not_found', 'No such checkout.'), 404);
      return c.json(problem('payments_unavailable', found.message), 503);
    }
    const checkout = found.data;
    let recorded = true;
    if (checkout.status === 'paid') {
      // The confirm: the Preview gets no events, and a live event may still be on its way.
      const event: PaymentEventInfo = {
        id: `confirm_${checkout.id}`,
        type: 'checkout.paid',
        mode: checkout.mode,
        // The payment's own time (never "now"): a real platform event older than this confirm is still applied.
        createdAt: checkout.paidAt ?? '',
        source: 'confirm',
      };
      try {
        await paymentHooks.onCheckoutPaid?.(checkout, event);
        const membership = membershipOf(checkout);
        if (membership) await paymentHooks.onMembershipChanged?.(membership, {...event, type: 'membership.started'});
      } catch (error) {
        // The payment stands, but it is not recorded yet: the thanks page says to check again (the live event retries too).
        recorded = false;
        console.error(`[payments] confirm ${checkout.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500));
      }
    }
    c.header('Cache-Control', 'private, no-store');
    return c.json({checkout: publicCheckout(checkout), recorded});
  });

const memberSelect = {
  subscriptionId: true,
  priceKey: true,
  mode: true,
  status: true,
  currentPeriodEnd: true,
  accessEndsAt: true,
  workspaceId: true,
} as const;

/**
 * The member's own rows: bought signed in, or with their VERIFIED address, plus the plans of every workspace the
 * visitor CURRENTLY owns or administers (the buyer may have left; the owner must still see and stop the billing).
 * An archived workspace counts for its owner only (it is closed to everyone else).
 */
async function visibleTo(db: PrismaClient, viewer: Viewer) {
  const admins = await db.workspaceMember.findMany({
    where: {userId: viewer.id!, role: {in: ['owner', 'admin']}},
    select: {workspaceId: true, role: true, workspace: {select: {archivedAt: true}}},
    take: 50,
  });
  const workspaceIds = admins.filter(row => row.workspace.archivedAt === null || row.role === 'owner').map(row => row.workspaceId);
  return {
    OR: [
      // Own rows of a workspace's plan only while still an admin or owner there (the cancel route's rule): the
      // workspace clause below covers those; a removed or demoted buyer sees (and can stop) nothing of it.
      {userId: viewer.id!, workspaceId: null},
      ...(viewer.email && viewer.emailVerified ? [{email: viewer.email.toLowerCase(), workspaceId: null}] : []),
      ...(workspaceIds.length ? [{workspaceId: {in: workspaceIds}}] : []),
    ],
  };
}

const cancelBody = validator('json', value => ({atPeriodEnd: (value as {atPeriodEnd?: unknown})?.atPeriodEnd !== false}));

export const membershipRoutes = new Hono()
  .get('/', withViewer, requireAuth, withDb, async c => {
    const rows = await c.var.db.membership.findMany({where: await visibleTo(c.var.db, c.var.viewer), select: memberSelect, orderBy: {id: 'desc'}, take: 20});
    const ids = [...new Set(rows.flatMap(row => (row.workspaceId ? [row.workspaceId] : [])))];
    const names = new Map(
      ids.length ? (await c.var.db.workspace.findMany({where: {id: {in: ids}}, select: {id: true, name: true}, take: 20})).map(w => [w.id, w.name] as const) : [],
    );
    c.header('Cache-Control', 'private, no-store');
    return c.json({
      memberships: rows.map(row => ({
        ...row,
        workspaceName: row.workspaceId ? (names.get(row.workspaceId) ?? null) : null,
        currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
        accessEndsAt: row.accessEndsAt?.toISOString() ?? null,
      })),
    });
  })

  .post('/:id/cancel', cancelBody, withViewer, requireAuth, withDb, async c => {
    const subscriptionId = c.req.param('id');
    const mine = await c.var.db.membership.findFirst({
      where: {subscriptionId, ...(await visibleTo(c.var.db, c.var.viewer))},
      select: {subscriptionId: true, mode: true, workspaceId: true, userId: true},
    });
    if (!mine) return c.json(problem('not_found', 'No such membership.'), 404);
    // A workspace's plan is cancelled by its owner, or by the buyer while still an admin there. Another admin
    // (who can see the plan) must not end what the owner pays for: the owner is king.
    if (mine.workspaceId) {
      const member = await membership(c.var.db, mine.workspaceId, c.var.viewer.id!);
      let allowed = member !== null && (member.role === 'owner' || (member.rank >= 3 && mine.userId === c.var.viewer.id));
      if (!member) {
        // An ARCHIVED workspace is closed to everyone (membership() is null), but its owner must still be able to stop paying.
        const owner = await c.var.db.workspaceMember.findFirst({
          where: {workspaceId: mine.workspaceId, userId: c.var.viewer.id!, role: 'owner', workspace: {archivedAt: {not: null}}},
          select: {userId: true},
        });
        allowed = owner !== null;
      }
      if (!allowed) return c.json(problem('not_found', 'No such membership.'), 404);
    }
    const done = await cancelMembership(c.req.url, mine.subscriptionId, c.req.valid('json').atPeriodEnd);
    if (!done.ok) return c.json(problem(done.code.toLowerCase(), done.message), done.status === 404 ? 404 : 502);
    await recordMembership(done.data, mine.mode);
    // An immediate cancel ends access now: the workspace falls back to free without waiting for an event.
    await applyWorkspacePlan(done.data);
    return c.json({ok: true, accessEndsAt: done.data.accessEndsAt});
  });
