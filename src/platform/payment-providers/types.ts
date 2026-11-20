import type {Mode, Provider} from './keys';

/**
 * Shapes shared by the three providers (`docs/agent/payments-providers.md`). The site keeps its own
 * rows (its prices, checkouts, subscriptions) in its own tables; the provider is the source of truth
 * for whether something is paid.
 */

export type Interval = 'one_time' | 'month' | 'year';

/**
 * A price as the SITE stored it when the admin created it (`create…Price`). Checkout takes this row,
 * never an amount from the browser: the provider charges the amount it holds for `providerPriceId`.
 */
export interface StoredPrice {
  provider: Provider;
  /** The mode the price was made in: a test price never sells once the live keys are in. */
  mode: Mode;
  /** Stripe `price_…`, PayPal `P-…` (a billing plan), Ezypay `price_…`. */
  providerPriceId: string;
  amountMinor: number;
  currency: string;
  interval: Interval;
}

/** What a `create…Price` call made, to store as a `StoredPrice` row (with your own key and name). */
export interface CreatedPrice extends StoredPrice {
  /** Stripe `prod_…`, PayPal `PROD-…`, Ezypay `prod_…`. */
  providerProductId: string;
}

/**
 * How the buyer pays, in the same shape as the built-in checkout's `embedded`
 * (`src/platform/payments.ts` `EmbeddedCheckout`), so `openCheckout()` from
 * `src/lib/checkout-session.ts` opens it:
 *   element  the provider's form in the page (Ezypay with Stripe)
 *   popup    the provider's popup over the page (Ezypay with Razorpay)
 *   window   the provider's own page in a small payment window (Stripe Checkout, PayPal, Ezypay's hosted)
 */
export type CheckoutStep =
  | {kind: 'element'; gateway: string; clientSecret: string; publishableKey: string; gatewayAccountId?: string | null; returnUrl: string; cancelUrl?: string}
  | {kind: 'popup'; gateway: string; clientCheckout: {scriptUrl: string; clientGlobal: string; options: Record<string, unknown>; dismissCallback: string | null}; returnUrl: string; cancelUrl?: string}
  | {kind: 'window'; gateway: string; checkoutUrl: string; returnUrl: string; cancelUrl?: string};

/** The statuses the site keeps, like the built-in memberships, plus `incomplete` (not paid yet: opens nothing). */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';

/** A subscription at the owner's provider, as the site keeps it. Re-read it from the provider on every event. */
export interface SubscriptionState {
  provider: Provider;
  /** Stripe `sub_…`, PayPal `I-…`, Ezypay `sub_…`. */
  id: string;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  /** When access ends for a cancelled one (null while it renews). */
  accessEndsAt: Date | null;
  /** The provider's price or plan id: check it is the price the checkout was for. */
  priceId: string | null;
  /** The provider's customer id (Stripe `cus_…`, Ezypay `cus_…`): the Billing Portal needs it. */
  customerId: string | null;
  /** Your reference, carried by the provider (Stripe and Ezypay `metadata.ref`, PayPal `custom_id`). */
  ref: string | null;
  /** The mode the provider says it is in (Stripe `livemode`, Ezypay `mode`); null when it doesn't say. */
  mode: Mode | null;
}

export interface ProviderEvent {
  /** The provider's event id: handle each one once (a unique index on it). */
  id: string;
  type: string;
  /** The id of the object the event is about (`sub_…`, `cs_…`, `pi_…`): re-read it, never trust the body. */
  objectId: string | null;
  /** The mode of the event (Stripe, Ezypay; PayPal: the keys' mode): compare it with the keys' mode. */
  mode: 'test' | 'live' | null;
  /** The object as it came (for its `metadata.ref` and the like). Decide nothing from it alone. */
  object: Record<string, unknown> | null;
}

/** A provider's answer: the kit's result type, re-exported for one import. */
export type {ProviderResult} from './http';
