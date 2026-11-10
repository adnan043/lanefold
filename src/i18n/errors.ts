/**
 * Server errors in the user's language. Our routes answer
 * `{error: 'code', message: 'English', fields?, fieldCodes?}`: show
 * `errors.<code>` when the catalog has it, else the server's `message`
 * (managed auth errors only have a message), else a generic line.
 */
export interface ErrorLike {
  code?: string;
  message?: string;
  fields?: Record<string, string>;
  fieldCodes?: Record<string, string>;
}

export type Lookup = (key: string) => string | undefined;

/**
 * Codes that share another code's message. The payment platform's codes reach the client lowercased
 * (`e_price_key`...): they are our fault or the gateway's, never the visitor's, so they all say "payments
 * are not available right now".
 */
export const ERROR_ALIASES: Record<string, string> = {
  E_SITE_PAYMENTS_TRIAL_USED: 'trial_used',
  e_site_payments_trial_used: 'trial_used',
  E_PLATFORM_UNREACHABLE: 'platform_unreachable',
  e_platform_unreachable: 'platform_unreachable',
  E_NO_PLATFORM: 'platform_unreachable',
  e_no_platform: 'platform_unreachable',
  e_not_found: 'not_found',
  storage_limit: 'storage_quota',
  storage_limit_reached: 'storage_quota',
  e_gateway: 'payments_unavailable',
  e_payments_editor_only: 'payments_unavailable',
  e_price_key: 'payments_unavailable',
  E_PRICE_NOT_FOUND: 'payments_unavailable',
  e_price_not_found: 'payments_unavailable',
  e_price_name: 'payments_unavailable',
  e_price_amount: 'payments_unavailable',
  e_price_currency: 'payments_unavailable',
  e_price_interval: 'payments_unavailable',
  e_quantity: 'payments_unavailable',
  e_return_path: 'payments_unavailable',
  e_email: 'payments_unavailable',
  e_name: 'payments_unavailable',
  e_customer_ref: 'payments_unavailable',
  e_metadata: 'payments_unavailable',
};

const keyOf = (code: string) => `errors.${ERROR_ALIASES[code] ?? code}`;

export function errorText(lookup: Lookup, error: ErrorLike | null | undefined): string {
  const byCode = error?.code ? lookup(keyOf(error.code)) : undefined;
  return byCode ?? (error?.message || lookup('errors.unknown') || 'Something went wrong.');
}

/** Field errors by field name: `fieldCodes` first, the server's English `fields` as the fallback. */
export function fieldErrorTexts(lookup: Lookup, error: ErrorLike | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, message] of Object.entries(error?.fields ?? {})) out[name] = message;
  for (const [name, code] of Object.entries(error?.fieldCodes ?? {})) {
    const text = lookup(keyOf(code));
    if (text) out[name] = text;
  }
  return out;
}

/** Codes that mean "your plan stops this": the app shows a toast with a "See plans" action (`plan-limits.tsx`). */
export const PLAN_LIMIT_CODES = ['plan_limit', 'workspace_limit', 'member_limit_reached', 'limit_reached', 'workspace_read_only', 'read_only', 'storage_limit', 'storage_limit_reached', 'storage_quota', 'file_too_large'] as const;

export function isPlanLimitCode(code: string | undefined): boolean {
  return code !== undefined && (PLAN_LIMIT_CODES as readonly string[]).includes(code);
}
