import type {Prisma} from '../generated/prisma/client';

/**
 * A copy's labels, assignees, field values and checklists with their items: ONE statement per table (createMany),
 * never one INSERT per row as a nested `create` does, so the board lock is held for a few statements whatever the
 * card holds (the pattern of card-templates.ts apply-template). Checklists come back in the order they were given.
 */
export async function copyCardParts(
  tx: Pick<Prisma.TransactionClient, 'cardLabel' | 'cardMember' | 'cardFieldValue' | 'checklist' | 'checklistItem'>,
  workspaceId: number,
  cardId: number,
  src: {
    labels: {labelId: number}[];
    members: {userId: number}[];
    fieldValues: {fieldId: number; textValue: string | null; numberValue: number | null; dateValue: Date | null; boolValue: boolean | null; optionId: number | null}[];
    checklists: {title: string; position: string; items: {text: string; position: string}[]}[];
  }
): Promise<void> {
  if (src.labels.length) await tx.cardLabel.createMany({data: src.labels.map(l => ({cardId, labelId: l.labelId}))});
  if (src.members.length) await tx.cardMember.createMany({data: src.members.map(m => ({cardId, userId: m.userId, workspaceId}))});
  if (src.fieldValues.length) await tx.cardFieldValue.createMany({data: src.fieldValues.map(v => ({...v, cardId, workspaceId}))});
  if (!src.checklists.length) return;
  const lists = await tx.checklist.createManyAndReturn({
    data: src.checklists.map(l => ({cardId, workspaceId, title: l.title, position: l.position})),
    select: {id: true},
  });
  const items = src.checklists.flatMap((l, i) => l.items.map(it => ({workspaceId, checklistId: lists[i]!.id, text: it.text, position: it.position})));
  if (items.length) await tx.checklistItem.createMany({data: items});
}
