import {Hono} from 'hono';

import {Prisma} from '../../generated/prisma/client';

import {requireAuth, withDb, withViewer} from '../../platform/guards';

/**
 * Account deletion PREFLIGHT (docs/product/delete-account-design.md §4). The managed
 * `POST /auth/delete-account` only runs `DELETE FROM users`; the database triggers (migration
 * 20261103130000_account_deletion_cleanup) refuse it for three reasons and the platform route answers a generic 500.
 * This read tells the signed-in person BEFORE they try, using the same conditions as the trigger:
 *
 *   GET /site-api/account/delete-preflight   -> {canDelete, blockers[], summary}
 *
 * Own data only: the one id used is the session's (`viewer.id`), never a param, query or body. Nothing of any other
 * person is returned (no names, no emails: only a count of the other members of a workspace the viewer owns).
 * Blocker reasons (an archived workspace blocks too; it must be restored first):
 *   last_workspace_owner   sole owner of a workspace that has other members  -> transfer ownership
 *   paid_workspace         sole member and owner of a paid workspace         -> move it to the free plan
 *   workspace_needs_action sole member of a free workspace that is not empty -> empty it (boards, cards, files, chat)
 * Two prepared statements in parallel; counts are capped (CAP) so a huge account stays cheap.
 */

const CAP = 1000;
const MAX_BLOCKERS = 50;
const MAX_CANDIDATES = 5;

type BlockerRow = {id: number; name: string; plan: string; archived: boolean; others: number; reason: string | null};
type CandidateRow = {workspace_id: number; user_id: number; name: string | null};
type SummaryRow = {memberships: number; inbox_cards: number; comments: number; messages: number; cards: number};

export const accountPreflightRoutes = new Hono().get('/account/delete-preflight', withViewer, requireAuth, withDb, async c => {
  const uid = c.var.viewer.id!;
  const db = c.var.db;

  const [rows, sums] = await Promise.all([
    // Workspaces where the viewer is an owner and no other owner exists (the trigger's own NOT EXISTS), with the reason.
    db.$queryRaw<BlockerRow[]>`
      SELECT w.id, w.name, w.plan, (w.archived_at IS NOT NULL) AS archived,
             (SELECT count(*) FROM workspace_members o WHERE o.workspace_id = w.id AND o.user_id <> ${uid})::int AS others,
             CASE
               WHEN EXISTS (SELECT 1 FROM workspace_members o WHERE o.workspace_id = w.id AND o.user_id <> ${uid}) THEN 'last_workspace_owner'
               WHEN w.plan <> 'free' THEN 'paid_workspace'
               WHEN EXISTS (SELECT 1 FROM cards k JOIN boards b ON b.id = k.board_id
                             WHERE k.workspace_id = w.id AND b.inbox_of IS DISTINCT FROM ${uid})
                 OR EXISTS (SELECT 1 FROM attachments a
                             WHERE a.workspace_id = w.id
                               AND NOT coalesce(a.card_id IN (SELECT k.id FROM cards k JOIN boards b ON b.id = k.board_id WHERE b.inbox_of = ${uid}), false))
                 OR EXISTS (SELECT 1 FROM conversations v WHERE v.workspace_id = w.id
                             AND NOT (v.kind = 'channel' AND v.name = 'general' AND v.board_id IS NULL))
                 OR EXISTS (SELECT 1 FROM messages m WHERE m.workspace_id = w.id) THEN 'workspace_needs_action'
               ELSE NULL
             END AS reason
        FROM workspace_members me
        JOIN workspaces w ON w.id = me.workspace_id
       WHERE me.user_id = ${uid} AND me.role = 'owner'
         AND NOT EXISTS (SELECT 1 FROM workspace_members o WHERE o.workspace_id = w.id AND o.role = 'owner' AND o.user_id <> ${uid})
       ORDER BY w.id
       LIMIT ${MAX_BLOCKERS}`,
    // What goes and what stays anonymous, from the viewer's indexed columns, each count capped.
    db.$queryRaw<SummaryRow[]>`
      SELECT (SELECT count(*) FROM (SELECT 1 FROM workspace_members WHERE user_id = ${uid} LIMIT ${CAP + 1}) s)::int AS memberships,
             (SELECT count(*) FROM (SELECT 1 FROM cards k JOIN boards b ON b.id = k.board_id WHERE b.inbox_of = ${uid} LIMIT ${CAP + 1}) s)::int AS inbox_cards,
             (SELECT count(*) FROM (SELECT 1 FROM comments WHERE author_id = ${uid} LIMIT ${CAP + 1}) s)::int AS comments,
             (SELECT count(*) FROM (SELECT 1 FROM messages WHERE sender_id = ${uid} LIMIT ${CAP + 1}) s)::int AS messages,
             (SELECT count(*) FROM (SELECT 1 FROM cards WHERE created_by = ${uid} LIMIT ${CAP + 1}) s)::int AS cards`,
  ]);

  // One query for every last-owner workspace: up to MAX_CANDIDATES other members each (admins first), NAMES ONLY
  // (never an email), for the one-click "Make <name> owner". The viewer is a member of each, so this reads only their own workspaces.
  const handoverIds = rows.filter(r => r.reason === 'last_workspace_owner').map(r => r.id);
  const cands = handoverIds.length
    ? await db.$queryRaw<CandidateRow[]>`
        SELECT x.workspace_id, x.user_id, x.name FROM (
          SELECT m.workspace_id, m.user_id, u.name,
                 row_number() OVER (PARTITION BY m.workspace_id ORDER BY (m.role = 'admin') DESC, m.user_id) AS rn
            FROM workspace_members m JOIN users u ON u.id = m.user_id
           WHERE m.workspace_id IN (${Prisma.join(handoverIds)}) AND m.user_id <> ${uid}) x
         WHERE x.rn <= ${MAX_CANDIDATES}
         ORDER BY x.workspace_id, x.rn`
    : [];

  const blockers = rows.filter(r => r.reason !== null).map(r => ({
    reason: r.reason as 'last_workspace_owner' | 'paid_workspace' | 'workspace_needs_action',
    workspaceId: r.id,
    name: r.name,
    plan: r.plan,
    archived: r.archived,
    otherMembers: r.others,
    candidates: cands.filter(k => k.workspace_id === r.id).map(k => ({userId: k.user_id, name: k.name})),
    // What the person can do about it (the UI links to the matching screen).
    actions:
      r.reason === 'last_workspace_owner'
        ? [...(r.archived ? ['restore'] : []), 'transfer_ownership']
        : r.reason === 'paid_workspace'
          ? [...(r.archived ? ['restore'] : []), 'cancel_plan']
          : [...(r.archived ? ['restore'] : []), 'empty_workspace'],
  }));
  const s = sums[0] ?? {memberships: 0, inbox_cards: 0, comments: 0, messages: 0, cards: 0};

  c.header('Cache-Control', 'private, no-store');
  return c.json({
    canDelete: blockers.length === 0,
    blockers,
    summary: {
      // Gone with the account: memberships, stars, notifications, saved filters, your Inbox and its cards, and
      // each free workspace where you are alone and it is empty.
      removed: {
        memberships: Math.min(s.memberships, CAP),
        inboxCards: Math.min(s.inbox_cards, CAP),
        emptyWorkspaces: rows.filter(r => r.reason === null).length,
      },
      // Kept, shown as "Deleted user": what you wrote.
      anonymised: {comments: Math.min(s.comments, CAP), messages: Math.min(s.messages, CAP), cards: Math.min(s.cards, CAP)},
      cap: CAP,
    },
  });
});

