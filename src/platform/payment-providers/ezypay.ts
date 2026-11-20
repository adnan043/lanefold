import {cleanMetadata, dateOf, fail, isReturnUrl, providerCall, type ProviderResult, QUICK_TIMEOUT_MS, record, str, TIMEOUT_MS} from './http';
import {ezypayMode, type Mode, secretValue, storedPriceProblem} from './keys';
import {cleanCurrency, isAmount} from './money';
import {verifyTimestampedSignature} from './signature';
import type {CheckoutStep, CreatedPrice, Interval, ProviderEvent, StoredPrice, SubscriptionState} from './types';

/**
 * The OWNER's own Ezypay account (`docs/agent/payments-providers.md`). Ezypay
 * (https://ezypay.ezycourse.com) is a payment service in front of Stripe, Xendit, Razorpay and PayPal:
 * the owner connects those gateways in their Ezypay dashboard, and this site talks to Ezypay only.
 * Plain `fetch` against Ezypay's documented REST API (`/api/openapi.json`), with the shapes of its
 * official SDK (0.2.0), so nothing extra is installed. EZYPAY_SECRET_KEY (and, for a
 * subscription checkout, EZYPAY_PUBLISHABLE_KEY) are read here, per call, and sent only to Ezypay.
 * Every answer echoes its `mode`: one of the other mode than the keys is refused (`mode_mismatch`).
 * Server only.
 *
 *   createEzypayPrice()           a product and its price (one-time, monthly or yearly), from the admin
 *   ezypayGateways()              the gateways the owner connected (the buyer picks when several)
 *   startEzypayCheckout()         a checkout for a STORED price → the step to open (form, popup or window)
 *   getEzypayPayment()            confirm a one-time payment on the thanks page
 *   getEzypaySubscription()       re-read a subscription on every event
 *   cancelEzypaySubscription()    at the period end (default) or now
 *   verifyEzypayWebhook()         `ezy-signature` over the RAW body, then the event re-read from Ezypay
 *
 * Confirmed (in the SDK and the OpenAPI): products, prices, connected gateways, `POST /payments`,
 * `GET /payments/{id}`, `GET /subscriptions/{id}`, `POST /subscriptions/{id}/cancel {atPeriodEnd}`,
 * `GET /events/{id}`, the `ezy-signature` scheme. Not yet documented by Ezypay (read defensively):
 * the request body of `POST /checkout/sessions` (a subscription's checkout), the popup answer
 * (`clientCheckout`), and whether every delivery is signed yet.
 */

const API = 'https://ezypay.ezycourse.com/api/v1';

/**
 * Currencies Ezypay counts in WHOLE units where this kit (like Stripe) counts hundredths: IDR and ISK.
 * Every amount crossing to Ezypay is divided by 100 for them, and multiplied back on the way in.
 */
const WHOLE_AT_EZYPAY = new Set(['IDR', 'ISK']);
const factor = (currency: string) => (WHOLE_AT_EZYPAY.has(currency.toUpperCase()) ? 100 : 1);
/** Ezypay's minor units (a string from the API) → the kit's. */
export const fromEzypayMinor = (value: unknown, currency: string): number | null => {
  const n = typeof value === 'string' && value.trim() ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n * factor(currency) : null;
};

type Envelope = Record<string, unknown> & {mode?: unknown};

async function ezypay(
  method: 'GET' | 'POST',
  path: string,
  {body, idempotencyKey, publishable = false, timeoutMs = TIMEOUT_MS}: {body?: unknown; idempotencyKey?: string; publishable?: boolean; timeoutMs?: number} = {}
): Promise<ProviderResult<Envelope>> {
  const mode = ezypayMode();
  const key = secretValue(publishable ? 'EZYPAY_PUBLISHABLE_KEY' : 'EZYPAY_SECRET_KEY');
  if (!mode || !key) return fail(0, 'not_configured');
  const headers: Record<string, string> = {authorization: `Bearer ${key}`, accept: 'application/json'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey.slice(0, 255);
  const label = `ezypay ${method} ${path.replace(/\/(prod|price|pay|sub|evt|cus)_[A-Za-z0-9_]+/g, '/$1_…')}`;
  const res = await providerCall<{data?: unknown}>(`${API}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)}, label, timeoutMs);
  if (!res.ok) return res;
  const data = record(res.data.data) ?? (res.data as Envelope);
  // The key decides the mode, and Ezypay says which answered: they must agree.
  if (data.mode !== undefined && data.mode !== mode) return fail(502, 'mode_mismatch');
  return {ok: true, data};
}

const ID = /^[a-z]{2,6}_[A-Za-z0-9_]{4,200}$/;
export const isEzypayId = (value: unknown, prefix?: string): value is string =>
  typeof value === 'string' && ID.test(value) && (!prefix || value.startsWith(`${prefix}_`));

// ---------------------------------------------------------------- prices

export interface NewEzypayPrice {
  name: string;
  amountMinor: number;
  currency: string;
  interval: Interval;
  /** Your stable id for this create (`price:<row id>`): Ezypay keeps it as `externalRef`, so a retry makes nothing twice. */
  idempotencyKey: string;
}

export async function createEzypayPrice(input: NewEzypayPrice): Promise<ProviderResult<CreatedPrice>> {
  const currency = cleanCurrency(input.currency);
  const name = input.name?.trim().slice(0, 200);
  const ref = input.idempotencyKey?.slice(0, 120);
  if (!currency || !name || !isAmount(input.amountMinor) || !ref) return fail(422, 'invalid_input');
  if (input.amountMinor % factor(currency) !== 0) return fail(422, 'amount_not_whole');
  const mode = ezypayMode();
  if (!mode) return fail(0, 'not_configured');
  const product = await ezypay('POST', '/products', {body: {name, externalRef: `${ref}:product`}, idempotencyKey: `${ref}:product`});
  if (!product.ok) return product;
  const productId = str(record(product.data.product)?.id);
  if (!isEzypayId(productId)) return fail(502, 'bad_response');
  const recurring = input.interval !== 'one_time';
  const price = await ezypay('POST', `/products/${encodeURIComponent(productId)}/prices`, {
    body: {
      currency,
      unitAmount: input.amountMinor / factor(currency),
      type: recurring ? 'recurring' : 'one_time',
      ...(recurring ? {recurringInterval: input.interval, recurringIntervalCount: 1} : {}),
      nickname: name.slice(0, 100),
      externalRef: `${ref}:price`,
    },
    idempotencyKey: `${ref}:price`,
  });
  if (!price.ok) return price;
  const p = record(price.data.price);
  const priceId = str(p?.id);
  if (!isEzypayId(priceId) || fromEzypayMinor(p?.unitAmount, currency) !== input.amountMinor) return fail(502, 'bad_response');
  return {ok: true, data: {provider: 'ezypay', mode, providerPriceId: priceId, providerProductId: productId, amountMinor: input.amountMinor, currency, interval: input.interval}};
}

// ---------------------------------------------------------------- checkout

export interface EzypayGateway {
  slug: string;
  name: string;
}

/** The gateways the owner connected and switched on in Ezypay, in this mode. */
export async function ezypayGateways(): Promise<ProviderResult<EzypayGateway[]>> {
  const res = await ezypay('GET', '/gateways/connected');
  if (!res.ok) return res;
  const list = Array.isArray(res.data.gateways) ? (res.data.gateways as unknown[]) : [];
  const gateways = list
    .map(record)
    .filter(g => g?.status === 'active')
    .map(g => ({slug: str(record(g!.gateway)?.slug) ?? '', name: str(record(g!.gateway)?.name) ?? ''}))
    .filter(g => /^[a-z0-9_-]{2,40}$/.test(g.slug) && g.name);
  return {ok: true, data: gateways};
}

/** A popup as Ezypay sends it (Razorpay), or null when it isn't a usable one. */
function popupOf(v: unknown): Extract<CheckoutStep, {kind: 'popup'}>['clientCheckout'] | null {
  const c = record(v);
  const scriptUrl = str(c?.scriptUrl);
  const clientGlobal = str(c?.clientGlobal);
  if (!c || !scriptUrl?.startsWith('https://') || !clientGlobal || !/^[A-Za-z_$][\w$]*$/.test(clientGlobal)) return null;
  return {scriptUrl, clientGlobal, options: record(c.options) ?? {}, dismissCallback: str(c.dismissCallback)};
}

/** The ONE place an Ezypay checkout answer is read: a form in the page, a popup, or the gateway's page. */
function stepOf(data: Envelope, gateway: string, urls: {returnUrl: string; cancelUrl: string}): CheckoutStep | null {
  const payment = record(data.payment);
  const slug = str(data.gateway) ?? str(payment?.gateway) ?? gateway;
  const clientSecret = str(data.clientSecret);
  const publishableKey = str(data.publishableKey);
  if (clientSecret && publishableKey) {
    const gatewayAccountId = str(data.gatewayAccountId) ?? str(data.stripeAccount) ?? str(payment?.gatewayAccountId);
    return {kind: 'element', gateway: slug, clientSecret, publishableKey, gatewayAccountId, ...urls};
  }
  const popup = popupOf(data.clientCheckout);
  if (popup) return {kind: 'popup', gateway: slug, clientCheckout: popup, ...urls};
  const checkoutUrl = str(data.checkoutUrl);
  if (checkoutUrl?.startsWith('https://')) return {kind: 'window', gateway: slug, checkoutUrl, ...urls};
  return null;
}

export interface EzypayCheckoutInput {
  /** The row your admin stored. The amount is Ezypay's price's: nothing here sends an amount. */
  price: StoredPrice;
  /** Your own id for this purchase: comes back as `metadata.ref` on the payment and the subscription. */
  ref: string;
  /** Absolute URLs on this site. */
  successUrl: string;
  cancelUrl: string;
  /** A slug from `ezypayGateways()`: the buyer's pick. Required for a subscription; optional for one-time. */
  gateway?: string | null;
  /** One-time only: `element` asks for the gateway's form in the page (Stripe); default `hosted`. */
  method?: 'hosted' | 'element';
  /** The buyer's own email (a subscription with a free trial needs it). */
  email?: string | null;
  /** Your stable id for this attempt (`checkout:<ref>`), never random per try. */
  idempotencyKey: string;
}

/**
 * Start paying for a stored price. A one-time price is a payment (`POST /payments`); a monthly or
 * yearly one is a checkout session on the gateway (`POST /checkout/sessions`, with the publishable
 * key), which starts the subscription. Open `step` with `openCheckout()` (`src/lib/checkout-session.ts`).
 * `paymentId`: one-time only (confirm it with `getEzypayPayment`); a subscription's first payment
 * arrives as the `payment.succeeded` event, carrying your `ref`.
 * 409 `in_progress`: Ezypay is still preparing it: call again with the SAME idempotency key.
 */
export async function startEzypayCheckout(
  input: EzypayCheckoutInput
): Promise<ProviderResult<{paymentId: string | null; step: CheckoutStep}>> {
  const problem = storedPriceProblem(input.price, 'ezypay');
  if (problem) return fail(problem === 'not_configured' ? 0 : 422, problem);
  if (!isEzypayId(input.price.providerPriceId) || !isReturnUrl(input.successUrl) || !isReturnUrl(input.cancelUrl)) return fail(422, 'invalid_input');
  if (!input.ref || input.ref.length > 200 || !input.idempotencyKey) return fail(422, 'invalid_input');
  const gateway = input.gateway && /^[a-z0-9_-]{2,40}$/.test(input.gateway) ? input.gateway : null;
  const metadata = cleanMetadata({ref: input.ref});
  const urls = {returnUrl: input.successUrl, cancelUrl: input.cancelUrl};
  const recurring = input.price.interval !== 'one_time';
  if (recurring && !gateway) return fail(422, 'gateway_required');

  const res = recurring
    ? await ezypay('POST', '/checkout/sessions', {
        publishable: true,
        body: {
          priceId: input.price.providerPriceId,
          gateway,
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
          idempotencyKey: input.idempotencyKey.slice(0, 255),
          metadata: {...metadata, ...(input.email?.trim() ? {email: input.email.trim().slice(0, 254)} : {})},
        },
      })
    : await ezypay('POST', '/payments', {
        idempotencyKey: input.idempotencyKey,
        body: {
          priceId: input.price.providerPriceId,
          successUrl: input.successUrl,
          cancelUrl: input.cancelUrl,
          metadata,
          method: input.method === 'element' ? 'element' : 'hosted',
          ...(gateway ? {gateway} : {}),
        },
      });
  if (!res.ok) return res;
  if (res.data.status === 'pending' && !res.data.payment && !res.data.checkoutUrl && !res.data.clientCheckout) return fail(409, 'in_progress');
  const step = stepOf(res.data, gateway ?? '', urls);
  if (!step) return fail(502, 'bad_response');
  const paymentId = str(record(res.data.payment)?.id);
  return {ok: true, data: {paymentId: recurring ? null : paymentId, step}};
}

export interface EzypayPaymentState {
  id: string;
  /** `paid` only when Ezypay says `succeeded`. */
  status: 'paid' | 'open' | 'failed' | 'refunded';
  ref: string | null;
  priceId: string | null;
  subscriptionId: string | null;
  /** In the kit's minor units. */
  amountMinor: number | null;
  currency: string | null;
  /** `checkout`, `renewal`, `installment` or `trial_start`. */
  billingReason: string | null;
}

export function ezypayPaymentState(p: Record<string, unknown>): EzypayPaymentState | null {
  const id = str(p.id);
  if (!isEzypayId(id)) return null;
  const currency = cleanCurrency(p.currency);
  const status = p.status === 'succeeded' ? 'paid' : p.status === 'failed' || p.status === 'canceled' ? 'failed' : p.status === 'refunded' || p.status === 'partially_refunded' ? 'refunded' : 'open';
  return {
    id,
    status,
    ref: str(record(p.metadata)?.ref),
    priceId: str(p.priceId),
    subscriptionId: str(record(p.subscription)?.id) ?? str(p.subscriptionId),
    amountMinor: currency ? fromEzypayMinor(p.amountMinor, currency) : null,
    currency,
    billingReason: str(p.billingReason),
  };
}

/** The thanks page's confirm of a one-time payment (`paymentId` from `startEzypayCheckout`). */
export async function getEzypayPayment(id: string): Promise<ProviderResult<EzypayPaymentState>> {
  if (!isEzypayId(id)) return fail(422, 'invalid_input');
  const res = await ezypay('GET', `/payments/${encodeURIComponent(id)}`);
  if (!res.ok) return res;
  const state = ezypayPaymentState(record(res.data.payment) ?? {});
  return state ? {ok: true, data: state} : fail(502, 'bad_response');
}

// ---------------------------------------------------------------- subscriptions

/**
 * An Ezypay subscription as the site keeps it. Ezypay's rule: access is decided by `accessEndsAt`,
 * never by `status` alone (a gateway can report the end late). `active` / `trialing` / `past_due`
 * renew; one cancelled at the period end keeps access to that end; `canceled` / `expired` end at
 * `accessEndsAt` (else `endedAt`, else now); `paused` opens nothing; `incomplete` not paid yet.
 */
export function ezypaySubscriptionState(sub: Record<string, unknown>, {mode = null, now = new Date()}: {mode?: Mode | null; now?: Date} = {}): SubscriptionState | null {
  const id = str(sub.id);
  if (!isEzypayId(id)) return null;
  const periodEnd = dateOf(sub.currentPeriodEnd);
  const accessEnds = dateOf(sub.accessEndsAt);
  let status: SubscriptionState['status'];
  let accessEndsAt: Date | null = null;
  switch (sub.status) {
    case 'active':
    case 'trialing':
    case 'past_due':
      if (sub.cancelAtPeriodEnd === true) {
        status = 'canceled';
        accessEndsAt = accessEnds ?? periodEnd ?? now;
      } else status = sub.status;
      break;
    case 'canceled':
    case 'expired':
      status = 'canceled';
      accessEndsAt = accessEnds ?? dateOf(sub.endedAt) ?? now;
      break;
    case 'paused':
      status = 'canceled';
      accessEndsAt = now;
      break;
    default:
      status = 'incomplete';
  }
  return {
    provider: 'ezypay',
    id,
    status,
    currentPeriodEnd: periodEnd,
    accessEndsAt,
    priceId: str(sub.priceId),
    customerId: str(sub.customerId),
    ref: str(record(sub.metadata)?.ref),
    mode,
  };
}

/** The subscription as Ezypay has it now (the webhook's and the access re-read: 4 s at most). */
export async function getEzypaySubscription(id: string): Promise<ProviderResult<SubscriptionState>> {
  if (!isEzypayId(id)) return fail(422, 'invalid_input');
  const res = await ezypay('GET', `/subscriptions/${encodeURIComponent(id)}`, {timeoutMs: QUICK_TIMEOUT_MS});
  if (!res.ok) return res;
  const state = ezypaySubscriptionState(record(res.data.subscription) ?? {}, {mode: ezypayMode()});
  return state ? {ok: true, data: state} : fail(502, 'bad_response');
}

/**
 * Cancel at the end of the paid period (default: access lasts to it), or now. Ezypay answers that it
 * took the request; the gateway confirms the end later with `subscription.canceled` (its
 * `accessEndsAt` decides access).
 */
export async function cancelEzypaySubscription(id: string, {atPeriodEnd = true}: {atPeriodEnd?: boolean} = {}): Promise<ProviderResult<SubscriptionState | null>> {
  if (!isEzypayId(id)) return fail(422, 'invalid_input');
  const res = await ezypay('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, {body: {atPeriodEnd}, idempotencyKey: `cancel:${id}:${atPeriodEnd ? 'end' : 'now'}`});
  if (!res.ok) return res;
  const sub = record(res.data.subscription);
  return {ok: true, data: sub ? ezypaySubscriptionState(sub, {mode: ezypayMode()}) : null};
}

// ---------------------------------------------------------------- webhooks

/**
 * The webhook route's first step. An `ezy-signature` header (`t=…,v1=…`, HMAC-SHA256 of
 * `<t>.<raw body>`) must match EZYPAY_WEBHOOK_SECRET over the RAW body, within 5 minutes, in
 * constant time. Then, signed or not, the event is READ AGAIN from Ezypay by its id with the secret
 * key, and only that copy is returned: a forged body can't make anything happen, and a replayed one
 * is a real event you handle once (by its id). Null: answer 400.
 *
 * `requireSignature` (default false while Ezypay doesn't sign every delivery yet): true refuses an
 * unsigned delivery outright, before any call. Pass it once Ezypay documents that every delivery is
 * signed (its OpenAPI or SDK changelog), or your log shows a week of deliveries all signed. Until
 * then an unsigned post costs one re-read (bounded by the route's per-IP limit) and can't forge
 * anything.
 */
export async function verifyEzypayWebhook(
  rawBody: string,
  signature: string | null | undefined,
  {requireSignature = false, nowSeconds}: {requireSignature?: boolean; nowSeconds?: number} = {}
): Promise<ProviderEvent | null> {
  if (typeof rawBody !== 'string' || rawBody.length > 256 * 1024) return null;
  if (signature || requireSignature) {
    const secret = secretValue('EZYPAY_WEBHOOK_SECRET');
    if (!(await verifyTimestampedSignature(rawBody, signature, secret, nowSeconds === undefined ? {} : {nowSeconds}))) return null;
  }
  let posted: Record<string, unknown> | null;
  try {
    posted = record(JSON.parse(rawBody));
  } catch {
    return null;
  }
  const id = str(posted?.id);
  if (!isEzypayId(id, 'evt')) return null;
  const again = await ezypay('GET', `/events/${encodeURIComponent(id)}`, {timeoutMs: QUICK_TIMEOUT_MS});
  if (!again.ok) return null;
  const event = record(again.data.event);
  if (!event || event.id !== id || typeof event.type !== 'string') return null;
  const object = record(record(event.data)?.object);
  const mode = event.mode === 'test' || event.mode === 'live' ? event.mode : ezypayMode();
  return {id, type: event.type.slice(0, 100), objectId: str(object?.id), mode, object};
}
