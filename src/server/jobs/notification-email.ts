import type {PrismaClient} from '../../generated/prisma/client';
import {config} from '../../platform/config';
import {renderLocalizedNotificationEmail} from '../mail/notification-templates';
import {mailCredentials, sendMail, type MailResult} from '../mail/send';

/**
 * Phase 12: notification emails. ONE scheduled sweep (list `notification-emails`, background.json), never one job per
 * notification. Only @mentions (comment and chat) and assignments are mailed; everything else stays in app.
 *
 * Per person (`user_profiles`): `email_notify_mode` off (default) | digest | immediate, `email_notify_cursor` (last
 * notification id already handled) and `email_notified_at`. Limits: at most ONE email per person per hour (immediate) or
 * per 23 hours (digest), at most MAX_PER_RUN people per run. The address is read from `users` in the same step that sends
 * and is never stored, put in a job payload or logged; the email names only counts, never another person.
 *
 * Safe to repeat: the cursor is CLAIMED (compare and set) before the send, so a second run cannot mail the same rows; a
 * failed send that is worth retrying gives the claim back. Turning it off (or deleting the account) is honoured because
 * the candidate query reads the mode at run time.
 */
export const NOTIFICATION_EMAIL_LIST = 'notification-emails';
export const EMAIL_KINDS = ['mentioned', 'message_mention', 'assigned'] as const;
export const EMAIL_MODES = ['off', 'digest', 'immediate'] as const;
export type EmailMode = (typeof EMAIL_MODES)[number];
export const MIN_GAP_MS: Record<'digest' | 'immediate', number> = {immediate: 3600_000, digest: 23 * 3600_000};
export const MAX_PER_RUN = 50;
const RUN_BUDGET_MS = 40_000;

type Candidate = {user_id: number; mode: string; cursor: bigint; locale: string | null};
type Tally = {user_id: number; kind: string; c: number; m: bigint};

export interface NotificationEmailDeps {
  send?: typeof sendMail;
  now?: () => Date;
}

/** Pure: the email for one person, from counts per kind, in their language. No names, no card titles, no address. */
export function renderNotificationEmail(counts: {mentions: number; assigned: number}, link: string, locale?: string | null) {
  return renderLocalizedNotificationEmail(counts, link, locale);
}

/** Pure: has this person's hourly/daily gap passed? */
export function gapPassed(mode: string, lastAt: Date | null, now: Date): boolean {
  if (mode !== 'digest' && mode !== 'immediate') return false;
  return !lastAt || now.getTime() - lastAt.getTime() >= MIN_GAP_MS[mode];
}

/** The handler for the `notification-emails` schedule. */
export async function runNotificationEmails(db: PrismaClient, job: {attempt: number; maxAttempts: number}, deps: NotificationEmailDeps = {}): Promise<void> {
  const send = deps.send ?? sendMail;
  const now = (deps.now ?? (() => new Date()))();
  const creds = mailCredentials();
  const origin = config.siteUrl;
  if (!creds || !origin) return; // email is not set up: nothing to do, and nothing to retry
  const started = Date.now();
  const lastTry = job.attempt >= job.maxAttempts;
  const immediateCut = new Date(now.getTime() - MIN_GAP_MS.immediate);
  const digestCut = new Date(now.getTime() - MIN_GAP_MS.digest);
  const kinds = [...EMAIL_KINDS];

  // One query: who is due and has something unread past their cursor (indexed by mode, then notifications(user_id, read_at, id)).
  const due = await db.$queryRaw<Candidate[]>`
    SELECT p.user_id, p.email_notify_mode AS mode, p.email_notify_cursor AS cursor, p.locale AS locale
    FROM user_profiles p
    WHERE p.email_notify_mode IN ('digest', 'immediate')
      AND ((p.email_notify_mode = 'immediate' AND (p.email_notified_at IS NULL OR p.email_notified_at <= ${immediateCut}))
        OR (p.email_notify_mode = 'digest' AND (p.email_notified_at IS NULL OR p.email_notified_at <= ${digestCut})))
      AND EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = p.user_id AND n.read_at IS NULL AND n.id > p.email_notify_cursor AND n.kind = ANY(${kinds}::text[]))
    ORDER BY p.user_id
    LIMIT ${MAX_PER_RUN}`;
  if (due.length === 0) return;
  const ids = due.map(d => d.user_id);

  const [tallies, users] = await Promise.all([
    db.$queryRaw<Tally[]>`
      SELECT n.user_id, n.kind, count(*)::int AS c, max(n.id) AS m
      FROM notifications n JOIN user_profiles p ON p.user_id = n.user_id
      WHERE n.user_id = ANY(${ids}::int[]) AND n.read_at IS NULL AND n.id > p.email_notify_cursor AND n.kind = ANY(${kinds}::text[])
      GROUP BY n.user_id, n.kind`,
    db.user.findMany({where: {id: {in: ids}, status: 'active', emailVerifiedAt: {not: null}}, select: {id: true, email: true}, take: MAX_PER_RUN}),
  ]);
  const emails = new Map(users.map(u => [u.id, u.email]));
  const byUser = new Map<number, {mentions: number; assigned: number; max: bigint}>();
  for (const t of tallies) {
    const e = byUser.get(t.user_id) ?? {mentions: 0, assigned: 0, max: 0n};
    if (t.kind === 'assigned') e.assigned += t.c;
    else e.mentions += t.c;
    if (t.m > e.max) e.max = t.m;
    byUser.set(t.user_id, e);
  }

  let retryLeft = false;
  for (const d of due) {
    const sum = byUser.get(d.user_id);
    const to = emails.get(d.user_id);
    if (!sum) continue;
    if (Date.now() - started > RUN_BUDGET_MS) {
      retryLeft = true;
      continue;
    }
    // Claim the rows (compare and set on the old cursor and mode): a repeated run, or someone who just switched it off, gets 0.
    const claim = await db.userProfile.updateMany({
      where: {userId: d.user_id, emailNotifyMode: d.mode, emailNotifyCursor: d.cursor},
      data: {emailNotifyCursor: sum.max, emailNotifiedAt: now},
    });
    if (claim.count === 0) continue;
    if (!to) continue; // suspended or unverified: the rows are skipped, never mailed
    const mail = renderNotificationEmail(sum, `${origin.replace(/\/+$/, '')}/app/`, d.locale);
    const result: MailResult = await send({to, subject: mail.subject, text: mail.text, html: mail.html, idempotencyKey: `notif-${d.user_id}-${sum.max}`}, creds);
    if (result.kind === 'sent') continue;
    if (result.kind === 'retry' && !lastTry) {
      // Give the claim back so the next run mails them again.
      await db.userProfile.updateMany({where: {userId: d.user_id, emailNotifyCursor: sum.max}, data: {emailNotifyCursor: d.cursor, emailNotifiedAt: null}});
      retryLeft = true;
    } else {
      console.warn('[notification-email] not delivered', d.user_id, result.kind);
    }
  }
  if (retryLeft) throw new Error('Some notification emails were not accepted yet; trying again later.');
}

/** The cursor to store when someone switches it on: everything older is NOT mailed. */
export async function currentCursor(db: PrismaClient, userId: number): Promise<bigint> {
  const row = await db.notification.findFirst({where: {userId}, orderBy: {id: 'desc'}, select: {id: true}});
  return row?.id ?? 0n;
}

