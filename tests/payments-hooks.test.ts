import {beforeEach, describe, expect, it, vi} from 'vitest';

const calls: {where: Record<string, unknown>; data: Record<string, unknown>}[] = [];

vi.mock('../src/platform/db', async importOriginal => {
  const original = await importOriginal<typeof import('../src/platform/db')>();
  const fake = {
    membership: {
      findUnique: async () => ({id: 1}),
      updateMany: async (args: {where: Record<string, unknown>; data: Record<string, unknown>}) => {
        calls.push(args);
        return {count: 1};
      },
    },
  };
  return {...original, getDb: () => fake};
});

import {recordMembership, refParts} from '../src/server/payments-hooks';

const membership = (over: Record<string, unknown> = {}) => ({
  id: 'sub_1',
  price: 'pro-monthly',
  email: null,
  status: 'active' as const,
  currentPeriodEnd: null,
  accessEndsAt: null,
  customerRef: null,
  checkoutId: null,
  ...over,
});

describe('membership customer reference', () => {
  it('reads the user and the workspace', () => {
    expect(refParts('12:34')).toEqual([12, 34]);
    expect(refParts('12')).toEqual([12, null]);
    expect(refParts(null)).toEqual([null, null]);
    expect(refParts('12:abc')).toEqual([12, null]);
    expect(refParts('12:0')).toEqual([12, null]);
  });
});

describe('recordMembership keeps what the event does not carry', () => {
  beforeEach(() => void (calls.length = 0));

  it('never blanks userId, email or workspaceId, and does not invent a timestamp', async () => {
    await recordMembership(membership(), 'test');
    const {where, data} = calls[0]!;
    expect(data).not.toHaveProperty('userId');
    expect(data).not.toHaveProperty('email');
    expect(data).not.toHaveProperty('workspaceId');
    expect(data).not.toHaveProperty('lastEventAt');
    expect(where).not.toHaveProperty('OR');
  });

  it('writes them when present, with the event time as the staleness guard', async () => {
    await recordMembership(membership({email: 'A@B.test', customerRef: '7:9'}), 'test', '2026-01-01T00:00:00.000Z');
    const {where, data} = calls[0]!;
    expect(data).toMatchObject({userId: 7, workspaceId: 9, email: 'a@b.test', lastEventAt: new Date('2026-01-01T00:00:00.000Z')});
    expect(where).toHaveProperty('OR');
  });
});
