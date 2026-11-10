import type {Prisma} from '../generated/prisma/client';

/**
 * Drops notifications a person can never see again, so the list and the unread badge never scan dead rows.
 * Both take the transaction of the change that removed the access. One DELETE each, bounded by the person's / board's rows
 * (indexed on user_id, workspace_id).
 */

/** One person lost access to one board or one conversation (a seat removed, a chat left): delete THEIR rows for it. */
export async function dropNotificationsFor(
  tx: Prisma.TransactionClient,
  userId: number,
  target: {boardId?: number; conversationId?: number},
): Promise<number> {
  if (target.boardId === undefined && target.conversationId === undefined) return 0;
  const gone = await tx.notification.deleteMany({
    where: {
      userId,
      OR: [
        ...(target.boardId === undefined ? [] : [{boardId: target.boardId}]),
        ...(target.conversationId === undefined ? [] : [{conversationId: target.conversationId}]),
      ],
    },
  });
  return gone.count;
}

/**
 * A board turned private: delete the rows of everyone who has no seat on it and is not a workspace owner/admin
 * (they included the board's chat). Prepared statement, every value bound.
 */
export async function dropNotificationsForPrivateBoard(tx: Prisma.TransactionClient, boardId: number, workspaceId: number): Promise<number> {
  return tx.$executeRaw`
    DELETE FROM notifications n
    WHERE n.workspace_id = ${workspaceId}
      AND (n.board_id = ${boardId}
        OR n.conversation_id IN (SELECT cv.id FROM conversations cv WHERE cv.board_id = ${boardId} AND cv.workspace_id = ${workspaceId}))
      AND NOT EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = ${boardId} AND bm.user_id = n.user_id)
      AND NOT EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = ${workspaceId} AND wm.user_id = n.user_id AND wm.role IN ('owner', 'admin'))`;
}
