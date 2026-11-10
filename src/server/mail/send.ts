import {config} from '../../platform/config';

/**
 * A small, provider-agnostic mail sender. The default provider speaks the Resend-compatible JSON API.
 *
 * Owner secrets (docs/product/owner-actions.md, Phase 11): `RESEND_API_KEY` and `MAIL_FROM` (the verified sender,
 * `Lanefold <no-reply@example.com>`). Both are read ONLY through `config.ownerSecret`; `null` means "email is not
 * set up". Nothing here ever logs or returns a body, an address, a token or the key: callers get a status kind and,
 * at most, the provider's HTTP status code and message id.
 */

/** Fixed origin: never built from input. */
const ENDPOINT = 'https://api.resend.com/emails';
export const MAIL_TIMEOUT_MS = 8_000;

export interface MailCredentials {
  apiKey: string;
  from: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Sent as `Idempotency-Key`: a retry of the same message is never delivered twice by the provider. */
  idempotencyKey?: string;
}

export type MailResult =
  | {kind: 'sent'; id: string | null}
  /** Owner secrets missing: nothing was attempted. */
  | {kind: 'not_configured'}
  /** Worth trying again later: a 5xx, a 429, a timeout, a network error. */
  | {kind: 'retry'; status: number | null}
  /** Trying again cannot help: a 4xx, a redirect, a refused message. */
  | {kind: 'failed'; status: number | null};

/** The owner's mail settings, or `null` when not added. */
export function mailCredentials(): MailCredentials | null {
  const apiKey = config.ownerSecret('RESEND_API_KEY');
  const from = config.ownerSecret('MAIL_FROM');
  if (!apiKey || !from) return null;
  // A sender is a display name and one address: no line breaks, so it can never add a header.
  if (/[\r\n\0]/.test(from) || /[\r\n\0\s]/.test(apiKey)) return null;
  return {apiKey, from};
}

export function mailConfigured(): boolean {
  return mailCredentials() !== null;
}

/** One email. Never throws. `creds` is for tests; production reads the owner secrets. */
export async function sendMail(message: MailMessage, creds: MailCredentials | null = mailCredentials()): Promise<MailResult> {
  if (!creds) return {kind: 'not_configured'};
  if (/[\r\n\0]/.test(message.subject) || /[\r\n\0,;<>\s]/.test(message.to)) return {kind: 'failed', status: null};
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        'Content-Type': 'application/json',
        ...(message.idempotencyKey ? {'Idempotency-Key': message.idempotencyKey} : {}),
      },
      body: JSON.stringify({from: creds.from, to: [message.to], subject: message.subject, text: message.text, ...(message.html ? {html: message.html} : {})}),
    });
    if (res.ok) {
      let id: string | null = null;
      try {
        const body = (await res.json()) as {id?: unknown};
        if (typeof body?.id === 'string' && body.id.length <= 100) id = body.id;
      } catch {
        // an unreadable body after a 2xx still means accepted
      }
      return {kind: 'sent', id};
    }
    if (res.status >= 500 || res.status === 429 || res.status === 408) return {kind: 'retry', status: res.status};
    return {kind: 'failed', status: res.status};
  } catch {
    // Timeout or network error: the error text is dropped on purpose (it can echo the request).
    return {kind: 'retry', status: null};
  }
}
