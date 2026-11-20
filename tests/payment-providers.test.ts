import {env} from 'cloudflare:workers';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  cancelEzypaySubscription,
  createEzypayPrice,
  createPaypalSubscription,
  createStripeCheckout,
  createStripePrice,
  ezypayMode,
  ezypaySubscriptionState,
  getEzypayPayment,
  grantsAccess,
  inCurrentMode,
  keyStatus,
  needsRecheck,
  parseAmount,
  paypalTransmissionFresh,
  QUICK_TIMEOUT_MS,
  resetWebhookLimitForTests,
  settleWithin,
  getPaypalSubscription,
  getStripeSubscription,
  webhookIpAllowed,
  paypalMode,
  resetPaypalTokensForTests,
  signTimestamped,
  startEzypayCheckout,
  type StoredPrice,
  stripeMode,
  stripeSubscriptionState,
  toDecimal,
  verifyEzypayWebhook,
  verifyPaypalWebhook,
  verifyStripeWebhook,
  verifyTimestampedSignature,
} from '../src/platform/payment-providers';

const vars = env as Record<string, string | undefined>;
const NAMES = [
  'EZYPAY_SECRET_KEY',
  'EZYPAY_PUBLISHABLE_KEY',
  'EZYPAY_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'PAYPAL_CLIENT_ID',
  'PAYPAL_CLIENT_SECRET',
  'PAYPAL_WEBHOOK_ID',
  'PAYPAL_MODE',
  'SITE_PREVIEW',
];

const EZ_TEST = 'sk_test_abcdef0123';
const EZ_LIVE = 'sk_live_abcdef0123';
const EZ_PK_TEST = 'pk_test_abcdef0123';
const EZ_PK_LIVE = 'pk_live_abcdef0123';
const WHSEC = 'whsec_0123456789abcdef';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
type Call = [string, RequestInit];
const calls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls as unknown as Call[];

beforeEach(() => {
  for (const n of NAMES) delete vars[n];
  resetPaypalTokensForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const n of NAMES) delete vars[n];
});

describe('payment providers: the mode follows the keys', () => {
  it('Ezypay: the secret key prefix, with a publishable key of the same mode', () => {
    expect(ezypayMode()).toBeNull();
    vars.EZYPAY_SECRET_KEY = EZ_TEST;
    expect(ezypayMode()).toBe('test');
    vars.EZYPAY_PUBLISHABLE_KEY = EZ_PK_LIVE;
    expect(ezypayMode(), 'a live publishable key with a test secret key never mixes').toBeNull();
    vars.EZYPAY_PUBLISHABLE_KEY = EZ_PK_TEST;
    expect(ezypayMode()).toBe('test');
    vars.EZYPAY_SECRET_KEY = EZ_LIVE;
    vars.EZYPAY_PUBLISHABLE_KEY = EZ_PK_LIVE;
    expect(ezypayMode()).toBe('live');
    vars.EZYPAY_SECRET_KEY = 'pk_live_abcdef0123';
    expect(ezypayMode(), 'a publishable key in the secret key').toBeNull();
  });

  it('Stripe: sk_/rk_ test and live; a publishable key is no key', () => {
    vars.STRIPE_SECRET_KEY = 'sk_test_x';
    expect(stripeMode()).toBe('test');
    vars.STRIPE_SECRET_KEY = 'rk_live_x';
    expect(stripeMode()).toBe('live');
    vars.STRIPE_SECRET_KEY = 'pk_live_x';
    expect(stripeMode()).toBeNull();
    expect(keyStatus('stripe').keyLooksWrong).toBe(true);
  });

  it('PayPal: PAYPAL_MODE live, else sandbox; nothing without both credentials', () => {
    vars.PAYPAL_CLIENT_ID = 'id';
    expect(paypalMode()).toBeNull();
    vars.PAYPAL_CLIENT_SECRET = 'secret';
    expect(paypalMode()).toBe('test');
    vars.PAYPAL_MODE = 'LIVE';
    expect(paypalMode()).toBe('live');
  });

  it('the Preview never takes real money: a live key there makes the provider unusable', () => {
    vars.SITE_PREVIEW = '1';
    vars.STRIPE_SECRET_KEY = 'sk_live_x';
    vars.EZYPAY_SECRET_KEY = EZ_LIVE;
    vars.PAYPAL_CLIENT_ID = 'id';
    vars.PAYPAL_CLIENT_SECRET = 'secret';
    vars.PAYPAL_MODE = 'live';
    expect([stripeMode(), ezypayMode(), paypalMode()]).toEqual([null, null, null]);
    expect(keyStatus('stripe').liveInPreview).toBe(true);
  });

  it('a stored row counts only in the mode the keys are in now', () => {
    vars.STRIPE_SECRET_KEY = 'sk_live_x';
    expect(inCurrentMode({provider: 'stripe', mode: 'live'})).toBe(true);
    expect(inCurrentMode({provider: 'stripe', mode: 'test'})).toBe(false);
    expect(inCurrentMode({provider: 'paypal', mode: 'live'}), 'no PayPal keys').toBe(false);
    expect(inCurrentMode({provider: 'platform', mode: 'live'})).toBe(false);
  });

  it('key status is booleans only, never a value', () => {
    vars.EZYPAY_SECRET_KEY = EZ_TEST;
    vars.EZYPAY_PUBLISHABLE_KEY = EZ_PK_LIVE;
    const status = keyStatus('ezypay');
    expect(JSON.stringify(status)).not.toContain('abcdef0123');
    expect(status.modesDiffer).toBe(true);
    expect(status.secrets).toEqual([
      {name: 'EZYPAY_SECRET_KEY', set: true},
      {name: 'EZYPAY_PUBLISHABLE_KEY', set: true},
      {name: 'EZYPAY_WEBHOOK_SECRET', set: false},
    ]);
    expect(status.ready).toBe(false);
  });
});

describe('payment providers: signatures over the raw body', () => {
  const body = '{"id":"evt_1234567890","type":"customer.subscription.updated","livemode":false,"data":{"object":{"id":"sub_1234567890"}}}';
  const now = 1_800_000_000;

  it('good, bad, stale, from the future, and malformed', async () => {
    const header = await signTimestamped(body, WHSEC, now);
    expect(await verifyTimestampedSignature(body, header, WHSEC, {nowSeconds: now + 10})).toBe(true);
    expect(await verifyTimestampedSignature(body, header, 'whsec_other', {nowSeconds: now})).toBe(false);
    expect(await verifyTimestampedSignature(`${body} `, header, WHSEC, {nowSeconds: now}), 'a changed body').toBe(false);
    expect(await verifyTimestampedSignature(body, header, WHSEC, {nowSeconds: now + 301}), 'older than 5 minutes').toBe(false);
    expect(await verifyTimestampedSignature(body, header, WHSEC, {nowSeconds: now - 301}), 'from the future').toBe(false);
    expect(await verifyTimestampedSignature(body, 'v1=abc', WHSEC, {nowSeconds: now})).toBe(false);
    expect(await verifyTimestampedSignature(body, null, WHSEC, {nowSeconds: now})).toBe(false);
    expect(await verifyTimestampedSignature(body, header, null, {nowSeconds: now}), 'no secret').toBe(false);
  });

  it('any one of several v1 signatures may match (a rolled secret)', async () => {
    const good = (await signTimestamped(body, WHSEC, now)).split('v1=')[1];
    const header = `t=${now},v1=${'0'.repeat(64)},v1=${good}`;
    expect(await verifyTimestampedSignature(body, header, WHSEC, {nowSeconds: now})).toBe(true);
  });

  it('Stripe: the event only with a good Stripe-Signature from STRIPE_WEBHOOK_SECRET', async () => {
    vars.STRIPE_WEBHOOK_SECRET = WHSEC;
    const header = await signTimestamped(body, WHSEC, now);
    const event = await verifyStripeWebhook(body, header, {nowSeconds: now});
    expect(event).toMatchObject({id: 'evt_1234567890', type: 'customer.subscription.updated', objectId: 'sub_1234567890', mode: 'test'});
    expect(await verifyStripeWebhook(body, header, {nowSeconds: now + 3600})).toBeNull();
    expect(await verifyStripeWebhook(body.replace('updated', 'deleted'), header, {nowSeconds: now})).toBeNull();
    delete vars.STRIPE_WEBHOOK_SECRET;
    expect(await verifyStripeWebhook(body, header, {nowSeconds: now})).toBeNull();
  });

  it('Ezypay: a bad signature is refused before anything is fetched; a good one is re-read from Ezypay', async () => {
    vars.EZYPAY_SECRET_KEY = EZ_TEST;
    vars.EZYPAY_WEBHOOK_SECRET = WHSEC;
    const posted = '{"id":"evt_abc123456","type":"payment.succeeded","data":{"object":{"id":"pay_forged"}}}';
    const fetch = vi.fn(async () =>
      json(200, {data: {mode: 'test', event: {id: 'evt_abc123456', type: 'payment.failed', mode: 'test', data: {object: {id: 'pay_real1234'}}}}})
    );
    vi.stubGlobal('fetch', fetch);
    expect(await verifyEzypayWebhook(posted, `t=${now},v1=${'a'.repeat(64)}`, {nowSeconds: now})).toBeNull();
    expect(fetch).not.toHaveBeenCalled();

    const header = await signTimestamped(posted, WHSEC, now);
    const event = await verifyEzypayWebhook(posted, header, {nowSeconds: now});
    // Only Ezypay's own copy counts: the posted body's type and object are never trusted.
    expect(event).toMatchObject({id: 'evt_abc123456', type: 'payment.failed', objectId: 'pay_real1234', mode: 'test'});
    const [url, init] = calls(fetch)[0]!;
    expect(url).toBe('https://ezypay.ezycourse.com/api/v1/events/evt_abc123456');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${EZ_TEST}`);
  });

  it('Ezypay: unsigned only through the re-read, and refused with requireSignature', async () => {
    vars.EZYPAY_SECRET_KEY = EZ_TEST;
    vars.EZYPAY_WEBHOOK_SECRET = WHSEC;
    const posted = '{"id":"evt_abc123456","type":"payment.succeeded"}';
    vi.stubGlobal('fetch', vi.fn(async () => json(404, {errors: [{message: 'not found'}]})));
    expect(await verifyEzypayWebhook(posted, null), 'an event Ezypay doesn\'t know').toBeNull();
    expect(await verifyEzypayWebhook(posted, null, {requireSignature: true})).toBeNull();
  });

  it('PayPal: verify-webhook-signature with the RAW event spliced in, as received', async () => {
    vars.PAYPAL_CLIENT_ID = 'id';
    vars.PAYPAL_CLIENT_SECRET = 'secret';
    vars.PAYPAL_WEBHOOK_ID = 'WH-HOOK';
    // Key order, spacing and escapes PayPal signed: a re-serialized copy would differ.
    const raw = '{"id":"WH-1AB23456CD7890123-4EF56789GH0123456", "event_type":"BILLING.SUBSCRIPTION.CANCELLED","resource":{"id":"I-ABCDEF123456","note":"caf\\u00e9"}}';
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/oauth2/token') ? json(200, {access_token: 'tok', expires_in: 3600}) : json(200, {verification_status: 'SUCCESS'})
    );
    vi.stubGlobal('fetch', fetch);
    const headers = new Headers({
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
      'paypal-transmission-id': 't-1',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': '2026-11-16T00:00:00Z',
    });
    const at = {nowMs: Date.parse('2026-11-16T00:01:00Z')};
    const event = await verifyPaypalWebhook(headers, raw, at);
    expect(event).toMatchObject({type: 'BILLING.SUBSCRIPTION.CANCELLED', objectId: 'I-ABCDEF123456', mode: 'test'});
    const [url, init] = calls(fetch)[1]!;
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature');
    expect(String(init.body).endsWith(`"webhook_id":"WH-HOOK","webhook_event":${raw}}`)).toBe(true);

    headers.set('paypal-cert-url', 'https://paypal.com.evil.example/cert');
    expect(await verifyPaypalWebhook(headers, raw, at), 'a certificate not on paypal.com').toBeNull();
    headers.set('paypal-cert-url', 'https://api.sandbox.paypal.com/cert');
    fetch.mockImplementation(async (url: string) =>
      url.endsWith('/oauth2/token') ? json(200, {access_token: 'tok', expires_in: 3600}) : json(200, {verification_status: 'FAILURE'})
    );
    expect(await verifyPaypalWebhook(headers, raw, at)).toBeNull();
  });

  it('PayPal: a delivery older than 5 minutes is dropped before any call to PayPal', async () => {
    vars.PAYPAL_CLIENT_ID = 'id';
    vars.PAYPAL_CLIENT_SECRET = 'secret';
    vars.PAYPAL_WEBHOOK_ID = 'WH-HOOK';
    const raw = '{"id":"WH-1AB23456CD7890123-4EF56789GH0123456","event_type":"BILLING.SUBSCRIPTION.CANCELLED","resource":{"id":"I-ABCDEF123456"}}';
    const fetch = vi.fn(async () => json(200, {verification_status: 'SUCCESS'}));
    vi.stubGlobal('fetch', fetch);
    const sent = Date.parse('2026-11-16T00:00:00Z');
    const headers = new Headers({
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
      'paypal-transmission-id': 't-1',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': '2026-11-16T00:00:00Z',
    });
    expect(paypalTransmissionFresh(headers, {nowMs: sent + 299_000})).toBe(true);
    expect(paypalTransmissionFresh(headers, {nowMs: sent - 299_000}), 'a little clock skew').toBe(true);
    expect(paypalTransmissionFresh(headers, {nowMs: sent + 301_000}), 'older than 5 minutes').toBe(false);
    expect(paypalTransmissionFresh(headers, {nowMs: sent - 301_000}), 'from the future').toBe(false);
    expect(await verifyPaypalWebhook(headers, raw, {nowMs: sent + 3600_000})).toBeNull();
    headers.set('paypal-transmission-time', 'yesterday');
    expect(await verifyPaypalWebhook(headers, raw, {nowMs: sent})).toBeNull();
    headers.delete('paypal-transmission-time');
    expect(paypalTransmissionFresh(headers, {nowMs: sent})).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('webhook routes: at most 60 posts a minute from one address, a new minute starts again', () => {
    resetWebhookLimitForTests();
    const t = 1_800_000_000_000;
    for (let i = 0; i < 60; i++) expect(webhookIpAllowed('203.0.113.7', {nowMs: t + i})).toBe(true);
    expect(webhookIpAllowed('203.0.113.7', {nowMs: t + 100})).toBe(false);
    expect(webhookIpAllowed('203.0.113.8', {nowMs: t + 100}), 'another address').toBe(true);
    expect(webhookIpAllowed('203.0.113.7', {nowMs: t + 60_000})).toBe(true);
    expect(webhookIpAllowed(null), 'no address (a local run)').toBe(true);
  });
});

describe('payment providers: quick re-reads', () => {
  it('PayPal: concurrent calls share ONE token request', async () => {
    vars.PAYPAL_CLIENT_ID = 'id';
    vars.PAYPAL_CLIENT_SECRET = 'secret';
    let release: () => void = () => undefined;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth2/token')) {
        await gate;
        return json(200, {access_token: 'tok', expires_in: 3600});
      }
      return json(200, {id: 'I-ABCDEF123456', status: 'ACTIVE', billing_info: {next_billing_time: '2030-01-01T00:00:00Z'}});
    });
    vi.stubGlobal('fetch', fetch);
    const reads = Promise.all([getPaypalSubscription('I-ABCDEF123456'), getPaypalSubscription('I-ABCDEF123456'), getPaypalSubscription('I-ABCDEF123456')]);
    await new Promise(r => setTimeout(r, 0));
    release();
    const results = await reads;
    expect(results.every(r => r.ok)).toBe(true);
    expect(calls(fetch).filter(([url]) => url.endsWith('/oauth2/token'))).toHaveLength(1);
    await getPaypalSubscription('I-ABCDEF123456');
    expect(calls(fetch).filter(([url]) => url.endsWith('/oauth2/token')), 'then cached').toHaveLength(1);
  });

  it('a slow provider on a re-read answers unreachable after the quick timeout', async () => {
    vars.STRIPE_SECRET_KEY = 'sk_test_abcdef0123';
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              const signal = init.signal!;
              signal.addEventListener('abort', () => reject(signal.reason));
            })
        )
      );
      const read = getStripeSubscription('sub_1234567890');
      await vi.advanceTimersByTimeAsync(QUICK_TIMEOUT_MS + 10);
      expect(await read).toEqual({ok: false, status: 0, code: 'unreachable'});
    } finally {
      vi.useRealTimers();
    }
  });

  it('settleWithin: the answer when quick, null when slow or failed (the page then uses the stored row)', async () => {
    expect(await settleWithin(Promise.resolve(7), 50)).toBe(7);
    expect(await settleWithin(Promise.reject(new Error('down')), 50)).toBeNull();
    const slow = new Promise(r => setTimeout(() => r('late answer'), 200));
    const started = Date.now();
    expect(await settleWithin(slow, 20)).toBeNull();
    expect(Date.now() - started).toBeLessThan(150);
  });
});

describe('payment providers: the amount comes from a stored price only', () => {
  const stripePrice: StoredPrice = {provider: 'stripe', mode: 'test', providerPriceId: 'price_1234567890', amountMinor: 1900, currency: 'USD', interval: 'month'};
  const urls = {successUrl: 'https://shop.example/thanks/', cancelUrl: 'https://shop.example/pricing/'};

  it('Stripe checkout sends the stored price id, never an amount', async () => {
    vars.STRIPE_SECRET_KEY = 'sk_test_x';
    const fetch = vi.fn(async () => json(200, {id: 'cs_test_1234567890', url: 'https://checkout.stripe.com/c/pay/cs_test_1', livemode: false}));
    vi.stubGlobal('fetch', fetch);
    const tampered = {...stripePrice, amountMinor: 1, unit_amount: 1} as StoredPrice;
    const res = await createStripeCheckout({price: tampered, ref: 'chk_42', idempotencyKey: 'checkout:chk_42', ...urls});
    expect(res).toMatchObject({ok: true, data: {sessionId: 'cs_test_1234567890', step: {kind: 'window', gateway: 'stripe'}}});
    const [url, init] = calls(fetch)[0]!;
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('line_items[0][price]')).toBe('price_1234567890');
    expect(form.get('mode')).toBe('subscription');
    expect(String(init.body)).not.toMatch(/amount/);
    expect(form.get('success_url')).toBe('https://shop.example/thanks/?session_id={CHECKOUT_SESSION_ID}');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('checkout:chk_42');
  });

  it('a price of the other mode, or another provider, is refused before calling anyone', async () => {
    vars.STRIPE_SECRET_KEY = 'sk_live_x';
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await createStripeCheckout({price: stripePrice, ref: 'r', idempotencyKey: 'k', ...urls})).toEqual({ok: false, status: 422, code: 'mode_mismatch'});
    expect(await createStripeCheckout({price: {...stripePrice, provider: 'paypal', mode: 'live'}, ref: 'r', idempotencyKey: 'k', ...urls})).toEqual({
      ok: false,
      status: 422,
      code: 'wrong_provider',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a Stripe answer in the other mode is refused', async () => {
    vars.STRIPE_SECRET_KEY = 'sk_test_x';
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {id: 'price_1234567890', product: 'prod_1234567890', unit_amount: 1900, recurring: {interval: 'month'}, livemode: true})));
    expect(await createStripePrice({name: 'Pro', amountMinor: 1900, currency: 'usd', interval: 'month', idempotencyKey: 'price:1'})).toEqual({
      ok: false,
      status: 502,
      code: 'mode_mismatch',
    });
  });

  it('Ezypay checkout sends the stored price id; a subscription uses the publishable key and needs a gateway', async () => {
    vars.EZYPAY_SECRET_KEY = EZ_TEST;
    vars.EZYPAY_PUBLISHABLE_KEY = EZ_PK_TEST;
    const fetch = vi.fn(async () => json(200, {data: {mode: 'test', checkoutUrl: 'https://checkout.stripe.com/c/pay/x', gateway: 'stripe'}}));
    vi.stubGlobal('fetch', fetch);
    const price: StoredPrice = {provider: 'ezypay', mode: 'test', providerPriceId: 'price_ez123456', amountMinor: 1900, currency: 'USD', interval: 'month'};
    expect(await startEzypayCheckout({price, ref: 'chk_1', idempotencyKey: 'checkout:chk_1', ...urls})).toEqual({ok: false, status: 422, code: 'gateway_required'});
    const res = await startEzypayCheckout({price: {...price, amountMinor: 1} as StoredPrice, ref: 'chk_1', gateway: 'stripe', idempotencyKey: 'checkout:chk_1', ...urls});
    expect(res).toMatchObject({ok: true, data: {paymentId: null, step: {kind: 'window', checkoutUrl: 'https://checkout.stripe.com/c/pay/x'}}});
    const [url, init] = calls(fetch)[0]!;
    expect(url).toBe('https://ezypay.ezycourse.com/api/v1/checkout/sessions');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${EZ_PK_TEST}`);
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({priceId: 'price_ez123456', gateway: 'stripe', metadata: {ref: 'chk_1'}});
    expect(JSON.stringify(sent)).not.toMatch(/amount/i);
  });

  it('Ezypay one-time: a payment, its popup or form read from the answer', async () => {
    vars.EZYPAY_SECRET_KEY = EZ_TEST;
    const fetch = vi.fn(async () =>
      json(201, {
        data: {
          mode: 'test',
          payment: {id: 'pay_ab123456', gateway: 'razorpay'},
          clientCheckout: {scriptUrl: 'https://checkout.razorpay.com/v1/checkout.js', clientGlobal: 'Razorpay', options: {key: 'rzp'}, dismissCallback: 'modal.ondismiss'},
        },
      })
    );
    vi.stubGlobal('fetch', fetch);
    const price: StoredPrice = {provider: 'ezypay', mode: 'test', providerPriceId: 'price_ez123456', amountMinor: 50000, currency: 'INR', interval: 'one_time'};
    const res = await startEzypayCheckout({price, ref: 'ord_9', idempotencyKey: 'order:9', ...urls});
    expect(res).toMatchObject({ok: true, data: {paymentId: 'pay_ab123456', step: {kind: 'popup', gateway: 'razorpay'}}});
    const [url, init] = calls(fetch)[0]!;
    expect(url).toBe('https://ezypay.ezycourse.com/api/v1/payments');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('order:9');
    expect(JSON.parse(String(init.body))).toEqual({
      priceId: 'price_ez123456',
      successUrl: urls.successUrl,
      cancelUrl: urls.cancelUrl,
      metadata: {ref: 'ord_9'},
      method: 'hosted',
    });
  });

  it('PayPal subscribes to the stored plan id, never an amount', async () => {
    vars.PAYPAL_CLIENT_ID = 'id';
    vars.PAYPAL_CLIENT_SECRET = 'secret';
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/oauth2/token')
        ? json(200, {access_token: 'tok', expires_in: 3600})
        : json(201, {id: 'I-ABCDEF123456', links: [{rel: 'approve', href: 'https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=x'}]})
    );
    vi.stubGlobal('fetch', fetch);
    const price: StoredPrice = {provider: 'paypal', mode: 'test', providerPriceId: 'P-ABC123456789', amountMinor: 1900, currency: 'USD', interval: 'month'};
    const res = await createPaypalSubscription({price, ref: 'chk_7', idempotencyKey: 'checkout:chk_7', returnUrl: urls.successUrl, cancelUrl: urls.cancelUrl});
    expect(res).toMatchObject({ok: true, data: {subscriptionId: 'I-ABCDEF123456', step: {kind: 'window', gateway: 'paypal'}}});
    const [, init] = calls(fetch)[1]!;
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({plan_id: 'P-ABC123456789', custom_id: 'chk_7'});
    expect(JSON.stringify(sent)).not.toMatch(/amount|value|price/i);
    expect((init.headers as Record<string, string>)['paypal-request-id']).toBe('checkout:chk_7');
  });

  it('Ezypay counts IDR in whole units: the kit converts both ways', async () => {
    vars.EZYPAY_SECRET_KEY = EZ_TEST;
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/products')
        ? json(201, {data: {mode: 'test', product: {id: 'prod_ez123456'}}})
        : json(201, {data: {mode: 'test', price: {id: 'price_ez123456', unitAmount: '150000', currency: 'IDR'}}})
    );
    vi.stubGlobal('fetch', fetch);
    const res = await createEzypayPrice({name: 'Kelas', amountMinor: 15_000_000, currency: 'idr', interval: 'one_time', idempotencyKey: 'price:3'});
    expect(res).toMatchObject({ok: true, data: {providerPriceId: 'price_ez123456', amountMinor: 15_000_000, currency: 'IDR', mode: 'test'}});
    expect(JSON.parse(String(calls(fetch)[1]![1].body))).toMatchObject({unitAmount: 150_000, type: 'one_time', currency: 'IDR'});
    expect(await createEzypayPrice({name: 'Kelas', amountMinor: 15_000_050, currency: 'IDR', interval: 'one_time', idempotencyKey: 'price:4'})).toMatchObject({
      ok: false,
      code: 'amount_not_whole',
    });
  });

  it('an Ezypay answer in the other mode is refused', async () => {
    vars.EZYPAY_SECRET_KEY = EZ_TEST;
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {data: {mode: 'live', payment: {id: 'pay_ab123456', status: 'succeeded'}}})));
    expect(await getEzypayPayment('pay_ab123456')).toEqual({ok: false, status: 502, code: 'mode_mismatch'});
  });

  it('Ezypay cancel sends atPeriodEnd', async () => {
    vars.EZYPAY_SECRET_KEY = EZ_TEST;
    const fetch = vi.fn(async () =>
      json(200, {data: {mode: 'test', subscription: {id: 'sub_ez123456', status: 'active', cancelAtPeriodEnd: true, currentPeriodEnd: '2026-12-01T00:00:00Z'}}})
    );
    vi.stubGlobal('fetch', fetch);
    const res = await cancelEzypaySubscription('sub_ez123456');
    expect(res).toMatchObject({ok: true, data: {status: 'canceled', accessEndsAt: new Date('2026-12-01T00:00:00Z')}});
    expect(JSON.parse(String(calls(fetch)[0]![1].body))).toEqual({atPeriodEnd: true});
  });
});

describe('payment providers: amounts and access', () => {
  it('reads amounts as text, never floats', () => {
    expect(parseAmount('14.50', 'USD')).toEqual({minor: 1450});
    expect(parseAmount('1,400', 'JPY')).toEqual({minor: 1400});
    expect(parseAmount('14.5', 'JPY')).toHaveProperty('error');
    expect(parseAmount('0.001', 'USD')).toHaveProperty('error');
    expect(toDecimal(1450, 'USD')).toBe('14.50');
    expect(toDecimal(5, 'EUR')).toBe('0.05');
    expect(toDecimal(1400, 'JPY')).toBe('1400');
  });

  it('active, trialing and past_due until the period end (plus grace); canceled until accessEndsAt; then re-check', () => {
    vars.STRIPE_SECRET_KEY = 'sk_live_x';
    const now = Date.parse('2026-11-16T00:00:00Z');
    const day = 24 * 3600_000;
    const row = {provider: 'stripe', mode: 'live', status: 'active', currentPeriodEnd: new Date(now + day), accessEndsAt: null};
    expect(grantsAccess(row, now)).toBe(true);
    expect(grantsAccess({...row, status: 'past_due'}, now)).toBe(true);
    expect(grantsAccess({...row, mode: 'test'}, now), 'a test row on the live site').toBe(false);
    const ended = {...row, currentPeriodEnd: new Date(now - 4 * day)};
    expect(needsRecheck(ended, now)).toBe(true);
    expect(grantsAccess(ended, now), 'a missed renewal opens nothing until re-read').toBe(false);
    expect(grantsAccess({...row, status: 'canceled', accessEndsAt: new Date(now + day)}, now)).toBe(true);
    expect(grantsAccess({...row, status: 'canceled', accessEndsAt: new Date(now - 1)}, now)).toBe(false);
    expect(grantsAccess({...row, status: 'incomplete'}, now)).toBe(false);
  });

  it('maps Stripe and Ezypay subscriptions to the same statuses', () => {
    const end = 1_800_000_000;
    expect(stripeSubscriptionState({id: 'sub_1234567890', status: 'active', cancel_at_period_end: true, current_period_end: end, livemode: false})).toMatchObject({
      status: 'canceled',
      accessEndsAt: new Date(end * 1000),
      mode: 'test',
    });
    expect(stripeSubscriptionState({id: 'sub_1234567890', status: 'incomplete'})?.status).toBe('incomplete');
    expect(
      ezypaySubscriptionState({id: 'sub_ez123456', status: 'canceled', accessEndsAt: '2026-12-01T00:00:00Z', endedAt: '2026-11-01T00:00:00Z'})
    ).toMatchObject({status: 'canceled', accessEndsAt: new Date('2026-12-01T00:00:00Z')});
    expect(ezypaySubscriptionState({id: 'sub_ez123456', status: 'trialing'})?.status).toBe('trialing');
  });
});
