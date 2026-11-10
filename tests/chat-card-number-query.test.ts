import {describe, expect, it} from 'vitest';

import {cardNumberRefs} from '../src/server/routes/chat';

type Row = Parameters<typeof cardNumberRefs>[3][number];
const msg = (bodyMd: string, deletedAt: Date | null = null) => ({bodyMd, deletedAt}) as unknown as Row;
const board = {kind: 'board', boardId: 7, workspaceId: 1, workspaceRole: 'member' as const};

/** A stand-in database that counts the card reads (the real one is exercised by the integration test). */
function stub(cards: {id: number; number: number | null; title: string; boardId: number}[] = []) {
  const calls: any[] = [];
  const db = {
    card: {
      findMany: async (args: any) => {
        calls.push(args);
        return cards;
      },
    },
  } as any;
  return {db, calls};
}

describe('cardNumberRefs: at most one bounded query per page', () => {
  it('makes no query when no message has a reference', async () => {
    const {db, calls} = stub();
    expect((await cardNumberRefs(db, board, 5, [msg('hello'), msg('C#1 and `#2`')])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('makes no query outside a board chat (channel, DM, group)', async () => {
    const {db, calls} = stub();
    for (const kind of ['channel', 'dm', 'group']) {
      await cardNumberRefs(db, {...board, kind}, 5, [msg('see #1')]);
    }
    await cardNumberRefs(db, {...board, boardId: null}, 5, [msg('see #1')]);
    expect(calls).toHaveLength(0);
  });

  it('does not look at deleted messages', async () => {
    const {db, calls} = stub();
    await cardNumberRefs(db, board, 5, [msg('see #1', new Date())]);
    expect(calls).toHaveLength(0);
  });

  it('asks ONE question for a whole page, distinct numbers only, scoped to the board and the viewer', async () => {
    const {db, calls} = stub([{id: 90, number: 2, title: 'Two', boardId: 7}]);
    const out = await cardNumberRefs(db, board, 5, [msg('#1 #2'), msg('#2 #3'), msg('again #1')]);
    expect(calls).toHaveLength(1);
    const where = calls[0].where;
    expect(where.boardId).toBe(7);
    expect(where.workspaceId).toBe(1);
    expect(where.archivedAt).toBeNull();
    expect([...where.number.in].sort()).toEqual([1, 2, 3]);
    expect(where.board).toBeDefined(); // the Inbox / private-board rule is in the where, not checked afterwards
    expect(calls[0].select).toEqual({id: true, number: true, title: true, boardId: true}); // never more than this
    expect(out.get(2)).toEqual({id: 90, boardId: 7, title: 'Two'});
    expect(out.has(1)).toBe(false);
  });

  it('caps the numbers of a page', async () => {
    const {db, calls} = stub();
    const many = Array.from({length: 60}, (_, i) => msg(`#${i + 1}`));
    await cardNumberRefs(db, board, 5, many);
    expect(calls).toHaveLength(1);
    expect(calls[0].where.number.in.length).toBeLessThanOrEqual(20);
    expect(calls[0].take).toBeLessThanOrEqual(20);
  });
});
