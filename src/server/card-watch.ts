import {Prisma, type PrismaClient} from '../generated/prisma/client';
import {notify, type NotificationKind} from './notifications';

/**
 * Card watch: people who follow a card hear about its changes in the bell.
 * `card_watchers (card_id, user_id)` holds who follows. A person follows a card when they ask to, comment on it,
 * or are assigned to it; they stop with the Watching toggle.
 */

/** The notification kinds a watched card sends (the comment one is `comment`, sent by the comment route). */
export type WatchEvent = Extract<NotificationKind, 'card_moved' | 'card_due' | 'card_done' | 'card_member'>;

/** Most followers told about ONE change (the notify helper caps recipients too). */
export const MAX_WATCHERS_NOTIFIED = 100;

type Db = Pick<PrismaClient, '$queryRaw' | 'cardWatcher' | 'workspaceMember' | 'notification'>;

/**
 * Follow a card (idempotent). The caller has already proven the person may see the card; workspace and board are
 * not re-checked here, so call it only with a context from `cardCtx` / `cardFor`.
 */
export async function addWatcher(db: Pick<PrismaClient, 'cardWatcher'>, cardId: number, userId: number): Promise<void> {
  await db.cardWatcher.createMany({data: [{cardId, userId}], skipDuplicates: true});
}

/**
 * Who follows the card AND may still see it: an active member of the workspace, with a seat on a private board,
 * and only the owner on a personal Inbox board. Never the actor, never anyone in `exclude`. One query, at most
 * MAX_WATCHERS_NOTIFIED ids, the workspace and board in the join.
 */
export async function watchersToTell(
  db: Pick<PrismaClient, '$queryRaw'>,
  card: {workspaceId: number; boardId: number; cardId: number},
  actorId: number | null,
  exclude: readonly number[] = []
): Promise<number[]> {
  const skip = [...new Set([...(actorId === null ? [] : [actorId]), ...exclude])];
  const rows = await db.$queryRaw<{user_id: number}[]>`
    SELECT w.user_id
    FROM card_watchers w
    JOIN cards c ON c.id = w.card_id AND c.workspace_id = ${card.workspaceId}::int AND c.board_id = ${card.boardId}::int
    JOIN boards b ON b.id = c.board_id AND b.workspace_id = c.workspace_id
    JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = w.user_id
    JOIN users u ON u.id = w.user_id
    WHERE w.card_id = ${card.cardId}::int
      AND u.status = 'active'
      AND (b.inbox_of IS NULL OR b.inbox_of = w.user_id)
      AND (b.visibility <> 'private' OR m.role IN ('owner', 'admin')
           OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = w.user_id))
      ${skip.length ? Prisma.sql`AND w.user_id NOT IN (${Prisma.join(skip)})` : Prisma.empty}
    ORDER BY w.user_id
    LIMIT ${MAX_WATCHERS_NOTIFIED}`;
  return rows.map(r => r.user_id);
}

/**
 * Tell the followers about a change, after it committed. Never throws (a failed notification must not fail the
 * change) and never tells the actor.
 */
export async function notifyWatchers(
  db: Db,
  card: {workspaceId: number; boardId: number; cardId: number},
  actorId: number,
  kind: WatchEvent,
  exclude: readonly number[] = []
): Promise<number> {
  try {
    const ids = await watchersToTell(db, card, actorId, exclude);
    if (ids.length === 0) return 0;
    return await notify(db as PrismaClient, ids, {workspaceId: card.workspaceId, kind, actorId, boardId: card.boardId, cardId: card.cardId});
  } catch (err) {
    console.error(`notifyWatchers ${kind}: ${(err as Error).message}`);
    return 0;
  }
}
