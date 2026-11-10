import type {PrismaClient} from '../generated/prisma/client';

/**
 * The helper other routes call to notify people in app (no emails in the MVP: SPEC §3).
 * Never throws (a failed notification must not fail the action that caused it) and never notifies:
 *   - the actor about their own action,
 *   - someone who is not a member of the workspace (one query checks them all).
 * Rows carry ids only; names are looked up when the list is read.
 */
export const NOTIFICATION_KINDS = ['assigned', 'mentioned', 'due_soon', 'comment', 'message_mention', 'card_moved', 'card_due', 'card_done', 'card_member', 'board_member'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotifyInput = {
  workspaceId: number;
  kind: NotificationKind;
  /** Who did it; null for the system (a due date reminder). */
  actorId: number | null;
  boardId?: number | null;
  cardId?: number | null;
  conversationId?: number | null;
};

const MAX_RECIPIENTS = 100;
/** Notifications one person can receive per hour FROM ONE ACTOR; beyond it new ones are dropped silently (mention spam). */
export const NOTIFICATIONS_PER_ACTOR_HOUR = 20;
/** Notifications one person can receive per hour in all (load guard); a single actor cannot reach it alone. */
export const NOTIFICATIONS_PER_HOUR = 200;

export type Recent = {total: number; byActor: number};

/** Pure: the recipients still under both caps, given what each got in the last hour (all, and from this actor). */
export function underCap(
  userIds: readonly number[],
  recent: ReadonlyMap<number, Recent | number>,
  caps: {perActor: number; total: number} = {perActor: NOTIFICATIONS_PER_ACTOR_HOUR, total: NOTIFICATIONS_PER_HOUR}
): number[] {
  return userIds.filter(id => {
    const r = recent.get(id);
    const total = typeof r === 'number' ? r : (r?.total ?? 0);
    const byActor = typeof r === 'number' ? r : (r?.byActor ?? 0);
    return total < caps.total && byActor < caps.perActor;
  });
}

/** Pure: unique, valid ids, without the actor, bounded. */
export function recipientsOf(userIds: readonly number[], actorId: number | null): number[] {
  const out = new Set<number>();
  for (const id of userIds) {
    if (Number.isSafeInteger(id) && id > 0 && id !== actorId) out.add(id);
    if (out.size >= MAX_RECIPIENTS) break;
  }
  return [...out];
}

/** Returns how many notifications were created. Two queries at most, whatever the number of recipients. */
export async function notify(db: PrismaClient, userIds: readonly number[], input: NotifyInput): Promise<number> {
  try {
    const wanted = recipientsOf(userIds, input.actorId);
    if (wanted.length === 0) return 0;
    const members = await db.workspaceMember.findMany({
      where: {workspaceId: input.workspaceId, userId: {in: wanted}, workspace: {archivedAt: null}},
      select: {userId: true},
      take: MAX_RECIPIENTS,
    });
    if (members.length === 0) return 0;
    // ONE bounded query: per recipient, their newest CAP rows (index notifications(user_id, id desc)), counted
    // for the last hour in all and from this actor; never a scan of their whole history.
    const since = new Date(Date.now() - 3600_000);
    const ids = members.map(m => m.userId);
    const counts = await db.$queryRaw<{user_id: number; total: number; by_actor: number}[]>`
      SELECT u AS user_id,
             (SELECT count(*) FROM (SELECT created_at FROM notifications WHERE user_id = u ORDER BY id DESC LIMIT ${NOTIFICATIONS_PER_HOUR}) r
              WHERE r.created_at > ${since})::int AS total,
             (SELECT count(*) FROM (SELECT created_at, actor_id FROM notifications WHERE user_id = u ORDER BY id DESC LIMIT ${NOTIFICATIONS_PER_HOUR}) r
              WHERE r.created_at > ${since} AND r.actor_id IS NOT DISTINCT FROM ${input.actorId}::int)::int AS by_actor
      FROM unnest(${ids}::int[]) AS u`;
    const open = new Set(underCap(ids, new Map(counts.map(r => [r.user_id, {total: r.total, byActor: r.by_actor}]))));
    const allowed = members.filter(m => open.has(m.userId));
    if (allowed.length === 0) return 0;
    const created = await db.notification.createMany({
      data: allowed.map(m => ({
        userId: m.userId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        actorId: input.actorId,
        boardId: input.boardId ?? null,
        cardId: input.cardId ?? null,
        conversationId: input.conversationId ?? null,
      })),
    });
    return created.count;
  } catch (err) {
    console.error(`notify ${input.kind}: ${(err as Error).message}`);
    return 0;
  }
}
