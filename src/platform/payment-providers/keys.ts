import {config} from '../config';

/**
 * The OWNER's own payment provider keys (`docs/agent/payments-providers.md`): which secrets each
 * provider needs, and which mode they are in. Reads only the site's environment through
 * `config.ownerSecret` (never the database or the network), so it is cheap enough for every access
 * decision.
 *
 * The owner adds each secret in the dashboard's secret manager TWICE: the sandbox value (staging and
 * the Preview get it) and the live value (the live site gets it). The site never chooses the mode;
 * it follows the keys, so test and live never mix:
 *
 *   ezypay  EZYPAY_SECRET_KEY's prefix: `sk_test_` → test, `sk_live_` → live. The publishable key
 *           (`pk_test_` / `pk_live_`) must be in the same mode, or the provider can't be used.
 *   stripe  STRIPE_SECRET_KEY's prefix: `sk_test_` / `rk_test_` → test, `sk_live_` / `rk_live_` → live.
 *   paypal  PAYPAL_MODE: `live` → live (api-m.paypal.com); anything else or unset → sandbox.
 *
 * The Preview never takes real money: a live key there makes the provider unusable (`null`).
 * Key VALUES never leave the server: no response, log or row ever holds one (`keyStatus` is
 * booleans only).
 */

export type Provider = 'ezypay' | 'stripe' | 'paypal';
export type Mode = 'test' | 'live';

export const PROVIDERS: readonly Provider[] = ['ezypay', 'stripe', 'paypal'];
export const isProvider = (value: unknown): value is Provider => value === 'ezypay' || value === 'stripe' || value === 'paypal';

/** The provider's name, as people read it. */
export const PROVIDER_NAMES: Record<Provider, string> = {ezypay: 'Ezypay', stripe: 'Stripe', paypal: 'PayPal'};

/** The secret names, as the owner types them in the secret manager. All are required. */
export const SECRET_NAMES = {
  ezypay: ['EZYPAY_SECRET_KEY', 'EZYPAY_PUBLISHABLE_KEY', 'EZYPAY_WEBHOOK_SECRET'],
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  paypal: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_WEBHOOK_ID'],
} as const;

/** PayPal's mode: not a secret, but kept beside them so sandbox and live each get their own value. */
export const PAYPAL_MODE_NAME = 'PAYPAL_MODE';

export type SecretName = (typeof SECRET_NAMES)[Provider][number];

/** Server only: one of the provider secrets (null when the owner hasn't added it). Never log or return it. */
export const secretValue = (name: SecretName | typeof PAYPAL_MODE_NAME): string | null => config.ownerSecret(name)?.trim() || null;

const usable = (mode: Mode | null): Mode | null => (mode === 'live' && config.preview ? null : mode);

/** `sk_test_…` → test, `sk_live_…` → live, else null. */
export function ezypayKeyMode(key: string | null): Mode | null {
  const m = key ? /^sk_(test|live)_[A-Za-z0-9]{8,}$/.exec(key) : null;
  return m ? (m[1] as Mode) : null;
}

/** `pk_test_…` → test, `pk_live_…` → live, else null. */
export function ezypayPublishableMode(key: string | null): Mode | null {
  const m = key ? /^pk_(test|live)_[A-Za-z0-9]{8,}$/.exec(key) : null;
  return m ? (m[1] as Mode) : null;
}

export function ezypayMode(): Mode | null {
  const mode = ezypayKeyMode(secretValue('EZYPAY_SECRET_KEY'));
  const publishable = secretValue('EZYPAY_PUBLISHABLE_KEY');
  // A publishable key of the other mode would start a checkout in the other mode.
  if (publishable && ezypayPublishableMode(publishable) !== mode) return null;
  return usable(mode);
}

/** `sk_test_` / `rk_test_` → test, `sk_live_` / `rk_live_` → live, else null (a `pk_…` key, say). */
export function stripeKeyMode(key: string | null): Mode | null {
  if (!key) return null;
  return /^(sk|rk)_test_/.test(key) ? 'test' : /^(sk|rk)_live_/.test(key) ? 'live' : null;
}

export const stripeMode = (): Mode | null => usable(stripeKeyMode(secretValue('STRIPE_SECRET_KEY')));

export function paypalMode(): Mode | null {
  if (!secretValue('PAYPAL_CLIENT_ID') || !secretValue('PAYPAL_CLIENT_SECRET')) return null;
  return usable(secretValue(PAYPAL_MODE_NAME)?.toLowerCase() === 'live' ? 'live' : 'test');
}

/** The mode the provider's keys are in here, or null when it can't be used (keys missing or wrong). */
export const providerMode = (provider: Provider): Mode | null =>
  provider === 'ezypay' ? ezypayMode() : provider === 'stripe' ? stripeMode() : paypalMode();

/** Every secret the provider needs is set and its mode is known: it can sell and hear its webhooks. */
export function providerReady(provider: Provider): boolean {
  return SECRET_NAMES[provider].every(name => Boolean(secretValue(name))) && providerMode(provider) !== null;
}

/** The providers ready here, for the admin's "Payment provider" choice. */
export const readyProviders = (): Provider[] => PROVIDERS.filter(providerReady);

/**
 * For the admin's payments screen: which names are set (booleans only, never a value), the mode,
 * and what looks wrong, so the owner knows which secret to fix.
 */
export function keyStatus(provider: Provider) {
  const names = SECRET_NAMES[provider] as readonly SecretName[];
  const secret = provider === 'ezypay' ? secretValue('EZYPAY_SECRET_KEY') : provider === 'stripe' ? secretValue('STRIPE_SECRET_KEY') : null;
  const keyMode = provider === 'ezypay' ? ezypayKeyMode(secret) : provider === 'stripe' ? stripeKeyMode(secret) : null;
  const publishable = provider === 'ezypay' ? secretValue('EZYPAY_PUBLISHABLE_KEY') : null;
  const liveKey = provider === 'paypal' ? secretValue(PAYPAL_MODE_NAME)?.toLowerCase() === 'live' : keyMode === 'live';
  return {
    provider,
    secrets: names.map(name => ({name, set: Boolean(secretValue(name))})),
    mode: providerMode(provider),
    ready: providerReady(provider),
    /** The secret key isn't a secret key (a publishable `pk_…` one pasted in its place, say). */
    keyLooksWrong: Boolean(secret) && keyMode === null,
    /** Ezypay: the publishable key is of the other mode than the secret key. */
    modesDiffer: provider === 'ezypay' && Boolean(publishable) && ezypayPublishableMode(publishable) !== keyMode,
    /** A live key in the Preview: the Preview only ever takes test payments. */
    liveInPreview: config.preview && liveKey,
  };
}

/**
 * Does a stored row (a price, a subscription, an order) belong to what the keys are now? A test row
 * never counts once the live keys are in, and a live one never on a sandbox copy. Use it in every
 * access decision and every list of prices the buyer can pick from.
 */
export function inCurrentMode(row: {provider: string; mode: string}): boolean {
  if (!isProvider(row.provider)) return false;
  const mode = providerMode(row.provider);
  return mode !== null && row.mode === mode;
}

/**
 * Why a stored price can't be sold here now, or null when it can: another provider's, made in the
 * other mode than the keys are in now, or the keys aren't usable. Checkout calls it first.
 */
export function storedPriceProblem(
  price: {provider: string; mode: string; providerPriceId?: unknown} | null | undefined,
  provider: Provider
): 'wrong_provider' | 'not_configured' | 'mode_mismatch' | 'invalid_input' | null {
  if (!price || price.provider !== provider) return 'wrong_provider';
  if (typeof price.providerPriceId !== 'string' || !price.providerPriceId) return 'invalid_input';
  const mode = providerMode(provider);
  if (!mode) return 'not_configured';
  return price.mode === mode ? null : 'mode_mismatch';
}
