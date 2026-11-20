import {cleanMetadata, dateOf, fail, isReturnUrl, providerCall, type ProviderResult, QUICK_TIMEOUT_MS, record, str, TIMEOUT_MS} from './http';
import {paypalMode, secretValue, storedPriceProblem} from './keys';
import {cleanCurrency, isAmount, toDecimal} from './money';
import type {CheckoutStep, CreatedPrice, ProviderEvent, StoredPrice, SubscriptionState} from './types';

/**
 * The OWNER's own PayPal account (`docs/agent/payments-providers.md`), through PayPal's REST API with
 * `fetch` (no SDK). Sandbox or live follows PAYPAL_MODE (`keys.ts`); PAYPAL_CLIENT_ID and
 * PAYPAL_CLIENT_SECRET are read here, per call, and sent only to PayPal's API host for that mode.
 * Subscriptions only (a product and a billing plan); a one-time PayPal sale is the Orders API, in
 * your own code, with the amount from your stored price. Server only.
 *
 *   createPaypalPlan()            a product and a monthly or yearly billing plan (from the admin)
 *   createPaypalSubscription()    a subscription for a STORED plan, and the buyer's approval link
 *   getPaypalSubscription()       confirm on the thanks page, re-read on every event
 *   cancelPaypalSubscription()    PayPal cancels now; access lasts to the end of the time paid for
 *   verifyPaypalWebhook()         PayPal's verify-webhook-signature with the RAW event text
 *   paypalTransmissionFresh()     the delivery's transmission time within 5 minutes (checked first)
 */

const HOSTS = {test: 'https://api-m.sandbox.paypal.com', live: 'https://api-m.paypal.com'} as const;

/**
 * OAuth tokens, per isolate, until a minute before they run out. Never logged or returned. While one
 * is being fetched, every caller waits on that ONE fetch (`pending`): never two token requests at once.
 */
const tokens = new Map<string, {token: string; until: number}>();
const pending = new Map<string, Promise<string | null>>();
export const resetPaypalTokensForTests = () => {
  tokens.clear();
  pending.clear();
};

async function token(): Promise<{host: string; token: string} | null> {
  const mode = paypalMode();
  const id = secretValue('PAYPAL_CLIENT_ID');
  const secret = secretValue('PAYPAL_CLIENT_SECRET');
  if (!mode || !id || !secret) return null;
  const host = HOSTS[mode];
  const cacheKey = `${mode}:${id}`;
  const cached = tokens.get(cacheKey);
  if (cached && cached.until > Date.now()) return {host, token: cached.token};
  let inFlight = pending.get(cacheKey);
  if (!inFlight) {
    inFlight = fetchToken(host, id, secret, cacheKey).finally(() => pending.delete(cacheKey));
    pending.set(cacheKey, inFlight);
  }
  const access = await inFlight;
  return access ? {host, token: access} : null;
}

/** One token request (4 s at most: PayPal's token endpoint is quick, and every path waits on it). */
async function fetchToken(host: string, id: string, secret: string, cacheKey: string): Promise<string | null> {
  const res = await providerCall<{access_token?: unknown; expires_in?: unknown}>(
    `${host}/v1/oauth2/token`,
    {
      method: 'POST',
      headers: {authorization: `Basic ${btoa(`${id}:${secret}`)}`, 'content-type': 'application/x-www-form-urlencoded'},
      body: 'grant_type=client_credentials',
    },
    'paypal token',
    QUICK_TIMEOUT_MS
  );
  if (!res.ok) return null;
  const access = str(res.data.access_token);
  if (!access) return null;
  const seconds = typeof res.data.expires_in === 'number' ? res.data.expires_in : 300;
  tokens.set(cacheKey, {token: access, until: Date.now() + Math.max(0, seconds - 60) * 1000});
  return access;
}

/** A request body already serialized: sent as these exact characters (the webhook check's raw event). */
class RawJson {
  constructor(readonly text: string) {}
}

async function paypal<T>(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string, timeoutMs = TIMEOUT_MS): Promise<ProviderResult<T>> {
  const auth = await token();
  if (!auth) return fail(0, 'not_configured');
  const headers: Record<string, string> = {authorization: `Bearer ${auth.token}`, accept: 'application/json'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // PayPal's idempotency key: the same id again returns the first answer.
  if (requestId) headers['paypal-request-id'] = requestId.slice(0, 108);
  const text = body === undefined ? undefined : body instanceof RawJson ? body.text : JSON.stringify(body);
  return providerCall<T>(`${auth.host}${path}`, {method, headers, body: text}, `paypal ${method} ${path.replace(/\/(I|P|PROD)-[A-Z0-9]+/g, '/$1-…')}`, timeoutMs);
}

/** Do the keys get a token (the admin's "Check keys")? Only yes or no, never why. */
export async function paypalKeysWork(): Promise<boolean> {
  resetPaypalTokensForTests();
  return (await token()) !== null;
}

const PAYPAL_ID = /^[A-Z0-9-]{6,64}$/;
export const isPaypalId = (value: unknown, prefix: string): value is string => typeof value === 'string' && PAYPAL_ID.test(value) && value.startsWith(prefix);

// ---------------------------------------------------------------- prices: a product and a billing plan

export interface NewPaypalPlan {
  name: string;
  amountMinor: number;
  currency: string;
  interval: 'month' | 'year';
  /** Your stable id for this create (`price:<row id>`): a retry makes no second product or plan. */
  idempotencyKey: string;
}

export async function createPaypalPlan(input: NewPaypalPlan): Promise<ProviderResult<CreatedPrice>> {
  const currency = cleanCurrency(input.currency);
  const name = input.name?.trim().slice(0, 127);
  if (!currency || !name || !isAmount(input.amountMinor) || (input.interval !== 'month' && input.interval !== 'year') || !input.idempotencyKey) {
    return fail(422, 'invalid_input');
  }
  const mode = paypalMode();
  if (!mode) return fail(0, 'not_configured');
  const product = await paypal<{id?: unknown}>('POST', '/v1/catalogs/products', {name, type: 'DIGITAL', category: 'SOFTWARE'}, `${input.idempotencyKey}-product`);
  if (!product.ok) return product;
  if (!isPaypalId(product.data.id, 'PROD-')) return fail(502, 'bad_response');
  const plan = await paypal<{id?: unknown}>(
    'POST',
    '/v1/billing/plans',
    {
      product_id: product.data.id,
      name,
      status: 'ACTIVE',
      billing_cycles: [
        {
          frequency: {interval_unit: input.interval === 'year' ? 'YEAR' : 'MONTH', interval_count: 1},
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {fixed_price: {value: toDecimal(input.amountMinor, currency), currency_code: currency}},
        },
      ],
      payment_preferences: {auto_bill_outstanding: true, payment_failure_threshold: 1},
    },
    `${input.idempotencyKey}-plan`
  );
  if (!plan.ok) return plan;
  if (!isPaypalId(plan.data.id, 'P-')) return fail(502, 'bad_response');
  return {
    ok: true,
    data: {provider: 'paypal', mode, providerPriceId: plan.data.id, providerProductId: product.data.id, amountMinor: input.amountMinor, currency, interval: input.interval},
  };
}

/** Stops a plan from taking new subscriptions (current ones carry on). */
export const deactivatePaypalPlan = (planId: string) =>
  isPaypalId(planId, 'P-')
    ? paypal<Record<string, never>>('POST', `/v1/billing/plans/${encodeURIComponent(planId)}/deactivate`, {})
    : Promise.resolve(fail(422, 'invalid_input'));

// ---------------------------------------------------------------- subscriptions

/**
 * A PayPal subscription as the site keeps it. `ACTIVE` → active (renews at the next billing time);
 * `SUSPENDED` (payments stopped) and `CANCELLED` → canceled, with access to the end of the time
 * already paid (PayPal drops the next billing time once cancelled: pass the period end you stored
 * as `knownPeriodEnd`); `EXPIRED` → canceled now; not approved yet → `incomplete` (opens nothing).
 */
export function paypalSubscriptionState(
  sub: Record<string, unknown>,
  {knownPeriodEnd = null, now = new Date()}: {knownPeriodEnd?: Date | null; now?: Date} = {}
): SubscriptionState | null {
  if (!isPaypalId(sub.id, 'I-')) return null;
  const next = dateOf(record(sub.billing_info)?.next_billing_time);
  const paidUntil = [next, knownPeriodEnd].filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const base = {
    provider: 'paypal' as const,
    id: sub.id,
    priceId: str(sub.plan_id),
    customerId: null,
    ref: str(sub.custom_id),
    mode: paypalMode(),
  };
  switch (sub.status) {
    case 'ACTIVE':
      return {...base, status: 'active', currentPeriodEnd: next, accessEndsAt: null};
    case 'SUSPENDED':
    case 'CANCELLED':
      return {...base, status: 'canceled', currentPeriodEnd: paidUntil, accessEndsAt: paidUntil && paidUntil > now ? paidUntil : now};
    case 'EXPIRED':
      return {...base, status: 'canceled', currentPeriodEnd: next, accessEndsAt: now};
    default:
      return {...base, status: 'incomplete', currentPeriodEnd: next, accessEndsAt: null};
  }
}

export interface PaypalSubscribeInput {
  /** The plan row your admin stored. The amount is PayPal's plan's: nothing here sends one. */
  price: StoredPrice;
  /** Your own id for this purchase: PayPal keeps it as `custom_id`. */
  ref: string;
  /** Absolute URLs on this site. PayPal adds `subscription_id=I-…` to the return URL. */
  returnUrl: string;
  cancelUrl: string;
  email?: string | null;
  /** Your stable id for this attempt (`checkout:<ref>`), never random per try. */
  idempotencyKey: string;
}

/** A subscription waiting for the buyer's approval: open `step` (PayPal's page) with `openCheckout()`. */
export async function createPaypalSubscription(
  input: PaypalSubscribeInput
): Promise<ProviderResult<{subscriptionId: string; url: string; step: CheckoutStep}>> {
  const problem = storedPriceProblem(input.price, 'paypal');
  if (problem) return fail(problem === 'not_configured' ? 0 : 422, problem);
  if (input.price.interval === 'one_time' || !isPaypalId(input.price.providerPriceId, 'P-')) return fail(422, 'invalid_input');
  if (!isReturnUrl(input.returnUrl) || !isReturnUrl(input.cancelUrl) || !input.ref || input.ref.length > 127 || !input.idempotencyKey) return fail(422, 'invalid_input');
  const res = await paypal<{id?: unknown; links?: {href?: unknown; rel?: unknown}[]}>(
    'POST',
    '/v1/billing/subscriptions',
    {
      plan_id: input.price.providerPriceId,
      custom_id: cleanMetadata({ref: input.ref}).ref,
      ...(input.email?.trim() ? {subscriber: {email_address: input.email.trim()}} : {}),
      application_context: {return_url: input.returnUrl, cancel_url: input.cancelUrl, user_action: 'SUBSCRIBE_NOW', shipping_preference: 'NO_SHIPPING'},
    },
    input.idempotencyKey
  );
  if (!res.ok) return res;
  const url = str(res.data.links?.find(l => l.rel === 'approve')?.href);
  if (!isPaypalId(res.data.id, 'I-') || !url?.startsWith('https://')) return fail(502, 'bad_response');
  return {
    ok: true,
    data: {subscriptionId: res.data.id, url, step: {kind: 'window', gateway: 'paypal', checkoutUrl: url, returnUrl: input.returnUrl, cancelUrl: input.cancelUrl}},
  };
}

/** The subscription as PayPal has it now (the webhook's and the access re-read: 4 s at most). */
export async function getPaypalSubscription(id: string, options: {knownPeriodEnd?: Date | null} = {}): Promise<ProviderResult<SubscriptionState>> {
  if (!isPaypalId(id, 'I-')) return fail(422, 'invalid_input');
  const res = await paypal<Record<string, unknown>>('GET', `/v1/billing/subscriptions/${encodeURIComponent(id)}`, undefined, undefined, QUICK_TIMEOUT_MS);
  if (!res.ok) return res;
  const state = paypalSubscriptionState(res.data, options);
  return state ? {ok: true, data: state} : fail(502, 'bad_response');
}

/** PayPal stops billing now. Keep access to the period end you stored, then re-read the subscription. */
export async function cancelPaypalSubscription(id: string, reason = 'Cancelled by the subscriber'): Promise<ProviderResult<Record<string, never>>> {
  if (!isPaypalId(id, 'I-')) return fail(422, 'invalid_input');
  return paypal<Record<string, never>>('POST', `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, {reason: reason.slice(0, 120)});
}

// ---------------------------------------------------------------- webhooks

/** How far a delivery's `paypal-transmission-time` may be from now (either way), like the HMAC checks. */
export const PAYPAL_TRANSMISSION_TOLERANCE_MS = 5 * 60_000;

/**
 * Is this delivery's `paypal-transmission-time` within 5 minutes of now? Checked BEFORE PayPal's
 * verify call, so a replayed (old) delivery, or a flood of made-up ones, costs no call to PayPal.
 * PayPal signs the time with the rest, so a replay can't move it. PayPal sends a failed delivery
 * again as a new transmission; one that still arrives late is dropped, and the access re-check
 * (`needsRecheck`) catches the change. No header, not a date, or too far off: false (answer 400).
 */
export function paypalTransmissionFresh(headers: Headers, {nowMs = Date.now()}: {nowMs?: number} = {}): boolean {
  const value = headers.get('paypal-transmission-time');
  if (!value || value.length > 64) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && Math.abs(nowMs - at) <= PAYPAL_TRANSMISSION_TOLERANCE_MS;
}

const HEADERS = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'] as const;

/**
 * PayPal's own check of a webhook delivery (`verify-webhook-signature`) against PAYPAL_WEBHOOK_ID:
 * the event only when PayPal answers SUCCESS. `rawEvent` is the body EXACTLY as it arrived
 * (`await c.req.text()`): PayPal signs those bytes, so the event is spliced into the request as
 * received, never parsed and serialized again (escapes, number formats and key order would change).
 * No webhook id, a missing header, a transmission time more than 5 minutes off
 * (`paypalTransmissionFresh`, before any call), a certificate not on paypal.com, or PayPal
 * unreachable (4 s): null (answer 400; PayPal sends it again later).
 */
export async function verifyPaypalWebhook(headers: Headers, rawEvent: string, {nowMs}: {nowMs?: number} = {}): Promise<ProviderEvent | null> {
  const webhookId = secretValue('PAYPAL_WEBHOOK_ID');
  if (!webhookId || typeof rawEvent !== 'string' || rawEvent.length > 256 * 1024) return null;
  if (!paypalTransmissionFresh(headers, nowMs === undefined ? {} : {nowMs})) return null;
  let event: Record<string, unknown> | null;
  try {
    event = record(JSON.parse(rawEvent));
  } catch {
    return null;
  }
  if (!event || !/^WH-[A-Z0-9-]{6,64}$/.test(String(event.id ?? '')) || typeof event.event_type !== 'string') return null;
  const values = HEADERS.map(name => headers.get(name));
  if (values.some(v => !v || v.length > 2000)) return null;
  const [authAlgo, certUrl, transmissionId, transmissionSig, transmissionTime] = values as string[];
  try {
    const url = new URL(certUrl!);
    if (url.protocol !== 'https:' || !/(^|\.)paypal\.com$/.test(url.hostname)) return null;
  } catch {
    return null;
  }
  const head = JSON.stringify({
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
  });
  // `{"auth_algo":…,"webhook_id":"…"}` → `{…,"webhook_id":"…","webhook_event":<the raw event>}`.
  const body = new RawJson(`${head.slice(0, -1)},"webhook_event":${rawEvent}}`);
  const res = await paypal<{verification_status?: unknown}>('POST', '/v1/notifications/verify-webhook-signature', body, undefined, QUICK_TIMEOUT_MS);
  if (!res.ok || res.data.verification_status !== 'SUCCESS') return null;
  const object = record(event.resource);
  return {id: String(event.id), type: event.event_type.slice(0, 100), objectId: str(object?.id), mode: paypalMode(), object};
}
