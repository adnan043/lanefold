import {cleanMetadata, fail, isReturnUrl, num, providerCall, type ProviderResult, QUICK_TIMEOUT_MS, record, str, TIMEOUT_MS} from './http';
import {secretValue, stripeMode, storedPriceProblem} from './keys';
import {cleanCurrency, isAmount} from './money';
import {verifyTimestampedSignature} from './signature';
import type {CheckoutStep, CreatedPrice, Interval, ProviderEvent, StoredPrice, SubscriptionState} from './types';

/**
 * The OWNER's own Stripe account (`docs/agent/payments-providers.md`), through Stripe's REST API with
 * `fetch` (no SDK). STRIPE_SECRET_KEY is read here, per call, and sent only to api.stripe.com; its
 * prefix decides the mode (`keys.ts`). Server only.
 *
 *   createStripePrice()          a Product and its Price, in one call (from the admin)
 *   createStripeCheckout()       a Checkout Session for a STORED price (subscription or one-time)
 *   getStripeCheckout()          confirm it on the thanks page (`paid` only when Stripe says so)
 *   getStripeSubscription()      re-read on every event and when a row needs a re-check
 *   cancelStripeSubscription()   at the period end (default) or now
 *   stripeBillingPortal()        Stripe's page for card, invoices and cancel
 *   verifyStripeWebhook()        `Stripe-Signature` over the RAW body, 5-minute tolerance
 */

const API = 'https://api.stripe.com/v1';

type Fields = Record<string, string | number | boolean | null | undefined>;

/** Stripe's form encoding, nested keys included (`line_items[0][price]`). */
export function stripeForm(fields: Fields): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) params.append(k, String(v));
  return params.toString();
}

async function stripe<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: Fields, idempotencyKey?: string, timeoutMs = TIMEOUT_MS): Promise<ProviderResult<T>> {
  const key = secretValue('STRIPE_SECRET_KEY');
  if (!key || !stripeMode()) return fail(0, 'not_configured');
  const headers: Record<string, string> = {authorization: `Bearer ${key}`};
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey.slice(0, 255);
  const label = `stripe ${method} ${path.split('?')[0]!.replace(/\/(cs|sub|price|prod|cus)_[A-Za-z0-9_]+/g, '/$1_…')}`;
  const res = await providerCall<T & {livemode?: unknown}>(`${API}${path}`, {method, headers, body: body ? stripeForm(body) : undefined}, label, timeoutMs);
  // Stripe says which mode answered: it must be the keys' mode (never a live object read as test).
  if (res.ok && typeof res.data.livemode === 'boolean' && res.data.livemode !== (stripeMode() === 'live')) return fail(502, 'mode_mismatch');
  return res;
}

const ID = /^[a-z]{2,5}_[A-Za-z0-9_]{6,200}$/;
export const isStripeId = (value: unknown, prefix: string): value is string => typeof value === 'string' && ID.test(value) && value.startsWith(`${prefix}_`);

// ---------------------------------------------------------------- prices

export interface NewPrice {
  name: string;
  amountMinor: number;
  currency: string;
  interval: Interval;
  /** Your stable id for this create (the admin's request, `price:<row id>`): a retry makes no second price. */
  idempotencyKey: string;
}

/** A Price with its Product made inline (`product_data`). Store the answer as your `StoredPrice` row. */
export async function createStripePrice(input: NewPrice): Promise<ProviderResult<CreatedPrice>> {
  const currency = cleanCurrency(input.currency);
  const name = input.name?.trim().slice(0, 250);
  if (!currency || !name || !isAmount(input.amountMinor) || !input.idempotencyKey) return fail(422, 'invalid_input');
  const mode = stripeMode();
  if (!mode) return fail(0, 'not_configured');
  const res = await stripe<{id?: unknown; product?: unknown; unit_amount?: unknown; recurring?: {interval?: unknown} | null}>(
    'POST',
    '/prices',
    {
      currency: currency.toLowerCase(),
      unit_amount: input.amountMinor,
      'recurring[interval]': input.interval === 'one_time' ? undefined : input.interval,
      'product_data[name]': name,
    },
    input.idempotencyKey
  );
  if (!res.ok) return res;
  const d = res.data;
  const interval = input.interval === 'one_time' ? !d.recurring : d.recurring?.interval === input.interval;
  if (!isStripeId(d.id, 'price') || !isStripeId(d.product, 'prod') || num(d.unit_amount) !== input.amountMinor || !interval) return fail(502, 'bad_response');
  return {
    ok: true,
    data: {provider: 'stripe', mode, providerPriceId: d.id, providerProductId: d.product, amountMinor: input.amountMinor, currency, interval: input.interval},
  };
}

/** Stops a price from being used for new checkouts (subscriptions on it carry on). */
export const archiveStripePrice = (priceId: string) =>
  isStripeId(priceId, 'price') ? stripe<{id?: unknown}>('POST', `/prices/${encodeURIComponent(priceId)}`, {active: false}) : Promise.resolve(fail(422, 'invalid_input'));

// ---------------------------------------------------------------- checkout

export interface StripeCheckoutInput {
  /** The row your admin stored. Its amount is Stripe's: nothing here sends an amount. */
  price: StoredPrice;
  /** Your own id for this purchase (your checkout or order row): comes back on the session and the subscription. */
  ref: string;
  /** Absolute URLs on this site. `session_id={CHECKOUT_SESSION_ID}` is added to the success URL. */
  successUrl: string;
  cancelUrl: string;
  /** The buyer's own email, or their Stripe customer when they bought before. */
  email?: string | null;
  customerId?: string | null;
  quantity?: number;
  /** Your stable id for this attempt (`checkout:<ref>`), never random per try. */
  idempotencyKey: string;
}

function withSessionId(url: string): string {
  if (url.includes('{CHECKOUT_SESSION_ID}')) return url;
  // Not URL-encoded: Stripe replaces the literal braces.
  const hashAt = url.indexOf('#');
  const [base, hash] = hashAt === -1 ? [url, ''] : [url.slice(0, hashAt), url.slice(hashAt)];
  return `${base}${base.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}${hash}`;
}

/** A Checkout Session (Stripe's own page): open `step` with `openCheckout()`, or send the buyer to `url`. */
export async function createStripeCheckout(
  input: StripeCheckoutInput
): Promise<ProviderResult<{sessionId: string; url: string; step: CheckoutStep}>> {
  const problem = storedPriceProblem(input.price, 'stripe');
  if (problem) return fail(problem === 'not_configured' ? 0 : 422, problem);
  if (!isStripeId(input.price.providerPriceId, 'price') || !isReturnUrl(input.successUrl) || !isReturnUrl(input.cancelUrl)) return fail(422, 'invalid_input');
  if (!input.ref || input.ref.length > 200 || !input.idempotencyKey) return fail(422, 'invalid_input');
  const quantity = Number.isInteger(input.quantity) && input.quantity! >= 1 && input.quantity! <= 99 ? input.quantity! : 1;
  const recurring = input.price.interval !== 'one_time';
  const customer = input.customerId && isStripeId(input.customerId, 'cus') ? input.customerId : null;
  const meta = cleanMetadata({ref: input.ref});
  const fields: Fields = {
    mode: recurring ? 'subscription' : 'payment',
    'line_items[0][price]': input.price.providerPriceId,
    'line_items[0][quantity]': quantity,
    success_url: withSessionId(input.successUrl),
    cancel_url: input.cancelUrl,
    client_reference_id: input.ref,
    customer: customer,
    customer_email: customer ? undefined : input.email?.trim() || undefined,
    'metadata[ref]': meta.ref,
  };
  if (recurring) fields['subscription_data[metadata][ref]'] = meta.ref;
  else fields['payment_intent_data[metadata][ref]'] = meta.ref;
  const res = await stripe<{id?: unknown; url?: unknown}>('POST', '/checkout/sessions', fields, input.idempotencyKey);
  if (!res.ok) return res;
  const url = str(res.data.url);
  if (!isStripeId(res.data.id, 'cs') || !url?.startsWith('https://')) return fail(502, 'bad_response');
  return {ok: true, data: {sessionId: res.data.id, url, step: {kind: 'window', gateway: 'stripe', checkoutUrl: url, returnUrl: input.successUrl, cancelUrl: input.cancelUrl}}};
}

export interface StripeCheckoutState {
  sessionId: string;
  /** `paid` only when Stripe says the payment went through (or a subscription's first one, or its trial started). */
  status: 'paid' | 'open' | 'expired';
  ref: string | null;
  mode: 'subscription' | 'payment' | null;
  customerId: string | null;
  subscription: SubscriptionState | null;
  paymentIntentId: string | null;
}

/** The thanks page's confirm: read the session (and its subscription) from Stripe. */
export async function getStripeCheckout(sessionId: string): Promise<ProviderResult<StripeCheckoutState>> {
  if (!isStripeId(sessionId, 'cs')) return fail(422, 'invalid_input');
  const res = await stripe<Record<string, unknown>>('GET', `/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`);
  if (!res.ok) return res;
  const d = res.data;
  const sub = record(d.subscription);
  const paid = d.status === 'complete' && (d.payment_status === 'paid' || d.payment_status === 'no_payment_required');
  return {
    ok: true,
    data: {
      sessionId,
      status: paid ? 'paid' : d.status === 'expired' ? 'expired' : 'open',
      ref: str(d.client_reference_id) ?? str(record(d.metadata)?.ref),
      mode: d.mode === 'subscription' || d.mode === 'payment' ? d.mode : null,
      customerId: str(d.customer),
      subscription: sub ? stripeSubscriptionState(sub) : null,
      paymentIntentId: str(d.payment_intent),
    },
  };
}

// ---------------------------------------------------------------- subscriptions

const at = (seconds: number | null) => (seconds ? new Date(seconds * 1000) : null);

/**
 * A Stripe subscription as the site keeps it. `active` / `trialing` renew; one set to cancel at the
 * period end is `canceled` with access to that end; unpaid, paused or expired ones end now;
 * `incomplete` (first payment not through) opens nothing.
 */
export function stripeSubscriptionState(sub: Record<string, unknown>, now = new Date()): SubscriptionState | null {
  if (!isStripeId(sub.id, 'sub')) return null;
  const items = record(sub.items)?.data as Record<string, unknown>[] | undefined;
  const item = Array.isArray(items) ? record(items[0]) : null;
  // API versions from 2025 keep the period on the item; older ones on the subscription.
  const periodEnd = at(num(sub.current_period_end) ?? num(item?.current_period_end));
  const ending = sub.cancel_at_period_end === true || num(sub.cancel_at) !== null;
  let status: SubscriptionState['status'];
  let accessEndsAt: Date | null = null;
  switch (sub.status) {
    case 'active':
    case 'trialing':
      if (ending) {
        status = 'canceled';
        accessEndsAt = at(num(sub.cancel_at)) ?? periodEnd;
      } else status = sub.status;
      break;
    case 'past_due':
      status = 'past_due';
      break;
    case 'canceled':
      status = 'canceled';
      accessEndsAt = at(num(sub.ended_at)) ?? now;
      break;
    case 'unpaid':
    case 'paused':
    case 'incomplete_expired':
      status = 'canceled';
      accessEndsAt = now;
      break;
    default:
      status = 'incomplete';
  }
  return {
    provider: 'stripe',
    id: sub.id,
    status,
    currentPeriodEnd: periodEnd,
    accessEndsAt,
    priceId: str(record(item?.price)?.id),
    customerId: str(sub.customer),
    ref: str(record(sub.metadata)?.ref),
    mode: typeof sub.livemode === 'boolean' ? (sub.livemode ? 'live' : 'test') : null,
  };
}

/** The subscription as Stripe has it now (the webhook's and the access re-read: 4 s at most). */
export async function getStripeSubscription(id: string): Promise<ProviderResult<SubscriptionState>> {
  if (!isStripeId(id, 'sub')) return fail(422, 'invalid_input');
  const res = await stripe<Record<string, unknown>>('GET', `/subscriptions/${encodeURIComponent(id)}`, undefined, undefined, QUICK_TIMEOUT_MS);
  if (!res.ok) return res;
  const state = stripeSubscriptionState(res.data);
  return state ? {ok: true, data: state} : fail(502, 'bad_response');
}

/** Cancel at the end of the paid period (default: access lasts to it), or now. */
export async function cancelStripeSubscription(id: string, {atPeriodEnd = true}: {atPeriodEnd?: boolean} = {}): Promise<ProviderResult<SubscriptionState>> {
  if (!isStripeId(id, 'sub')) return fail(422, 'invalid_input');
  const res = atPeriodEnd
    ? await stripe<Record<string, unknown>>('POST', `/subscriptions/${encodeURIComponent(id)}`, {cancel_at_period_end: true}, `cancel:${id}:end`)
    : await stripe<Record<string, unknown>>('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
  if (!res.ok) return res;
  const state = stripeSubscriptionState(res.data);
  return state ? {ok: true, data: state} : fail(502, 'bad_response');
}

/** Stripe's Billing Portal for the buyer's own customer (card, invoices, cancel). Send them to `url`. */
export async function stripeBillingPortal(customerId: string, returnUrl: string): Promise<ProviderResult<{url: string}>> {
  if (!isStripeId(customerId, 'cus') || !isReturnUrl(returnUrl)) return fail(422, 'invalid_input');
  const res = await stripe<{url?: unknown}>('POST', '/billing_portal/sessions', {customer: customerId, return_url: returnUrl});
  if (!res.ok) return res;
  const url = str(res.data.url);
  return url?.startsWith('https://') ? {ok: true, data: {url}} : fail(502, 'bad_response');
}

// ---------------------------------------------------------------- webhooks

/**
 * The webhook route's first step: `Stripe-Signature` checked against STRIPE_WEBHOOK_SECRET over the
 * RAW body (`await c.req.text()`, before any parse), within 5 minutes, in constant time. Null when
 * anything is wrong: answer 400. An event whose `mode` isn't `stripeMode()` belongs to the other copy
 * of the site (sandbox vs live): answer 200 and do nothing.
 */
export async function verifyStripeWebhook(rawBody: string, signature: string | null | undefined, {nowSeconds}: {nowSeconds?: number} = {}): Promise<ProviderEvent | null> {
  const secret = secretValue('STRIPE_WEBHOOK_SECRET');
  if (!(await verifyTimestampedSignature(rawBody, signature, secret, nowSeconds === undefined ? {} : {nowSeconds}))) return null;
  let event: Record<string, unknown> | null;
  try {
    event = record(JSON.parse(rawBody));
  } catch {
    return null;
  }
  if (!event || !isStripeId(event.id, 'evt') || typeof event.type !== 'string') return null;
  const object = record(record(event.data)?.object);
  return {
    id: event.id,
    type: event.type.slice(0, 100),
    objectId: str(object?.id),
    mode: typeof event.livemode === 'boolean' ? (event.livemode ? 'live' : 'test') : null,
    object,
  };
}

