import type {PrismaClient} from '../../generated/prisma/client';
import {DontRetry, sendJob} from '../../platform/background';
import {config} from '../../platform/config';
import {boardLink, renderAccessApprovedEmail} from '../mail/access-templates';
import {mailCredentials, sendMail} from '../mail/send';

/**
 * The `access-request-emails` list: ONE job per approved request tells the requester they can open the board.
 *
 * Payload `{r: requestId}` only: no address, no name (the platform shows payloads in the owner's Jobs tab). The handler
 * reads everything by id when it runs, and only while the request is STILL approved (a later removal or a new request
 * makes the old job a no-op). The address is read from `users` in the same step that sends and is never logged.
 * Safe to repeat: the provider gets an Idempotency-Key per request and decision time, so a retry never mails twice.
 * Missing owner mail settings: nothing to send and nothing to retry.
 */
export const ACCESS_REQUEST_EMAIL_LIST = 'access-request-emails';

export type AccessRequestEmailPayload = {r: number};

/** Queues the email for an approved request. False when the platform refused the job (the approval still stands). */
export async function enqueueAccessApprovedEmail(requestUrl: string, requestId: number, decidedAt: Date): Promise<boolean> {
  if (!mailCredentials()) return false;
  try {
    await sendJob(requestUrl, ACCESS_REQUEST_EMAIL_LIST, {r: requestId} satisfies AccessRequestEmailPayload, {
      key: `access-approved-${requestId}-${decidedAt.getTime()}`,
      label: 'Board access approved email',
    });
    return true;
  } catch (error) {
    console.error(`access approved job for request ${requestId} not queued: ${(error as Error).message}`);
    return false;
  }
}

export interface AccessEmailDeps {
  send?: typeof sendMail;
}

export async function runAccessApprovedEmail(db: PrismaClient, data: unknown, deps: AccessEmailDeps = {}): Promise<void> {
  const id = typeof data === 'object' && data !== null ? (data as {r?: unknown}).r : undefined;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new DontRetry('Bad payload.');
  const creds = mailCredentials();
  const origin = config.siteUrl;
  if (!creds || !origin) return;
  // ONE read: the request (still approved), the requester's address and language, the board and the approver's name.
  const [row] = await db.$queryRaw<{email: string; locale: string | null; board: string; approver: string | null; boardId: number; decidedAt: Date}[]>`
    SELECT u.email, p.locale, b.name AS board, a.name AS approver, r.board_id AS "boardId", r.decided_at AS "decidedAt"
    FROM board_access_requests r
    JOIN users u ON u.id = r.user_id AND u.status = 'active'
    JOIN boards b ON b.id = r.board_id AND b.archived_at IS NULL
    LEFT JOIN user_profiles p ON p.user_id = r.user_id
    LEFT JOIN users a ON a.id = r.decided_by
    WHERE r.id = ${id} AND r.status = 'approved' AND r.decided_at IS NOT NULL`;
  if (!row || !row.email) return;
  const mail = renderAccessApprovedEmail({locale: row.locale, approverName: row.approver ?? '', boardName: row.board, link: boardLink(origin, row.boardId)});
  const sent = await (deps.send ?? sendMail)(
    {to: row.email, subject: mail.subject, text: mail.text, html: mail.html, idempotencyKey: `access-approved-${id}-${row.decidedAt.getTime()}`},
    creds
  );
  if (sent.kind === 'retry') throw new Error(`Mail provider answered ${sent.status ?? 'nothing'}; trying again later.`);
  if (sent.kind === 'failed') throw new DontRetry(`Mail provider refused the message (${sent.status ?? 'no status'}).`);
}
