import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {JobRejected, sendJob} from '../../platform/background';
import {getEntitlements} from '../entitlements';

/**
 * Due date reminders: the job behind the hourly schedule `due-reminders` (background.json).
 *
 * THE RULE (UTC days, like recurring cards and the due-date Flows): a live card whose due date is TODAY or TOMORROW
 * reminds its assignees and followers with one `due_soon` notification each. One per person per card per due date
 * (`due_reminders (card_id, user_id, due_on)` is the key), so a card due tomorrow that is reminded today is not
 * reminded again tomorrow, a second run sends nothing, and an overdue card is never nagged daily. A card given a NEW
 * due date can be reminded again for that date.
 * Live = the card is not archived and not completed, and its board and workspace are not archived. A workspace that
 * is read-only (over a plan limit, grace over) is skipped, like the other jobs that make things.
 * Who: assignees and followers who still have a seat (active member, a seat on a private board, only the owner on a
 * personal Inbox board). The reminder is sent by the system (`actor_id` null).
 *
 * BUDGET RULE: the page query only returns cards that still have at least one eligible person without a key for the
 * card's due date (same seat rules as `remindPage`), so reminded cards never consume the per-run card budget and a
 * card that gains a follower later is picked up again. Cards of a frozen workspace still pass the filter (the plan
 * check is not SQL) and are counted as scanned.
 *
 * TIMED CARDS (a due time picked in the dates popup, `due_at`): the day rule above skips them. Each one reminds at
 * `due_at - due_remind_minutes` (no reminder when that is null): the PATCH that sets it sends one `due-reminder-at`
 * job for that moment (`scheduleTimedReminder`), and this hourly run is the safety net for a send that failed. A
 * reminder moment whose due time is more than 15 minutes past is dropped (never a reminder for an overdue card). The
 * same `due_reminders` key dedupes both paths; changing the time or the reminder forgets the card's keys.
 *
 * Safe to repeat and to overlap: ONE statement per page claims the keys (`ON CONFLICT DO NOTHING ... RETURNING`) and
 * inserts the notifications for exactly the keys it claimed.
 */
export const DUE_REMINDERS_LIST = 'due-reminders';
/** One job per timed reminder, sent for its moment by the card's PATCH. */
export const TIMED_REMINDER_LIST = 'due-reminder-at';
/** A timed reminder still goes out up to this long after the due time (a late job, the hourly safety net). */
const GRACE_MS = 15 * 60_000;
export const CARDS_PER_PAGE = 25;
export const MAX_CARDS_PER_RUN = 500;
/** A run stops taking new pages after this long (the platform allows 60 s per run). */
export const RUN_BUDGET_MS = 40_000;
/** Reminder keys older than this many days past their due day are deleted. */
export const KEEP_DAYS = 7;
const DAY = 86_400_000;

export type DueRemindersResult = {scanned: number; sent: number; skipped: number; pruned: number; items?: {scanned: number; sent: number; skipped: number}};

/**
 * Pure: the two due days the day rule looks at, `YYYY-MM-DD` in UTC, and the wider band of due days a timed card can
 * be reminded on (`from`..`until`: a 2-day reminder in any time zone), which keeps both rules on the due_date index.
 */
export function reminderWindow(now: Date): {today: string; tomorrow: string; from: string; until: string; prune: string} {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {today: iso(start), tomorrow: iso(start + DAY), from: iso(start - DAY), until: iso(start + 3 * DAY), prune: iso(start - KEEP_DAYS * DAY)};
}
type Window = ReturnType<typeof reminderWindow>;

/** The cards (alias `c`) a run may remind now: the day rule for cards without a time, the timed rule for the others. */
function dueNow(w: Window, now: Date): Prisma.Sql {
  return Prisma.sql`c.due_date >= ${w.from}::date AND c.due_date <= ${w.until}::date
    AND c.archived_at IS NULL AND c.completed_at IS NULL
    AND (
      (c.due_at IS NULL AND c.due_date >= ${w.today}::date AND c.due_date <= ${w.tomorrow}::date)
      OR (c.due_at IS NOT NULL AND c.due_remind_minutes IS NOT NULL
          AND c.due_at > ${new Date(now.getTime() - GRACE_MS)}::timestamptz
          AND c.due_at - make_interval(mins => c.due_remind_minutes) <= ${now}::timestamptz)
    )`;
}

export async function runDueReminders(db: PrismaClient, now: Date = new Date(), maxCards: number = MAX_CARDS_PER_RUN): Promise<DueRemindersResult> {
  const w = reminderWindow(now);
  const started = Date.now();
  const result: DueRemindersResult = {scanned: 0, sent: 0, skipped: 0, pruned: 0};
  const readOnly = new Map<number, boolean>();
  let cursor = 0;
  while (result.scanned < maxCards && Date.now() - started < RUN_BUDGET_MS) {
    // One query per page: the live cards due today or tomorrow, keyset on the id.
    const page = await db.$queryRaw<{id: number; workspace_id: number}[]>`
      SELECT c.id, c.workspace_id
      FROM cards c
      JOIN boards b ON b.id = c.board_id AND b.workspace_id = c.workspace_id AND b.archived_at IS NULL
      JOIN workspaces w ON w.id = c.workspace_id AND w.archived_at IS NULL
      WHERE ${dueNow(w, now)}
        AND c.id > ${cursor}::int
        AND EXISTS (
          SELECT 1
          FROM (SELECT user_id FROM card_members WHERE card_id = c.id
                UNION SELECT user_id FROM card_watchers WHERE card_id = c.id) p
          JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = p.user_id
          JOIN users u ON u.id = p.user_id
          WHERE u.status = 'active'
            AND (b.inbox_of IS NULL OR b.inbox_of = p.user_id)
            AND (b.visibility <> 'private' OR m.role IN ('owner', 'admin')
                 OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = p.user_id))
            AND NOT EXISTS (SELECT 1 FROM due_reminders r WHERE r.card_id = c.id AND r.user_id = p.user_id AND r.due_on = c.due_date))
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
        result.sent += await remindPage(db, ids, w, now);
      } catch (error) {
        // The message only. The keys of this page were not claimed (one statement), so the next run tries again.
        console.error(`due-reminders page after card ${cursor}: ${(error as Error).message}`);
      }
    }
    if (page.length < CARDS_PER_PAGE) break;
  }
  result.pruned = await prunePast(db, w.prune);
  result.items = await runItemReminders(db, now, maxCards, started);
  result.pruned += await pruneItemKeys(db, new Date(now.getTime() - KEEP_DAYS * DAY));
  return result;
}

/* ------------------------------------------------------------------ checklist items */

/**
 * CHECKLIST ITEMS with a due time and a reminder (the item's due date popover): each reminds at
 * `due_at - due_remind_minutes`, like a timed card, and only while the item is not ticked and its card is live.
 * Who: the item's assignee; an item with nobody on it reminds the card's assignees and followers instead. Same seat
 * rules as cards. One `item_due` notification (on the card) per person per item per due moment
 * (`item_due_reminders (item_id, user_id, due_at)`), so a new time can remind again and a repeat sends nothing.
 * Day-only items never remind (they never did).
 */
/** The items (alias `i`, card `c`) whose reminder moment has come and whose due time is not long past. */
function itemDueNow(now: Date): Prisma.Sql {
  return Prisma.sql`i.due_at > ${new Date(now.getTime() - GRACE_MS)}::timestamptz
    AND i.due_at <= ${new Date(now.getTime() + 2880 * 60_000)}::timestamptz
    AND i.due_remind_minutes IS NOT NULL AND i.done_at IS NULL
    AND i.due_at - make_interval(mins => i.due_remind_minutes) <= ${now}::timestamptz
    AND c.archived_at IS NULL AND c.completed_at IS NULL`;
}

/** The people an item (`i`) on card (`c`) reminds: its assignee, else the card's assignees and followers. */
const itemPeople = Prisma.sql`
  SELECT i.assignee_id AS user_id WHERE i.assignee_id IS NOT NULL
  UNION SELECT user_id FROM card_members WHERE card_id = c.id AND i.assignee_id IS NULL
  UNION SELECT user_id FROM card_watchers WHERE card_id = c.id AND i.assignee_id IS NULL`;

/** Seat rules for a person `p` on board `b` (`m` = their workspace membership), the same as for cards. */
const seated = Prisma.sql`u.status = 'active'
  AND (b.inbox_of IS NULL OR b.inbox_of = p.user_id)
  AND (b.visibility <> 'private' OR m.role IN ('owner', 'admin')
       OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = p.user_id))`;

async function runItemReminders(db: PrismaClient, now: Date, maxItems: number, started: number): Promise<{scanned: number; sent: number; skipped: number}> {
  const result = {scanned: 0, sent: 0, skipped: 0};
  const readOnly = new Map<number, boolean>();
  let cursor = 0;
  while (result.scanned < maxItems && Date.now() - started < RUN_BUDGET_MS) {
    // One query per page, keyset on the id: timed items with someone still to remind.
    const page = await db.$queryRaw<{id: number; workspace_id: number}[]>`
      SELECT i.id, i.workspace_id
      FROM checklist_items i
      JOIN checklists l ON l.id = i.checklist_id
      JOIN cards c ON c.id = l.card_id AND c.workspace_id = i.workspace_id
      JOIN boards b ON b.id = c.board_id AND b.workspace_id = c.workspace_id AND b.archived_at IS NULL
      JOIN workspaces w ON w.id = c.workspace_id AND w.archived_at IS NULL
      WHERE ${itemDueNow(now)}
        AND i.id > ${cursor}::int
        AND EXISTS (
          SELECT 1
          FROM (${itemPeople}) p
          JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = p.user_id
          JOIN users u ON u.id = p.user_id
          WHERE ${seated}
            AND NOT EXISTS (SELECT 1 FROM item_due_reminders r WHERE r.item_id = i.id AND r.user_id = p.user_id AND r.due_at = i.due_at))
      ORDER BY i.id
      LIMIT ${CARDS_PER_PAGE}`;
    if (page.length === 0) break;
    result.scanned += page.length;
    cursor = page[page.length - 1]!.id;
    const ids: number[] = [];
    for (const item of page) {
      if (await frozen(db, item.workspace_id, readOnly)) result.skipped++;
      else ids.push(item.id);
    }
    if (ids.length > 0) {
      try {
        result.sent += await remindItems(db, ids, now);
      } catch (error) {
        console.error(`due-reminders items after ${cursor}: ${(error as Error).message}`);
      }
    }
    if (page.length < CARDS_PER_PAGE) break;
  }
  return result;
}

/** Claim the (item, person, due moment) keys of these items and write the notifications for the keys claimed: ONE statement. */
async function remindItems(db: PrismaClient, ids: number[], now: Date): Promise<number> {
  const rows = await db.$queryRaw<{sent: number}[]>`
    WITH eligible AS (
      SELECT DISTINCT i.id AS item_id, i.due_at, c.id AS card_id, c.workspace_id, c.board_id, p.user_id
      FROM checklist_items i
      JOIN checklists l ON l.id = i.checklist_id
      JOIN cards c ON c.id = l.card_id AND c.workspace_id = i.workspace_id
      JOIN boards b ON b.id = c.board_id AND b.workspace_id = c.workspace_id AND b.archived_at IS NULL
      JOIN workspaces w ON w.id = c.workspace_id AND w.archived_at IS NULL
      CROSS JOIN LATERAL (${itemPeople}) p
      JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = p.user_id
      JOIN users u ON u.id = p.user_id
      WHERE i.id = ANY(${ids}::int[]) AND ${itemDueNow(now)} AND ${seated}
    ),
    claimed AS (
      INSERT INTO item_due_reminders (item_id, user_id, due_at)
      SELECT item_id, user_id, due_at FROM eligible
      ON CONFLICT DO NOTHING
      RETURNING item_id, user_id
    ),
    sent AS (
      INSERT INTO notifications (user_id, workspace_id, kind, actor_id, board_id, card_id)
      SELECT k.user_id, e.workspace_id, 'item_due', NULL, e.board_id, e.card_id
      FROM claimed k
      JOIN eligible e ON e.item_id = k.item_id AND e.user_id = k.user_id
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM sent)::int AS sent`;
  return rows[0]?.sent ?? 0;
}

/** Forget item reminder keys whose due moment is long past (bounded; the next run takes the rest). */
async function pruneItemKeys(db: PrismaClient, before: Date): Promise<number> {
  return db.$executeRaw`
    DELETE FROM item_due_reminders
    WHERE ctid IN (SELECT ctid FROM item_due_reminders WHERE due_at < ${before}::timestamptz LIMIT 1000)`;
}

/**
 * After a PATCH changed an item's due time or reminder: one `due-reminder-at` job for the reminder moment, keyed by
 * the item and the moment. Never fails the request (the hourly run is the safety net).
 */
export async function scheduleItemReminder(url: string, itemId: number, dueAt: Date | null, remindMinutes: number | null, now: Date = new Date()): Promise<void> {
  if (!dueAt || remindMinutes === null || dueAt.getTime() <= now.getTime()) return;
  try {
    const at = new Date(dueAt.getTime() - remindMinutes * 60_000);
    await sendJob(url, TIMED_REMINDER_LIST, {itemId}, {
      at,
      key: `item-due-${itemId}-${Math.floor(at.getTime() / 60_000)}`,
      label: `Due date reminder · checklist item ${itemId}`,
    });
  } catch (error) {
    const code = error instanceof JobRejected ? error.code : (error as Error).message;
    console.error(`due-reminder-at item ${itemId}: not sent (${code}); the hourly run covers it`);
  }
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
 * Claim the (card, person, due day) keys of these cards and write the notifications for the keys claimed, in ONE
 * statement. The cards are re-checked (live, due window) in the same statement, and the people filtered by seat.
 */
async function remindPage(db: PrismaClient, ids: number[], w: Window, now: Date): Promise<number> {
  const rows = await db.$queryRaw<{sent: number}[]>`
    WITH due AS (
      SELECT c.id, c.workspace_id, c.board_id, c.due_date
      FROM cards c
      WHERE c.id = ANY(${ids}::int[])
        AND ${dueNow(w, now)}
    ),
    people AS (
      SELECT card_id, user_id FROM card_members WHERE card_id = ANY(${ids}::int[])
      UNION
      SELECT card_id, user_id FROM card_watchers WHERE card_id = ANY(${ids}::int[])
    ),
    eligible AS (
      SELECT d.id AS card_id, d.workspace_id, d.board_id, d.due_date, p.user_id
      FROM due d
      JOIN people p ON p.card_id = d.id
      JOIN boards b ON b.id = d.board_id AND b.workspace_id = d.workspace_id AND b.archived_at IS NULL
      JOIN workspaces w ON w.id = d.workspace_id AND w.archived_at IS NULL
      JOIN workspace_members m ON m.workspace_id = d.workspace_id AND m.user_id = p.user_id
      JOIN users u ON u.id = p.user_id
      WHERE u.status = 'active'
        AND (b.inbox_of IS NULL OR b.inbox_of = p.user_id)
        AND (b.visibility <> 'private' OR m.role IN ('owner', 'admin')
             OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = p.user_id))
    ),
    claimed AS (
      INSERT INTO due_reminders (card_id, user_id, due_on)
      SELECT card_id, user_id, due_date FROM eligible
      ON CONFLICT DO NOTHING
      RETURNING card_id, user_id
    ),
    sent AS (
      INSERT INTO notifications (user_id, workspace_id, kind, actor_id, board_id, card_id)
      SELECT k.user_id, e.workspace_id, 'due_soon', NULL, e.board_id, k.card_id
      FROM claimed k
      JOIN eligible e ON e.card_id = k.card_id AND e.user_id = k.user_id
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM sent)::int AS sent`;
  return rows[0]?.sent ?? 0;
}

/** Forget the keys of due days long past (bounded; the next run takes the rest). */
async function prunePast(db: PrismaClient, before: string): Promise<number> {
  return db.$executeRaw`
    DELETE FROM due_reminders
    WHERE ctid IN (SELECT ctid FROM due_reminders WHERE due_on < ${before}::date LIMIT 1000)`;
}

/**
 * After a PATCH changed a card's due time or reminder: one `due-reminder-at` job for the reminder moment. Never fails
 * the request (the hourly run is the safety net). The key is the card and the moment, so a double save sends once;
 * a job for an older moment finds nothing due when it runs (the rule reads the card as it is then).
 */
export async function scheduleTimedReminder(url: string, cardId: number, dueAt: Date | null, remindMinutes: number | null, now: Date = new Date()): Promise<void> {
  if (!dueAt || remindMinutes === null || dueAt.getTime() <= now.getTime()) return;
  try {
    const at = new Date(dueAt.getTime() - remindMinutes * 60_000);
    await sendJob(url, TIMED_REMINDER_LIST, {cardId}, {
      at,
      key: `due-${cardId}-${Math.floor(at.getTime() / 60_000)}`,
      label: `Due date reminder · card ${cardId}`,
    });
  } catch (error) {
    const code = error instanceof JobRejected ? error.code : (error as Error).message;
    console.error(`due-reminder-at card ${cardId}: not sent (${code}); the hourly run covers it`);
  }
}

/** The `due-reminder-at` handler: remind this one card's people if its reminder moment has come (safe to repeat). */
export async function runTimedReminder(db: PrismaClient, data: unknown, now: Date = new Date()): Promise<number> {
  const itemId = (data as {itemId?: unknown} | null)?.itemId;
  if (typeof itemId === 'number' && Number.isInteger(itemId) && itemId > 0) {
    const item = await db.checklistItem.findUnique({where: {id: itemId}, select: {workspaceId: true}});
    if (!item || (await frozen(db, item.workspaceId, new Map()))) return 0;
    return remindItems(db, [itemId], now);
  }
  const cardId = (data as {cardId?: unknown} | null)?.cardId;
  if (typeof cardId !== 'number' || !Number.isInteger(cardId) || cardId < 1) return 0;
  const card = await db.card.findUnique({where: {id: cardId}, select: {workspaceId: true}});
  if (!card) return 0;
  if (await frozen(db, card.workspaceId, new Map())) return 0;
  return remindPage(db, [cardId], reminderWindow(now), now);
}
