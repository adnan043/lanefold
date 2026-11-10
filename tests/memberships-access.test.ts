import {beforeEach, describe, expect, it, vi} from 'vitest';

const findMany = vi.fn();
let db: unknown = {membership: {findMany}};
vi.mock('../src/platform/db', () => ({getDb: () => db}));

import type {Viewer} from '../src/lib/types';
import {activeMemberships, hasMembership} from '../src/server/memberships';

const viewer = (over: Partial<Viewer> = {}) => ({state: 'user', id: 5, email: 'Me@Example.com', emailVerified: true, ...over}) as Viewer;
const future = new Date(Date.now() + 86_400_000);
const past = new Date(Date.now() - 86_400_000);

beforeEach(() => {
  findMany.mockReset();
  db = {membership: {findMany}};
});

describe('activeMemberships', () => {
  it('matches by user id and a lowercased VERIFIED email', async () => {
    findMany.mockResolvedValue([]);
    await activeMemberships(viewer(), ['a', 'b']);
    const args = findMany.mock.calls[0]![0];
    expect(args.where.OR).toEqual([{userId: 5}, {email: 'me@example.com'}]);
    expect(args.where.priceKey).toEqual({in: ['a', 'b']});
    expect(args.take).toBe(20);
  });

  it('never matches an unverified email address', async () => {
    findMany.mockResolvedValue([]);
    await activeMemberships(viewer({emailVerified: false}), ['a']);
    expect(findMany.mock.calls[0]![0].where.OR).toEqual([{userId: 5}]);
  });

  it('answers empty without a query for guests, missing ids, no keys or no database', async () => {
    expect(await activeMemberships(viewer({state: 'guest'} as never), ['a'])).toEqual([]);
    expect(await activeMemberships(viewer({id: null} as never), ['a'])).toEqual([]);
    expect(await activeMemberships(viewer(), [])).toEqual([]);
    db = null;
    expect(await activeMemberships(viewer(), ['a'])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('keeps only rows that still grant access', async () => {
    findMany.mockResolvedValue([
      {priceKey: 'a', status: 'active', accessEndsAt: null},
      {priceKey: 'a', status: 'canceled', accessEndsAt: future},
      {priceKey: 'a', status: 'canceled', accessEndsAt: past},
      {priceKey: 'a', status: 'canceled', accessEndsAt: null},
    ]);
    const rows = await activeMemberships(viewer(), ['a']);
    expect(rows).toHaveLength(2);
    expect(await hasMembership(viewer(), ['a'])).toBe(true);
  });

  it('hasMembership is false when every row has ended', async () => {
    findMany.mockResolvedValue([{priceKey: 'a', status: 'canceled', accessEndsAt: past}]);
    expect(await hasMembership(viewer(), ['a'])).toBe(false);
  });
});
