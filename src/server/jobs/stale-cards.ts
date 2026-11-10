import type {PrismaClient} from '../../generated/prisma/client';
import {getEntitlements} from '../entitlements';

/**
 * Stale card warning: the job behind the daily schedule `stale-cards` (background.json).
 *
 * THE RULE: a board admin turns it on per board (`boards.stale_days`: 3, 7, 14 or 30; null = off, the default). A live
 * card that has been in its current lane for at least that many days (`cards.lane_entered_at`, kept by the
 * `cards_lane_entered` trigger on every lane change, and reset when a card is restored from the archive) reminds its
 * assignees and followers with one `card_stale` notification each. One per person per card per LANE ENTRY
 * (`stale_reminders (card_id, user_id, entered_at)`): a card that keeps sitting in the same lane is never nagged
 * again, a second or overlapping run sends nothing, and a card that moves and goes stale again is reminded again.
 * Live = the card is not archived and not completed, its lane is not archived, its board (stale_days set, not an
 * Inbox) and workspace are not archived. A read-only workspace (over a plan limit, grace over) is skipped, like the
 * other jobs that make things. There is no "done lane" notion in the app: a finished card is one that is completed.
 * Who: assignees and followers who still have a seat (active member, a seat on a private board, only the owner on a
 * personal Inbox board). Sent by the system (`actor_id` null).
 *
 * BUDGET RULE (as in due-reminders): the page query only returns cards that still have at least one eligible person
 * without a key for the card's current lane entry, so reminded cards never consume the per-run budget and a card that
 * gains a follower later is picked up again. Cards of a frozen workspace pass the filter (the plan check is not SQL)
 * and count as scanned.
 *
 * Safe to repeat and to overlap: ONE statement per page claims the keys (`ON CONFLICT DO NOTHING ... RETURNING`) and
 * inserts the notifications for exactly the keys it claimed.
 */
export const STALE_CARDS_LIST = 'stale-cards';
export const CARDS_PER_PAGE = 25;
export const MAX_CARDS_PER_RUN = 500;
/** A run stops taking new pages after this long (the platform allows 60 s per run). */
export const RUN_BUDGET_MS = 40_000;
/** Keys of lane entries a card has left are deleted, this many per run. */
export const PRUNE_BATCH = 1000;

export type StaleCardsResult = {scanned: number; sent: number; skipped: number; pruned: number};

export async function runStaleCards(db: PrismaClient, now: Date = new Date(), maxCards: number = MAX_CARDS_PER_RUN): Promise<StaleCardsResult> {
  const started = Date.now();
  const result: StaleCardsResult = {scanned: 0, sent: 0, skipped: 0, pruned: 0};
  const readOnly = new Map<number, boolean>();
  let cursor = 0;
  while (result.scanned < maxCards && Date.now() - started < RUN_BUDGET_MS) {
    // One query per page: the live stale cards of boards that turned the warning on, keyset on the id.
    const page = await db.$queryRaw<{id: number; workspace_id: number}[]>`
      SELECT c.id, c.workspace_id
      FROM cards c
      JOIN boards b ON b.id = c.board_id AND b.workspace_id = c.workspace_id
        AND b.archived_at IS NULL AND b.stale_days IS NOT NULL AND b.inbox_of IS NULL
      JOIN workspaces w ON w.id = c.workspace_id AND w.archived_at IS NULL
      JOIN lanes l ON l.id = c.lane_id AND l.archived_at IS NULL
      WHERE c.archived_at IS NULL AND c.completed_at IS NULL
        AND c.lane_entered_at <= ${now}::timestamptz - make_interval(days => b.stale_days)
        AND c.id > ${cursor}::int
        AND EXISTS (
          SELECT 1
          FROM (SELECT user_id FROM card_members WHERE card_id = c.id
                UNION SELECT user_id FROM card_watchers WHERE card_id = c.id) p
          JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = p.user_id
          JOIN users u ON u.id = p.user_id
          WHERE u.status = 'active'
            AND (b.visibility <> 'private' OR m.role IN ('owner', 'admin')
                 OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = p.user_id))
            AND NOT EXISTS (SELECT 1 FROM stale_reminders r WHERE r.card_id = c.id AND r.user_id = p.user_id AND r.entered_at = c.lane_entered_at))
      ORDER BY c.id
      LIMIT ${CARDS_PER_PAGE}`;
    if (page.length === 0) break;
    result.scanned += page.length;
    cursor = page[page.length - 1]!.id;
    const ids: number[] = [];
    for (const card of page) {
      if (await frozen(db, card.workspace_id, readOnly)) result.skipped++;
      else ids.push(card.id);
    }
    if (ids.length > 0) {
      try {
        result.sent += await remindPage(db, ids, now);
      } catch (error) {
        // The message only. The keys of this page were not claimed (one statement), so the next run tries again.
        console.error(`stale-cards page after card ${cursor}: ${(error as Error).message}`);
      }
    }
    if (page.length < CARDS_PER_PAGE) break;
  }
  result.pruned = await prunePast(db);
  return result;
}

async function frozen(db: PrismaClient, workspaceId: number, memo: Map<number, boolean>): Promise<boolean> {
  const known = memo.get(workspaceId);
  if (known !== undefined) return known;
  const ent = await getEntitlements(db, workspaceId);
  const value = !ent || ent.readOnly;
  memo.set(workspaceId, value);
  return value;
}

/**
 * Claim the (card, person, lane entry) keys of these cards and write the notifications for the keys claimed, in ONE
 * statement. The cards are re-checked (live, stale) in the same statement and the people filtered by seat.
 */
async function remindPage(db: PrismaClient, ids: number[], now: Date): Promise<number> {
  const rows = await db.$queryRaw<{sent: number}[]>`
    WITH stale AS (
      SELECT c.id, c.workspace_id, c.board_id, c.lane_entered_at
      FROM cards c
      JOIN boards b ON b.id = c.board_id AND b.workspace_id = c.workspace_id
        AND b.archived_at IS NULL AND b.stale_days IS NOT NULL AND b.inbox_of IS NULL
      JOIN lanes l ON l.id = c.lane_id AND l.archived_at IS NULL
      WHERE c.id = ANY(${ids}::int[])
        AND c.archived_at IS NULL AND c.completed_at IS NULL
        AND c.lane_entered_at <= ${now}::timestamptz - make_interval(days => b.stale_days)
    ),
    people AS (
      SELECT card_id, user_id FROM card_members WHERE card_id = ANY(${ids}::int[])
      UNION
      SELECT card_id, user_id FROM card_watchers WHERE card_id = ANY(${ids}::int[])
    ),
    eligible AS (
      SELECT s.id AS card_id, s.workspace_id, s.board_id, s.lane_entered_at, p.user_id
      FROM stale s
      JOIN people p ON p.card_id = s.id
      JOIN boards b ON b.id = s.board_id AND b.workspace_id = s.workspace_id
      JOIN workspace_members m ON m.workspace_id = s.workspace_id AND m.user_id = p.user_id
      JOIN users u ON u.id = p.user_id
      WHERE u.status = 'active'
        AND (b.visibility <> 'private' OR m.role IN ('owner', 'admin')
             OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = p.user_id))
    ),
    claimed AS (
      INSERT INTO stale_reminders (card_id, user_id, entered_at)
      SELECT card_id, user_id, lane_entered_at FROM eligible
      ON CONFLICT DO NOTHING
      RETURNING card_id, user_id
    ),
    sent AS (
      INSERT INTO notifications (user_id, workspace_id, kind, actor_id, board_id, card_id)
      SELECT k.user_id, e.workspace_id, 'card_stale', NULL, e.board_id, k.card_id
      FROM claimed k
      JOIN eligible e ON e.card_id = k.card_id AND e.user_id = k.user_id
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM sent)::int AS sent`;
  return rows[0]?.sent ?? 0;
}

/** Forget the keys of lane entries the card has left (bounded; the next run takes the rest). */
async function prunePast(db: PrismaClient): Promise<number> {
  return db.$executeRaw`
    DELETE FROM stale_reminders
    WHERE ctid IN (
      SELECT s.ctid FROM stale_reminders s
      JOIN cards c ON c.id = s.card_id
      WHERE c.lane_entered_at <> s.entered_at
      LIMIT ${PRUNE_BATCH})`;
}
