import {describe, expect, it} from 'vitest';

import {linkableBoardWhere} from '../src/server/routes/chat';

describe('cards a chat message may link', () => {
  it('owners and admins see every board except other people\'s Inbox', () => {
    expect(linkableBoardWhere(7, 'admin')).toEqual({OR: [{inboxOf: null}, {inboxOf: 7}]});
    expect(linkableBoardWhere(7, 'owner')).toEqual({OR: [{inboxOf: null}, {inboxOf: 7}]});
  });
  it('members and viewers need an open board or a seat on a private one', () => {
    for (const role of ['member', 'viewer'] as const) {
      const where = JSON.stringify(linkableBoardWhere(7, role));
      expect(where).toContain('"visibility":{"not":"private"}');
      expect(where).toContain('"boardMembers":{"some":{"userId":7}}');
      expect(where).toContain('"inboxOf":null');
    }
  });
});
