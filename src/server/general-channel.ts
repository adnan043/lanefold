import type {Prisma, PrismaClient} from '../generated/prisma/client';

/**
 * `#general` for a new workspace (docs/product/SPEC.md §7: created with each workspace). Idempotent: a workspace
 * that already has a channel named `general` is left alone. Chat members are rows in `conversation_members`;
 * the creator gets theirs here, others join the channel from the chat screen.
 */
export async function ensureGeneralChannel(db: PrismaClient | Prisma.TransactionClient, workspaceId: number, userId: number): Promise<void> {
  const existing = await db.conversation.findFirst({where: {workspaceId, kind: 'channel', name: 'general'}, select: {id: true}});
  if (existing) return;
  const conv = await db.conversation.create({data: {workspaceId, kind: 'channel', name: 'general', createdBy: userId}, select: {id: true}});
  await db.conversationMember.create({data: {conversationId: conv.id, userId, workspaceId}, select: {userId: true}});
}
