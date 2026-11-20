/**
 * Amounts for the owner's own provider (`docs/agent/payments-providers.md`). Every amount is an
 * integer in the currency's MINOR units, the way Stripe counts them (cents; JPY and the other
 * zero-decimal currencies in whole units). Never floats: an amount the owner types is read as text.
 * Browser-safe (the admin's price form can use `parseAmount` too).
 */

/** Currencies with no minor unit (Stripe's list): 1400 JPY is `1400`, not `140000`. */
export const ZERO_DECIMAL: ReadonlySet<string> = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export const decimalsOf = (currency: string): number => (ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2);

/** A three-letter currency code, upper case, or null. */
export function cleanCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** The most a price may be, in minor units: a typo guard, not a business rule. */
export const MAX_MINOR = 100_000_000;

/**
 * "14", "14.5", "14.50", "1,400" → minor units for the currency, or a sentence saying what's wrong.
 * `min` is the lowest the site allows (in minor units; the provider's own minimum still applies).
 */
export function parseAmount(input: string, currency: string, {min = 1}: {min?: number} = {}): {minor: number} | {error: string} {
  const decimals = decimalsOf(currency);
  const text = input.trim().replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d+))?$/.exec(text);
  if (!m) return {error: decimals ? 'Enter an amount like 14 or 14.50.' : 'Enter a whole amount like 1400.'};
  const fraction = m[2] ?? '';
  if (fraction.length > decimals) return {error: decimals ? `Use up to ${decimals} decimals.` : `${currency.toUpperCase()} has no decimals: enter a whole amount.`};
  const minor = Number(m[1]) * 10 ** decimals + Number(fraction.padEnd(decimals, '0') || '0');
  if (minor < min) return {error: `The lowest price is ${toDecimal(min, currency)} ${currency.toUpperCase()}.`};
  if (minor > MAX_MINOR) return {error: `The highest price is ${toDecimal(MAX_MINOR, currency)} ${currency.toUpperCase()}.`};
  return {minor};
}

/** Minor units → the decimal text PayPal wants ("14.00"; "1400" for JPY). */
export function toDecimal(minor: number, currency: string): string {
  const decimals = decimalsOf(currency);
  if (!decimals) return String(minor);
  const s = String(Math.abs(minor)).padStart(decimals + 1, '0');
  return `${minor < 0 ? '-' : ''}${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** True for a whole, positive amount within the limits. */
export const isAmount = (minor: unknown): minor is number => Number.isInteger(minor) && (minor as number) > 0 && (minor as number) <= MAX_MINOR;
