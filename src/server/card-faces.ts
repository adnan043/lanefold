import {Prisma, type PrismaClient} from '../generated/prisma/client';

/** What a card's face on the board shows beyond its own columns. Caps keep the board answer small. */
export const FACE_LABELS = 4;
export const FACE_MEMBERS = 3;

export type FaceExtras = {
  labels: {id: number; name: string; colorHex: string}[];
  labelCount: number;
  members: {id: number; name: string}[];
  memberCount: number;
  coverAttachmentId: number | null;
};

const EMPTY: FaceExtras = {labels: [], labelCount: 0, members: [], memberCount: 0, coverAttachmentId: null};

/**
 * Labels, assignees and cover for a page of cards: THREE prepared statements in parallel for the whole page
 * (never one per card), each scoped by the workspace. Names only: an email is never selected.
 */
export async function faceExtras(db: PrismaClient, workspaceId: number, cardIds: number[]): Promise<Map<number, FaceExtras>> {
  const out = new Map<number, FaceExtras>();
  const ids = [...new Set(cardIds.filter(id => id > 0))];
  if (ids.length === 0) return out;
  const list = Prisma.join(ids);
  const [labels, members, covers] = await Promise.all([
    db.$queryRaw<{card_id: number; id: number; name: string; color_hex: string; total: bigint}[]>`
      SELECT card_id, id, name, color_hex, total FROM (
        SELECT cl.card_id, l.id, l.name, l.color_hex,
               row_number() OVER (PARTITION BY cl.card_id ORDER BY l.id) AS rn,
               count(*) OVER (PARTITION BY cl.card_id) AS total
        FROM card_labels cl JOIN labels l ON l.id = cl.label_id
        WHERE cl.card_id IN (${list}) AND l.workspace_id = ${workspaceId}
      ) t WHERE rn <= ${FACE_LABELS} ORDER BY card_id, rn`,
    db.$queryRaw<{card_id: number; user_id: number; name: string; total: bigint}[]>`
      SELECT card_id, user_id, name, total FROM (
        SELECT cm.card_id, cm.user_id, u.name,
               row_number() OVER (PARTITION BY cm.card_id ORDER BY cm.created_at, cm.user_id) AS rn,
               count(*) OVER (PARTITION BY cm.card_id) AS total
        FROM card_members cm JOIN users u ON u.id = cm.user_id
        WHERE cm.card_id IN (${list}) AND cm.workspace_id = ${workspaceId}
      ) t WHERE rn <= ${FACE_MEMBERS} ORDER BY card_id, rn`,
    db.$queryRaw<{card_id: number; id: number}[]>`
      SELECT c.id AS card_id, a.id
      FROM cards c JOIN attachments a ON a.file_id = c.cover_file_id AND a.workspace_id = c.workspace_id
      WHERE c.id IN (${list}) AND c.workspace_id = ${workspaceId} AND a.ready = true`,
  ]);
  const get = (id: number) => {
    let e = out.get(id);
    if (!e) out.set(id, (e = {...EMPTY, labels: [], members: []}));
    return e;
  };
  for (const r of labels) {
    const e = get(r.card_id);
    e.labels.push({id: r.id, name: r.name, colorHex: r.color_hex});
    e.labelCount = Number(r.total);
  }
  for (const r of members) {
    const e = get(r.card_id);
    e.members.push({id: r.user_id, name: r.name});
    e.memberCount = Number(r.total);
  }
  for (const r of covers) get(r.card_id).coverAttachmentId = r.id;
  return out;
}

/** Fold the extras into shaped cards (a card with none gets the empty face). */
export async function withFaces<T extends {id: number}>(db: PrismaClient, workspaceId: number, cards: T[]): Promise<(T & FaceExtras)[]> {
  const extras = await faceExtras(db, workspaceId, cards.map(c => c.id));
  // A card with no extras gets its own empty arrays, never a shared one a later push would leak across cards.
  return cards.map(c => ({...c, ...(extras.get(c.id) ?? {...EMPTY, labels: [], members: []})}));
}
