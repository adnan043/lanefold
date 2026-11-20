/**
 * One call to a payment provider's API (`docs/agent/payments-providers.md`): a fixed https origin
 * written in the caller, a timeout (10 s; 4 s on the webhook and access re-read paths), JSON back, and an answer that never carries the key, the
 * request or the provider's error message (it can echo request fields): only the HTTP status and
 * the provider's own short error code. Fails closed: anything but a 2xx is `ok: false`, so nothing
 * is ever marked paid on a failure. Server only.
 */

export type ProviderResult<T> = {ok: true; data: T} | {ok: false; status: number; code: string};

/** Codes the kit itself answers (besides the provider's own error codes). */
export type KitCode =
  | 'not_configured' // a key is missing, or its mode can't be used here (a live key in the Preview)
  | 'unreachable' // the provider didn't answer in time
  | 'bad_response' // the answer wasn't the shape this kit checks for
  | 'mode_mismatch' // the provider answered in the other mode than the keys (or the stored price)
  | 'wrong_provider' // a stored price of another provider was passed in
  | 'invalid_input'; // the kit refused the input before calling (an id or URL that can't be right)

export const fail = (status: number, code: KitCode | string): {ok: false; status: number; code: string} => ({ok: false, status, code});

export const TIMEOUT_MS = 10_000;
/**
 * Webhook checks and subscription re-reads (a gated page, a webhook's re-read): a provider slower
 * than this answers `unreachable` and the caller falls back (400 to the webhook: it is sent again;
 * the stored row on a page). Checkout creation keeps TIMEOUT_MS.
 */
export const QUICK_TIMEOUT_MS = 4_000;

/** The provider's short error code from an error body (Stripe `error.code`, PayPal `name`, Ezypay `code`). */
function errorCode(body: Record<string, unknown> | null): string {
  if (!body) return 'error';
  const err = body.error as {code?: unknown; type?: unknown} | string | undefined;
  if (err && typeof err === 'object') {
    if (typeof err.code === 'string') return err.code;
    if (typeof err.type === 'string') return err.type;
  }
  if (typeof body.code === 'string') return body.code;
  if (typeof body.name === 'string') return body.name;
  const errors = body.errors as {code?: unknown}[] | undefined;
  if (Array.isArray(errors) && typeof errors[0]?.code === 'string') return errors[0].code;
  return typeof err === 'string' ? err : 'error';
}

/**
 * `label` names the call in the log (`stripe POST /prices`), never an id, an email or a key.
 * A 204 (no body) is `{}`. `timeoutMs`: TIMEOUT_MS, or QUICK_TIMEOUT_MS on the fast paths.
 */
export async function providerCall<T>(url: string, init: RequestInit, label: string, timeoutMs = TIMEOUT_MS): Promise<ProviderResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {...init, signal: AbortSignal.timeout(timeoutMs)});
  } catch {
    console.error(`[payment-providers] ${label}: unreachable`);
    return fail(0, 'unreachable');
  }
  if (res.status === 204) return res.ok ? {ok: true, data: {} as T} : fail(res.status, 'error');
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = errorCode(body).slice(0, 60);
    console.error(`[payment-providers] ${label}: ${res.status} ${code}`);
    return fail(res.status, code);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res.status, 'bad_response');
  return {ok: true, data: body as T};
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** An ISO date (or unix seconds) → Date, or null. */
export function dateOf(v: unknown): Date | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000);
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A return or cancel URL the kit sends a provider: absolute https (http only for localhost). */
export function isReturnUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname));
  } catch {
    return false;
  }
}

/** Metadata the kit sends: at most 20 short string pairs. Never an email, a token or a key. */
export function cleanMetadata(meta: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta ?? {}).slice(0, 20)) {
    if (/^[A-Za-z0-9_]{1,40}$/.test(k) && typeof v === 'string') out[k] = v.slice(0, 200);
  }
  return out;
}
