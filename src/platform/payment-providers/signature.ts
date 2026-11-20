import {constantTimeEqualText, toHex, utf8} from '../auth/encoding';

/**
 * The timestamped HMAC signature Stripe (`Stripe-Signature`) and Ezypay (`ezy-signature`) both use:
 * `t=<unix seconds>,v1=<hex>[,v1=…]`, each `v1` the HMAC-SHA256 of `<t>.<raw body>` with the
 * endpoint's signing secret (`whsec_…`). Checked over the RAW body (the exact text that arrived,
 * never parsed and serialized again), compared in constant time, and refused outside the tolerance
 * (5 minutes either way), so an old delivery can't be replayed.
 */

/** How old (or how far ahead) a signed delivery may be: 5 minutes, the providers' own default. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', utf8(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(payload))));
}

export async function verifyTimestampedSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string | null | undefined,
  {nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS} = {}
): Promise<boolean> {
  if (!header || !secret || header.length > 2000 || typeof rawBody !== 'string') return false;
  let t: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map(s => s?.trim());
    if (k === 't' && v && /^\d{1,12}$/.test(v)) t = Number(v);
    else if (k === 'v1' && v && /^[0-9a-f]{64}$/i.test(v)) signatures.push(v.toLowerCase());
  }
  if (t === null || !signatures.length) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  let ok = false;
  // Every candidate is compared (no early exit), each in constant time.
  for (const sig of signatures) if (constantTimeEqualText(sig, expected)) ok = true;
  return ok;
}

/** Signs a payload the same way (tests and local tries only). */
export async function signTimestamped(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${rawBody}`)}`;
}
