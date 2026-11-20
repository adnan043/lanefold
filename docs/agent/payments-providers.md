---
title: Payment providers: Ezypay, Stripe or PayPal with the owner's own account, the owner picks
read-when: before building an app that sells with the owner's own payment account (Ezypay, Stripe or PayPal), its prices, checkout, webhooks, cancel or access rules; before submitting an app that sells to the store
---
Two ways to sell. Pick per site, then follow that doc only:

| The site… | Use |
| --- | --- |
| is the owner's own site, selling their things | the built-in payments (`payments.md`): nothing to set up, no keys, sandbox and live switch by themselves. Unchanged, still the default. |
| is an APP others install (a store listing), or the owner asks for their own Ezypay, Stripe or PayPal account | this doc: the owner's own keys, and the OWNER picks the provider in the app's admin |

**An app that sells anything supports all three, Ezypay and the owner's own Stripe and PayPal, and lets the owner
choose which one in the app's admin.** Never hard-code one provider, never pick it in code, never hide one the owner
has keys for. The store asks for this on submission and its reviewer checks the admin by hand (`store-apps.md`).

Ezypay (https://ezypay.ezycourse.com) is a payment service in front of Stripe, Xendit, Razorpay and PayPal: the owner
connects their gateways in their Ezypay dashboard, and this site talks to Ezypay only. Stripe and PayPal here mean the
owner's own accounts, called directly.

## The kit: `src/platform/payment-providers/` (MANAGED, never edit)
Small server-only `fetch` clients, no SDK to install. Import from the folder:
`import {…} from '../../platform/payment-providers';`

| File | What |
| --- | --- |
| `keys.ts` | the secret names, the mode each provider's keys are in (`providerMode`), `providerReady`, `readyProviders()`, `keyStatus()` (booleans only), `inCurrentMode(row)`, `storedPriceProblem()` |
| `ezypay.ts` | `createEzypayPrice`, `ezypayGateways`, `startEzypayCheckout`, `getEzypayPayment`, `getEzypaySubscription`, `cancelEzypaySubscription`, `verifyEzypayWebhook` |
| `stripe.ts` | `createStripePrice`, `createStripeCheckout`, `getStripeCheckout`, `getStripeSubscription`, `cancelStripeSubscription`, `stripeBillingPortal`, `verifyStripeWebhook` |
| `paypal.ts` | `createPaypalPlan`, `createPaypalSubscription`, `getPaypalSubscription`, `cancelPaypalSubscription`, `verifyPaypalWebhook`, `paypalTransmissionFresh`, `paypalKeysWork` |
| `access.ts` | `grantsAccess(row)`, `needsRecheck(row)`, `settleWithin(promise)` (a re-read a page waits on briefly) |
| `webhook-limit.ts` | `webhookIpAllowed(ip)`: the webhook routes' per-IP limit |
| `money.ts` | `parseAmount(text, currency)`, `toDecimal`, `decimalsOf` (minor units, never floats) |
| `signature.ts`, `http.ts`, `types.ts` | the HMAC check, the one `fetch` wrapper, the shared shapes (`StoredPrice`, `CheckoutStep`, `SubscriptionState`, `ProviderEvent`) |

Every call answers `{ok: true, data}` or `{ok: false, status, code}` and never throws. Each has a timeout: 10 s to
create a price or a checkout, 4 s for the webhook checks and the subscription reads (`get…Subscription`), so a slow
provider never holds a webhook or a page for long. `code` is short
(`not_configured`, `mode_mismatch`, `wrong_provider`, `invalid_input`, `unreachable`, `bad_response`,
`gateway_required`, `in_progress`, or the provider's own error code). Show people your own words, never `code`.
`not_configured` means a key is missing: say which name to add, where (below).

Older site without the folder: below its required version, upgrade first (`AGENTS.md`). If it can't, write the same
calls in `src/server/payments/` following this doc: `fetch` with a timeout, the key from `config.ownerSecret`, the
signature checks below, and the provider's own id for every stored row.

## The owner's keys: names, where to get them, where to add them
The owner adds them on the app's **Secrets** page in the dashboard, each one TWICE: the sandbox value under
**Staging** (the editor, the Preview and the staging site get it) and the live value under **Production** (the live
site). You never see or ask for a value: tell the owner which names to add, in which environment, and where to find
them. Read them only through the kit (it uses `config.ownerSecret`). The mode follows the keys, so test and live never
mix, and a live key in the Preview makes that provider unusable there (the Preview never takes real money).

| Provider | Names (all required) | Mode | Where the owner gets them |
| --- | --- | --- | --- |
| Ezypay | `EZYPAY_SECRET_KEY` (`sk_test_…` / `sk_live_…`), `EZYPAY_PUBLISHABLE_KEY` (`pk_test_…` / `pk_live_…`), `EZYPAY_WEBHOOK_SECRET` (`whsec_…`) | the secret key's prefix; the publishable key must be the same mode | their Ezypay dashboard (https://ezypay.ezycourse.com), API keys, in Test and in Live; the webhook secret is shown once when they add the webhook endpoint (below). Their gateways (Stripe, Xendit, Razorpay, PayPal) are connected in Ezypay, not here. |
| Stripe | `STRIPE_SECRET_KEY` (`sk_…` or a restricted `rk_…`), `STRIPE_WEBHOOK_SECRET` (`whsec_…`) | the key's prefix (`_test_` / `_live_`) | Stripe Dashboard → Developers → API keys (Test mode on for sandbox); the signing secret on the webhook endpoint's page |
| PayPal | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, and `PAYPAL_MODE` (`live` under Production only) | `PAYPAL_MODE=live` → live, else sandbox | developer.paypal.com → Apps & Credentials (Sandbox and Live tabs); the webhook id on the app's Webhooks list |

**Webhook URL to paste** (your route, below): `<the site's address>/site-api/payment-webhooks/<provider>`
(`ezypay`, `stripe` or `paypal`). Sandbox webhooks point at the STAGING site's address, live ones at the live
address (or its custom domain). The Preview gets no webhooks: the thanks page confirms there. Events to send:
- Ezypay: `payment.succeeded`, `payment.failed`, `payment.refunded`, `subscription.canceled`, `subscription.switched`, `subscription.trial_started`.
- Stripe: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, `charge.refunded`.
- PayPal: `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.UPDATED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.EXPIRED`, `PAYMENT.SALE.COMPLETED`.

`.env.example` lists the same names (empty) for a developer's own computer; values go in `.env`, never in git.

## Your tables
The provider is the source of truth; your rows say what was sold and to whom. Add them with a migration (`database.md`):
```prisma
model ProviderSettings {            // one row (id 1): the owner's pick
  id        Int      @id @default(1)
  provider  String?  @db.VarChar(10)          // 'ezypay' | 'stripe' | 'paypal'
  updatedAt DateTime @updatedAt @map("updated_at")
  @@map("provider_settings")
}
model ProviderPrice {
  id              Int      @id @default(autoincrement())
  key             String   @db.VarChar(64)    // your slug: 'pro-monthly'
  name            String   @db.VarChar(120)
  provider        String   @db.VarChar(10)
  mode            String   @db.VarChar(4)     // 'test' | 'live'
  providerPriceId String   @map("provider_price_id") @db.VarChar(120)
  amountMinor     Int      @map("amount_minor")
  currency        String   @db.Char(3)
  interval        String   @db.VarChar(8)     // 'one_time' | 'month' | 'year'
  archivedAt      DateTime? @map("archived_at")
  @@unique([provider, mode, key])
  @@map("provider_prices")
}
model ProviderSubscription {
  id               Int       @id @default(autoincrement())
  userId           Int       @map("user_id")
  priceId          Int       @map("price_id")
  provider         String    @db.VarChar(10)
  mode             String    @db.VarChar(4)
  providerSubId    String    @map("provider_sub_id") @db.VarChar(120)
  customerId       String?   @map("customer_id") @db.VarChar(120)
  status           String    @db.VarChar(12)
  currentPeriodEnd DateTime? @map("current_period_end")
  accessEndsAt     DateTime? @map("access_ends_at")
  checkedAt        DateTime  @default(now()) @map("checked_at")
  @@unique([provider, providerSubId])
  @@index([userId])
  @@map("provider_subscriptions")
}
model ProviderEvent {               // each webhook event handled once
  provider String   @db.VarChar(10)
  eventId  String   @map("event_id") @db.VarChar(120)
  at       DateTime @default(now())
  @@id([provider, eventId])
  @@map("provider_events")
}
model ProviderCheckout {            // one per attempt: its id is the `ref` and the idempotency key
  id          Int      @id @default(autoincrement())
  userId      Int      @map("user_id")
  priceId     Int      @map("price_id")
  provider    String   @db.VarChar(10)
  providerRef String?  @map("provider_ref") @db.VarChar(120) // Stripe `cs_…`, PayPal `I-…`, Ezypay `pay_…`
  status      String   @default("open") @db.VarChar(8)        // 'open' | 'paid' | 'failed'
  createdAt   DateTime @default(now()) @map("created_at")
  @@index([userId])
  @@map("provider_checkouts")
}
```
Never a key, a card or an email in these tables (join on `users.id`).

## 1. The admin: pick the provider, then make prices
One admin screen (`ui.md`), behind a permission of your own (`PAYMENTS_MANAGE: 'site:payments:manage'`, `roles-and-permissions.md`):
- **Payment provider**: `RadioCards` (Ezypay, Stripe, PayPal), each with its `keyStatus(p)`:
  which names are set, the mode (Test or Live), and a plain line for what's wrong (`keyLooksWrong`,
  `modesDiffer`, `liveInPreview`). Only a `providerReady(p)` one can be saved; a not-ready one says which names
  to add on the Secrets page. Save the pick in `ProviderSettings`.
- **Prices**: name, amount (`parseAmount`), currency, one-time / monthly / yearly. Creating one calls the picked
  provider, then stores the row:
```ts
// src/server/routes/provider-admin.ts (behind withViewer → requireAuth → requirePermission(PERMISSIONS.PAYMENTS_MANAGE) → withDb)
import {createEzypayPrice, createPaypalPlan, createStripePrice, providerReady, type Provider} from '../../platform/payment-providers';

const make = (provider: Provider, input: {name: string; amountMinor: number; currency: string; interval: 'one_time' | 'month' | 'year'; idempotencyKey: string}) =>
  provider === 'ezypay' ? createEzypayPrice(input)
  : provider === 'stripe' ? createStripePrice(input)
  : input.interval === 'one_time' ? Promise.resolve({ok: false as const, status: 422, code: 'paypal_subscriptions_only'})
  : createPaypalPlan({...input, interval: input.interval});

// in the POST handler, after the validator:
const settings = await db.providerSettings.findUnique({where: {id: 1}});
const provider = settings?.provider as Provider | undefined;
if (!provider || !providerReady(provider)) return c.json(problem('provider_not_ready', 'Choose a payment provider with its keys added first.'), 409);
// One key per attempt from the form (sent with the request), so a retry makes no second price.
const made = await make(provider, {...body, idempotencyKey: `price:${body.requestKey}`});
if (!made.ok) return c.json(problem('provider_error', 'The payment provider did not make the price. Check the keys and try again.'), 502);
const {providerProductId: _product, ...price} = made.data; // keep the product id too if you need it: add the column
const row = await db.providerPrice.create({data: {key: body.key, name: body.name, ...price}});
```
A price never changes: a new amount is a new price;
archive the old one (`archiveStripePrice`, `deactivatePaypalPlan`; Ezypay in its dashboard) and set `archivedAt`.
The live site makes its own prices with the live keys: prices made in sandbox are `mode: 'test'` and never sell there.
PayPal here is subscriptions only; a one-time PayPal sale goes through Ezypay (its PayPal gateway) or the Orders API in
your own code, with the amount from your stored row.

## 2. Checkout: from a stored price, never an amount
The browser sends your price KEY (and the buyer's gateway pick for Ezypay); the route loads the row, in the mode the
keys are in now, and passes the ROW to the kit. No amount ever comes from the browser.
```ts
// src/server/routes/provider-checkout.ts: POST /site-api/provider-checkout {price, gateway?} (after csrf; signed-in buyer)
import {createPaypalSubscription, createStripeCheckout, ezypayMode, inCurrentMode, paypalMode, startEzypayCheckout, stripeMode,
  type Provider, type StoredPrice} from '../../platform/payment-providers';

const modeOf = (p: Provider) => (p === 'ezypay' ? ezypayMode() : p === 'stripe' ? stripeMode() : paypalMode());

// in the handler:
const provider = (await db.providerSettings.findUnique({where: {id: 1}}))?.provider as Provider | undefined;
const mode = provider ? modeOf(provider) : null;
if (!provider || !mode) return c.json(problem('not_selling', 'Payments are not set up yet.'), 409);
const price = await db.providerPrice.findFirst({where: {key: body.price, provider, mode, archivedAt: null}});
if (!price || !inCurrentMode(price)) return c.json(problem('price_not_found', 'That price is not on sale.'), 404);
const stored = price as StoredPrice;
// One checkout row per buyer and attempt (orders-and-stock.md): its id is the `ref` and the idempotency key.
const checkout = await db.providerCheckout.create({data: {userId: viewer.id, priceId: price.id, provider, status: 'open'}});
const origin = new URL(c.req.url).origin;
const urls = {successUrl: `${origin}/thanks-provider/?ref=${checkout.id}`, cancelUrl: `${origin}/pricing/`};
const key = `checkout:${checkout.id}`;
const res =
  provider === 'stripe' ? await createStripeCheckout({price: stored, ref: String(checkout.id), idempotencyKey: key, ...urls})
  : provider === 'paypal' ? await createPaypalSubscription({price: stored, ref: String(checkout.id), idempotencyKey: key, returnUrl: urls.successUrl, cancelUrl: urls.cancelUrl})
  : await startEzypayCheckout({price: stored, ref: String(checkout.id), gateway: body.gateway, idempotencyKey: key, ...urls});
if (!res.ok) return c.json(problem('checkout_failed', 'The payment could not be started. Try again in a minute.'), 502);
await db.providerCheckout.update({where: {id: checkout.id}, data: {providerRef: 'sessionId' in res.data ? res.data.sessionId : 'subscriptionId' in res.data ? res.data.subscriptionId : res.data.paymentId}});
return c.json({id: String(checkout.id), embedded: res.data.step});
```
- The answer's `embedded` is the built-in checkout's shape, so the page opens it with `openCheckout({id, embedded})`
  from `src/lib/checkout-session.ts`: a payment window for Stripe Checkout, PayPal and Ezypay's hosted pages, Ezypay's
  Razorpay popup over the page (add its hosts to that page only: `allowEmbeddedCheckout(Astro.csp, 'razorpay')`).
  `element` (Ezypay with `method: 'element'`, one-time) needs Stripe's form: `allowEmbeddedCheckout(Astro.csp, 'stripe')`
  and the `EmbeddedCheckout` island; use `hosted` unless asked.
- Ezypay with several gateways: `ezypayGateways()` lists the owner's active ones; the buyer picks (one: no question).
  A monthly or yearly Ezypay price needs the pick (`gateway_required`). `in_progress` (409): call again with the same key.
- Signed-in buyers only when the purchase opens content, so the subscription is tied to `users.id` at once.

## 3. The thanks page confirms (never the URL alone)
`/thanks-provider/?ref=<checkout id>` asks your route, which asks the PROVIDER, then records it:
- Stripe: `getStripeCheckout(session_id)` (Stripe adds `session_id` to the success URL); `status: 'paid'` and its
  `ref` must be this checkout. A subscription comes back in `data.subscription`: upsert it (below).
- PayPal: `getPaypalSubscription(subscription_id)` (PayPal adds `subscription_id`); `active` and `ref` = this checkout.
- Ezypay one-time: `getEzypayPayment(paymentId)` you stored; `paid` and `ref` = this checkout. An Ezypay
  SUBSCRIPTION's first payment comes only as the `payment.succeeded` event (its `ref` and `subscriptionId`): show
  "Confirming your payment…" and look again every few seconds until your webhook recorded it.
Check the row belongs to the signed-in buyer (in the `where`), and that the provider's price id is the stored one.

## 4. Webhooks: verified on the raw body, handled once, then re-read
Its own Hono app, mounted in `src/server/app.ts` BEFORE `sameOrigin` and `csrf` (the providers post cross-site, with
no CSRF token), with its own body limit:
```ts
// src/server/routes/provider-webhooks.ts
import {type Context, Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {getEzypaySubscription, getPaypalSubscription, getStripeSubscription, providerMode, verifyEzypayWebhook,
  verifyPaypalWebhook, verifyStripeWebhook, webhookIpAllowed, type ProviderEvent} from '../../platform/payment-providers';
import {getDb} from '../../platform/db';

export const providerWebhooks = new Hono()
  // Per-IP limit FIRST, before the body is read: anyone can post here, and a post can cost a call to the provider.
  .use(async (c, next) => (webhookIpAllowed(c.req.header('cf-connecting-ip')) ? next() : c.json({error: 'rate_limited'}, 429)))
  .use(bodyLimit({maxSize: 256 * 1024}))
  .post('/stripe', async c => handle(c, 'stripe', await verifyStripeWebhook(await c.req.text(), c.req.header('stripe-signature'))))
  .post('/paypal', async c => handle(c, 'paypal', await verifyPaypalWebhook(c.req.raw.headers, await c.req.text())))
  .post('/ezypay', async c => handle(c, 'ezypay', await verifyEzypayWebhook(await c.req.text(), c.req.header('ezy-signature'))));

async function handle(c: Context, provider: 'stripe' | 'paypal' | 'ezypay', event: ProviderEvent | null) {
  if (!event) return c.json({error: 'bad_signature'}, 400);
  if (event.mode !== providerMode(provider)) return c.json({ok: true}); // the other copy's (sandbox vs live): ignore
  const db = getDb();
  if (!db) return c.json({error: 'retry'}, 503);
  // Once per event id: the primary key refuses a second insert.
  const fresh = await db.providerEvent.createMany({data: [{provider, eventId: event.id}], skipDuplicates: true});
  if (fresh.count === 0) return c.json({ok: true});
  try {
    // NEVER trust the event body: re-read the subscription from the provider, then upsert your row.
    const subId = subscriptionIdOf(provider, event); // `sub_…` (Stripe object / invoice.subscription), `I-…` (PayPal resource.id), Ezypay `sub_…` or the payment's subscriptionId
    if (subId) {
      const known = await db.providerSubscription.findUnique({where: {provider_providerSubId: {provider, providerSubId: subId}}});
      const sub = provider === 'stripe' ? await getStripeSubscription(subId)
        : provider === 'paypal' ? await getPaypalSubscription(subId, {knownPeriodEnd: known?.currentPeriodEnd})
        : await getEzypaySubscription(subId);
      if (!sub.ok) throw new Error('re-read failed');
      await upsertSubscription(db, sub.data, event); // by (provider, providerSubId); user from your checkout row via `sub.data.ref`
    }
    // One-time sales: Stripe `checkout.session.completed` → getStripeCheckout(objectId); Ezypay `payment.succeeded`
    // without a subscription → getEzypayPayment(objectId); then mark your checkout paid (only if it isn't already).
    return c.json({ok: true});
  } catch {
    await db.providerEvent.delete({where: {provider_eventId: {provider, eventId: event.id}}}); // let the retry run it
    return c.json({error: 'retry'}, 500);
  }
}
```
```ts
// src/server/app.ts: right after `.basePath('/site-api')` and `.use(previewCookies)`, BEFORE `.use(sameOrigin)`
  .route('/payment-webhooks', providerWebhooks)
```
- **A per-IP limit on `/site-api/payment-webhooks/*`**, before anything else (the first `.use` above):
  `webhookIpAllowed(c.req.header('cf-connecting-ip'))`, 60 posts a minute per address, in memory (no database row,
  no call), 429 past it. Keep it on every webhook route you add. It holds back a flood; the checks below are the gate.
- Stripe and Ezypay sign `t=<unix>,v1=<hex>` (HMAC-SHA256 of `<t>.<raw body>`), checked in constant time within 5
  minutes. PayPal is checked by PayPal (`verify-webhook-signature`) with the RAW text spliced in. Always
  `await c.req.text()` first; never `c.req.json()` before the check.
- PayPal: a delivery whose `paypal-transmission-time` is more than 5 minutes off is dropped BEFORE PayPal's verify
  call (`paypalTransmissionFresh(headers)`; `verifyPaypalWebhook` runs it first), so an old delivery replayed, or a
  flood of made-up ones, costs no call. Without the kit, check it yourself the same way, first.
- Ezypay: a delivery with `ezy-signature` must match `EZYPAY_WEBHOOK_SECRET`; then, signed or not, the kit reads the
  event again from Ezypay by its id with the secret key and returns only that copy. Pass `{requireSignature: true}`
  (an unsigned post refused at once, no call) when Ezypay documents that every delivery is signed (its OpenAPI or SDK
  changelog), or when the owner tells you their Ezypay webhook shows every delivery signed. Until then an unsigned
  post is safe (only Ezypay's own copy is used) and costs one re-read, which the per-IP limit bounds.
- Events come more than once and out of order: the event table makes each run once, and the re-read makes the row
  match the provider whatever the order. One-time work (a welcome email) only when the row is NEW, or in a job with a
  `key` (`background-jobs.md`). Slow work goes in a job; answer within a few seconds.
- Ezypay `subscription.switched`: move the buyer to the new subscription and keep access (not a cancel).

## 5. Cancel and manage
The member's own screen in the portal lists their rows (`where: {userId: viewer.id}`) with Cancel (`useConfirm`):
- Stripe: `cancelStripeSubscription(id)` (at the period end) or `stripeBillingPortal(customerId, returnUrl)` for
  card, invoices and cancel on Stripe's page.
- PayPal: `cancelPaypalSubscription(id)` stops billing now; keep access to the stored `currentPeriodEnd`
  (`getPaypalSubscription(id, {knownPeriodEnd})`).
- Ezypay: `cancelEzypaySubscription(id, {atPeriodEnd: true})`; the gateway confirms later with
  `subscription.canceled`, whose `accessEndsAt` decides access.
Then upsert the row from the answer (or re-read it). The admin may cancel any member's, behind its permission, audited.

## 6. Access rules
`grantsAccess(row)` from `access.ts`, on your subscription row, in every gated route and page (`requirePermission`
first where it applies):
- `active`, `trialing`, `past_due`: open until the period end (plus 3 days for a late renewal event). After that the
  row needs a re-check (`needsRecheck(row)`): read it from the provider again (at most every 10 minutes per row,
  `checkedAt`), upsert, then decide. A missed webhook never opens anything for ever, and never locks out someone who renewed.
- A page never waits long on that re-read: `settleWithin(reread)` waits 1.5 s at most, then the STORED row decides
  and the re-read finishes after the answer (`waitUntil`), so the next page sees the fresh row:
```ts
// src/server/payments/access.ts: one helper for every gated route and page
import {getEzypaySubscription, getPaypalSubscription, getStripeSubscription, grantsAccess, needsRecheck, RECHECK_MS,
  settleWithin} from '../../platform/payment-providers';

export async function hasPaidAccess(db: Db, userId: number): Promise<boolean> {
  const rows = await db.providerSubscription.findMany({where: {userId}, orderBy: {id: 'desc'}, take: 10});
  if (rows.some(r => grantsAccess(r))) return true;
  const due = rows.find(r => needsRecheck(r) && r.checkedAt.getTime() + RECHECK_MS <= Date.now());
  if (!due) return false;
  // Claim the re-read (a conditional write on checkedAt), so ten open tabs make one call, not ten.
  const claimed = await db.providerSubscription.updateMany({where: {id: due.id, checkedAt: due.checkedAt}, data: {checkedAt: new Date()}});
  if (claimed.count === 0) return false;
  const reread = (async () => {
    const sub = due.provider === 'stripe' ? await getStripeSubscription(due.providerSubId)
      : due.provider === 'paypal' ? await getPaypalSubscription(due.providerSubId, {knownPeriodEnd: due.currentPeriodEnd})
      : await getEzypaySubscription(due.providerSubId);
    if (!sub.ok) return null; // timeout or error: the stored row stands (fails closed), tried again in 10 minutes
    return db.providerSubscription.update({where: {id: due.id},
      data: {status: sub.data.status, currentPeriodEnd: sub.data.currentPeriodEnd, accessEndsAt: sub.data.accessEndsAt}});
  })();
  const fresh = await settleWithin(reread); // null: slower than 1.5 s (it goes on after the answer) or failed
  return fresh ? grantsAccess(fresh) : false;
}
```
  Slower than that, the page shows its "not subscribed" state with a line like "Checking your renewal. Refresh in a
  moment." Never wait on the provider without a cap, and never open the content because the re-read timed out.
- `canceled`: open until `accessEndsAt`. `incomplete`: never.
- Only rows in the mode the keys are in now (`inCurrentMode`): a sandbox subscription never opens the live site.
- Never cache an access decision; never decide it in the browser.

## Security rules (all of them, every time)
- Keys are server-only: only through the kit (`config.ownerSecret`); never in code, the database, a log, an error, a
  response, the browser, `.env` in git, or a test fixture that looks real. `keyStatus` is booleans only.
- Webhooks: a per-IP limit first (`webhookIpAllowed`), then verified on the RAW body before anything else (a stale
  PayPal transmission time dropped before PayPal's call), each event id handled once, the subscription or payment
  re-read from the provider before anything changes. A failed check answers 400 and changes nothing.
- Amounts only from stored prices: the browser sends a price key; the route loads the row (`provider`, `mode`, not
  archived) and passes the ROW (`storedPriceProblem` refuses another provider's or the other mode's). Never an amount,
  a provider price id or a currency from the browser, a hidden field or a query string.
- CSRF on every write (`csrf` and `sameOrigin` stay), except the webhook routes, which have their own signature check.
- Every checkout, charge, refund and cancel carries an idempotency key made from your own row (`checkout:<id>`),
  never random per try (`orders-and-stock.md`).
- Outside calls fail closed: an error, a timeout or an unexpected answer never marks anything paid or opens access.
- Run `review.md` at the end, and test the webhook route with a bad, a stale and a good signature.

## Ezypay: what is confirmed
Confirmed in Ezypay's official SDK (0.2.0) and its OpenAPI (`/api/openapi.json`): products and prices
(`POST /products`, `POST /products/{id}/prices`), connected gateways, `POST /payments` (the answer's `checkoutUrl`, or
`clientSecret` + `publishableKey`), `GET /payments/{id}`, `GET /subscriptions/{id}`,
`POST /subscriptions/{id}/cancel {atPeriodEnd}`, `GET /events/{id}`, the `ezy-signature` scheme, and the rule that
`accessEndsAt` decides access on `subscription.canceled`. Not documented yet, read defensively by the kit: the request
body of `POST /checkout/sessions` (a subscription's checkout), the popup answer (`clientCheckout`), whether every
delivery is signed, and how a subscription checkout is confirmed without its event.

## Never
- One provider hard-coded, or chosen in code: the owner picks, in the admin, among the ready ones.
- A key in code, the database, a log or the browser; asking the owner for a key's value.
- An amount, a currency or a provider price id from the browser.
- A webhook trusted without its check, parsed before it, or acted on from its body without the re-read.
- Access from the success URL alone, from `localStorage`, or from a row in the other mode.
- Editing `src/platform/payment-providers/` (managed): wrap it in `src/server/`.
