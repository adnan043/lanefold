import type {PrismaClient} from '../../generated/prisma/client';
import {sha256Hex} from '../../platform/auth/encoding';
import {openSecret, sealSecret} from '../../platform/auth/two-factor';
import {DontRetry, sendJob} from '../../platform/background';
import {config} from '../../platform/config';
import {getEntitlements} from '../entitlements';
import {inviteLink, renderInviteEmail} from '../mail/templates';
import {inviterMayInviteToBoard} from '../board-seats';
import {mailCredentials, sendMail, type MailResult} from '../mail/send';

/**
 * Phase 11: the `invite-emails` background list. ONE job per create/resend request carries the batch (at most
 * MAX_BATCH invites); never one job per email.
 *
 * Payload (stored by the platform and visible in the owner's Jobs tab, so it holds NO readable address or token):
 *   {v: 1, w: workspaceId, by: inviterId, items: [{id: inviteId, s: sealed({e: address, t: rawToken})}]}
 * `s` is AES-GCM sealed with the site's own sealing helper (src/platform/auth/two-factor.ts), bound to the inviter.
 * The address is never stored in our tables and never logged. The delivery state is written on the invite row.
 *
 * The handler is idempotent (a row already 'sent' is skipped; the provider gets an Idempotency-Key per token),
 * retries only for 5xx / 429 / timeouts (it throws; the platform's retry runs it again), and marks 4xx 'failed'
 * at once. Missing owner secrets mark 'not_configured' and return: never an endless retry.
 */

export const INVITE_EMAIL_LIST = 'invite-emails';
export const MAX_BATCH = 5;
/** A job run has 60 s; each send waits at most 8 s. Stop early and let the retry do the rest. */
const RUN_BUDGET_MS = 40_000;

export interface InviteEmailItem {
  id: number;
  s: string;
}
export interface InviteEmailPayload {
  v: 1;
  w: number;
  by: number;
  items: InviteEmailItem[];
}

const sealKey = (inviterId: number) => inviterId;

/** Seals one invite's address + raw token for the job payload. Null when the site secret is missing. */
export async function sealInviteItem(inviterId: number, inviteId: number, email: string, token: string): Promise<InviteEmailItem | null> {
  const secret = config.jwtSecret;
  if (!secret) return null;
  return {id: inviteId, s: await sealSecret(secret, sealKey(inviterId), JSON.stringify({e: email, t: token}))};
}

/**
 * Sends the job for a batch. Returns false when the platform refused it (the invite then stays usable by link;
 * the caller marks it 'failed'). Never logs the payload.
 */
export async function enqueueInviteEmails(requestUrl: string, workspaceId: number, inviterId: number, items: InviteEmailItem[], key: string): Promise<boolean> {
  if (items.length === 0 || items.length > MAX_BATCH) return false;
  const payload: InviteEmailPayload = {v: 1, w: workspaceId, by: inviterId, items};
  try {
    await sendJob(requestUrl, INVITE_EMAIL_LIST, payload, {key, label: `Invite emails (${items.length})`});
    return true;
  } catch (error) {
    console.error('[invite-email] could not queue the job', (error as {code?: string})?.code ?? 'error');
    return false;
  }
}

function parsePayload(data: unknown): InviteEmailPayload {
  const d = data as Partial<InviteEmailPayload> | null;
  if (!d || typeof d !== 'object' || d.v !== 1 || !Number.isInteger(d.w) || !Number.isInteger(d.by) || !Array.isArray(d.items) || d.items.length === 0 || d.items.length > MAX_BATCH) {
    throw new DontRetry('The invite email job data is not valid.');
  }
  const items = d.items.filter((i): i is InviteEmailItem => !!i && Number.isInteger(i.id) && typeof i.s === 'string' && i.s.length < 2000);
  if (items.length !== d.items.length) throw new DontRetry('The invite email job data is not valid.');
  return {v: 1, w: d.w!, by: d.by!, items};
}

/**
 * Run-time re-check (the job can run long after it was queued): the inviter must STILL be an admin/owner of the
 * workspace, and the workspace must not be archived or read-only. Otherwise nothing is sent.
 */
export async function inviterMayEmail(db: PrismaClient, workspaceId: number, inviterId: number): Promise<boolean> {
  const row = await db.workspaceMember.findFirst({
    where: {workspaceId, userId: inviterId, role: {in: ['admin', 'owner']}, workspace: {archivedAt: null}},
    select: {role: true},
  });
  if (!row) return false;
  const ent = await getEntitlements(db, workspaceId);
  return !!ent && !ent.readOnly;
}

export interface InviteEmailDeps {
  send?: typeof sendMail;
}

/** The handler for the `invite-emails` list. */
export async function runInviteEmails(db: PrismaClient, data: unknown, job: {attempt: number; maxAttempts: number}, deps: InviteEmailDeps = {}): Promise<void> {
  const {w: workspaceId, by, items} = parsePayload(data);
  const send = deps.send ?? sendMail;
  const secret = config.jwtSecret;
  const creds = mailCredentials();
  const origin = config.siteUrl;
  const started = Date.now();
  let retryLeft = false;
  const lastTry = job.attempt >= job.maxAttempts;

  const [inviter, invites] = await Promise.all([
    db.user.findUnique({where: {id: by}, select: {name: true}}),
    db.workspaceInvite.findMany({
      where: {id: {in: items.map((i) => i.id)}, workspaceId, usedAt: null, expiresAt: {gt: new Date()}, workspace: {archivedAt: null}},
      select: {id: true, role: true, expiresAt: true, tokenHash: true, emailStatus: true, boardId: true, boardRole: true, board: {select: {name: true}}, workspace: {select: {name: true, defaultLocale: true}}},
      take: MAX_BATCH,
    }),
  ]);
  const byId = new Map(invites.map((i) => [i.id, i]));
  // Workspace invites: the inviter must still be a workspace admin. Board invites (Share): the inviter must still be
  // able to add people to THAT board (checked once per board in this batch).
  const boardOf = (i: {boardId?: number | null}) => i.boardId ?? null;
  const workspaceInvites = invites.some((i) => boardOf(i) === null);
  const allowed = !workspaceInvites ? false : await inviterMayEmail(db, workspaceId, by);
  const boardAllowed = new Map<number, boolean>();
  for (const boardId of new Set(invites.flatMap((i) => {
    const b = boardOf(i);
    return b === null ? [] : [b];
  }))) {
    boardAllowed.set(boardId, await inviterMayInviteToBoard(db, boardId, by));
  }

  const mark = (id: number, status: 'sent' | 'failed' | 'not_configured' | 'queued', attempted: boolean) =>
    db.workspaceInvite.updateMany({
      where: {id, workspaceId, emailStatus: {not: 'sent'}},
      data: {emailStatus: status, ...(status === 'sent' ? {emailSentAt: new Date()} : {}), ...(attempted ? {emailAttempts: {increment: 1}} : {})},
    });

  for (const item of items) {
    const invite = byId.get(item.id);
    // gone, used, expired, archived, already sent, or already failed for good (a resend rotates the token and sets 'queued' again,
    // so a 'failed' row seen here was settled by an earlier run of this job: a retry for another invite must not mail it again)
    if (!invite || invite.emailStatus === 'sent' || invite.emailStatus === 'failed') continue;
    const inviteBoard = boardOf(invite);
    if (inviteBoard === null ? !allowed : !boardAllowed.get(inviteBoard)) {
      // The inviter lost the role, or the workspace is archived / read-only: do not send. 'failed' keeps it
      // resendable by a current admin; the invite link itself is unchanged.
      await mark(invite.id, 'failed', false);
      continue;
    }
    if (Date.now() - started > RUN_BUDGET_MS) {
      retryLeft = true;
      continue;
    }
    const opened = secret ? await openSecret(secret, sealKey(by), item.s) : null;
    let parsed: {e?: unknown; t?: unknown} | null = null;
    try {
      parsed = opened ? (JSON.parse(opened) as {e?: unknown; t?: unknown}) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.e !== 'string' || typeof parsed.t !== 'string') {
      await mark(invite.id, 'failed', false);
      continue;
    }
    // A newer resend rotated the token: this job is stale and the newer one owns the row.
    if ((await sha256Hex(parsed.t)) !== invite.tokenHash) continue;
    if (!creds || !origin) {
      await mark(invite.id, 'not_configured', false);
      continue;
    }
    const mail = renderInviteEmail({
      locale: invite.workspace.defaultLocale,
      inviterName: inviter?.name ?? '',
      workspaceName: invite.workspace.name,
      role: inviteBoard === null ? invite.role : (invite.boardRole ?? 'member'),
      boardName: invite.board?.name ?? null,
      expiresAt: invite.expiresAt,
      link: inviteLink(origin, parsed.t) + (inviteBoard === null ? '' : '?b=1'),
    });
    const result: MailResult = await send({to: parsed.e, subject: mail.subject, text: mail.text, html: mail.html, idempotencyKey: `invite-${invite.id}-${invite.tokenHash.slice(0, 16)}`}, creds);
    if (result.kind === 'sent') await mark(invite.id, 'sent', true);
    else if (result.kind === 'not_configured') await mark(invite.id, 'not_configured', false);
    else if (result.kind === 'failed') {
      await mark(invite.id, 'failed', true);
      console.warn('[invite-email] provider refused', invite.id, result.status ?? 'no-status');
    } else if (lastTry) {
      await mark(invite.id, 'failed', true);
      console.warn('[invite-email] gave up', invite.id, result.status ?? 'no-status');
    } else {
      await mark(invite.id, 'queued', true);
      retryLeft = true;
    }
  }
  if (retryLeft) throw new Error('The mail provider did not accept every invite email yet; trying again later.');
}
