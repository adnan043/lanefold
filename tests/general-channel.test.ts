import {describe, expect, it, vi} from 'vitest';

import {ensureGeneralChannel} from '../src/server/general-channel';

function fakeDb(existing: {id: number} | null) {
  const db = {
    conversation: {findFirst: vi.fn(async () => existing), create: vi.fn(async () => ({id: 42}))},
    conversationMember: {create: vi.fn(async () => ({userId: 7}))},
  };
  return db;
}

describe('ensureGeneralChannel', () => {
  it('creates #general and adds the creator as its first member', async () => {
    const db = fakeDb(null);
    await ensureGeneralChannel(db as never, 3, 7);
    expect(db.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({where: {workspaceId: 3, kind: 'channel', name: 'general'}}));
    expect(db.conversation.create).toHaveBeenCalledWith(expect.objectContaining({data: {workspaceId: 3, kind: 'channel', name: 'general', createdBy: 7}}));
    expect(db.conversationMember.create).toHaveBeenCalledWith(expect.objectContaining({data: {conversationId: 42, userId: 7, workspaceId: 3}}));
  });

  it('is idempotent: an existing channel is left alone', async () => {
    const db = fakeDb({id: 1});
    await ensureGeneralChannel(db as never, 3, 7);
    expect(db.conversation.create).not.toHaveBeenCalled();
    expect(db.conversationMember.create).not.toHaveBeenCalled();
  });

  it('does not add a member when the channel could not be created', async () => {
    const db = fakeDb(null);
    db.conversation.create.mockRejectedValueOnce(new Error('db down'));
    await expect(ensureGeneralChannel(db as never, 3, 7)).rejects.toThrow('db down');
    expect(db.conversationMember.create).not.toHaveBeenCalled();
  });
});
