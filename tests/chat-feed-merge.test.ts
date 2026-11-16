import {describe, expect, it} from 'vitest';

import type {MessageT} from '../src/app/chat/api';
import {mergeMessages, sameMessage} from '../src/app/chat/use-message-feed';

const msg = (seq: number, over: Partial<MessageT> = {}): MessageT => ({
  id: String(seq * 10),
  conversationId: 1,
  seq,
  sender: {id: 1, name: 'Ann'},
  kind: 'user',
  body: `m${seq}`,
  parentId: null,
  replyCount: 0,
  edited: false,
  deleted: false,
  pinned: false,
  mentions: [],
  cardIds: [],
  reactions: [],
  createdAt: '2026-11-16T10:00:00.000Z',
  ...over,
});

describe('chat feed merge', () => {
  it('sees every change a refresh can bring, and nothing else', () => {
    const a = msg(1, {reactions: [{emoji: '👍', count: 1, mine: true}], numberRefs: {4: {id: 9, boardId: 2, title: 'x'}}});
    expect(sameMessage(a, structuredClone(a))).toBe(true);
    expect(sameMessage(a, {...a, body: 'edited', edited: true})).toBe(false);
    expect(sameMessage(a, {...a, deleted: true})).toBe(false);
    expect(sameMessage(a, {...a, pinned: true})).toBe(false);
    expect(sameMessage(a, {...a, replyCount: 1})).toBe(false);
    expect(sameMessage(a, {...a, reactions: [{emoji: '👍', count: 2, mine: true}]})).toBe(false);
    expect(sameMessage(a, {...a, reactions: []})).toBe(false);
    expect(sameMessage(a, {...a, numberRefs: {4: {id: 9, boardId: 2, title: 'y'}}})).toBe(false);
    expect(sameMessage(a, {...a, numberRefs: undefined})).toBe(false);
    expect(sameMessage(a, {...a, sender: {id: 1, name: 'Bea'}})).toBe(false);
  });

  it('keeps the same list and objects when a refresh changed nothing', () => {
    const list = [msg(1), msg(2), msg(3)];
    const out = mergeMessages(list, list.map(m => structuredClone(m)));
    expect(out).toBe(list);
  });

  it('replaces only what changed, and keeps seq order', () => {
    const list = [msg(1), msg(3), msg(5)];
    const out = mergeMessages(list, [msg(3, {body: 'new'}), msg(4), msg(6), msg(2)]);
    expect(out.map(m => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out[0]).toBe(list[0]);
    expect(out[2]!.body).toBe('new');
    expect(out[4]).toBe(list[2]);
  });

  it('appends new messages in order', () => {
    const list = [msg(1), msg(2)];
    expect(mergeMessages(list, [msg(3), msg(4)]).map(m => m.seq)).toEqual([1, 2, 3, 4]);
    expect(mergeMessages([], [msg(2), msg(1)]).map(m => m.seq)).toEqual([1, 2]);
  });
});
