import {beforeEach, describe, expect, it, vi} from 'vitest';

const m = vi.hoisted(() => ({grace: vi.fn(async () => 0), forget: vi.fn(), audit: vi.fn(async () => {})}));
vi.mock('../src/server/entitlements', () => ({startGraceForWorkspaces: m.grace, forgetEntitlements: m.forget}));
vi.mock('../src/platform/auth', () => ({audit: m.audit}));

import {PAGE_SIZE} from '../src/server/jobs/logic';
import {sweepEndedMemberships, sweepGrace} from '../src/server/jobs/sweeps';

beforeEach(() => Object.values(m).forEach(f => f.mockClear()));

describe('sweepEndedMemberships', () => {
  // Per page: the SELECT answer, then the batch UPDATE ... RETURNING answer (rows actually moved).
  const mk = (free: unknown, pages: {id: number; plan: string}[][], moved?: ({id: number; from_plan: string}[] | null)[]) => {
    const q = vi.fn();
    pages.forEach((p, i) => {
      q.mockResolvedValueOnce(p);
      if (p.length) q.mockResolvedValueOnce(moved?.[i] ?? p.map(r => ({id: r.id, from_plan: r.plan})));
    });
    const createMany = vi.fn(async () => ({count: 0}));
    return {planLimit: {findUnique: vi.fn(async () => free)}, $queryRaw: q, auditEvent: {createMany}, createMany};
  };

  it('does nothing when the free plan row is missing', async () => {
    const db = mk(null, []);
    expect(await sweepEndedMemberships(db as never)).toEqual({moved: 0});
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('downgrades a page in one statement, starts grace in one batch, audits in one insert, clears the cache', async () => {
    const db = mk({maxMembers: 3}, [[{id: 9, plan: 'pro'}, {id: 10, plan: 'team'}]]);
    expect(await sweepEndedMemberships(db as never)).toEqual({moved: 2});
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(m.grace).toHaveBeenCalledTimes(1);
    expect(m.grace).toHaveBeenCalledWith(db, [9, 10]);
    expect(m.forget).toHaveBeenCalledWith(db, 9);
    expect(m.forget).toHaveBeenCalledWith(db, 10);
    expect(db.createMany).toHaveBeenCalledTimes(1);
    const data = (db.createMany.mock.calls as unknown[][])[0]![0] as {data: unknown[]};
    expect(data.data[0]).toMatchObject({actorUserId: null, action: 'workspace.plan_changed', targetType: 'workspace', targetId: '9', meta: {from: 'pro', to: 'free', by: 'sweep'}});
  });

  it('skips workspaces someone else already changed (not returned): no grace, no audit', async () => {
    const db = mk({maxMembers: 3}, [[{id: 9, plan: 'pro'}]], [[]]);
    expect(await sweepEndedMemberships(db as never)).toEqual({moved: 0});
    expect(m.grace).not.toHaveBeenCalled();
    expect(db.createMany).not.toHaveBeenCalled();
  });

  it('pages on until a short page', async () => {
    const full = Array.from({length: PAGE_SIZE}, (_, i) => ({id: i + 1, plan: 'pro'}));
    const db = mk({maxMembers: 3}, [full, [{id: PAGE_SIZE + 1, plan: 'pro'}]]);
    expect((await sweepEndedMemberships(db as never)).moved).toBe(PAGE_SIZE + 1);
    expect(db.$queryRaw).toHaveBeenCalledTimes(4);
  });
});

describe('sweepGrace', () => {
  it('re-evaluates a page of flagged workspaces in one batch and stops on a short page', async () => {
    const db = {$queryRaw: vi.fn().mockResolvedValueOnce([{id: 1}, {id: 2}])};
    expect(await sweepGrace(db as never)).toEqual({checked: 2});
    expect(m.grace).toHaveBeenCalledTimes(1);
    expect(m.grace).toHaveBeenCalledWith(db, [1, 2]);
    expect(m.forget).toHaveBeenCalledTimes(2);
  });
  it('is a no-op when nothing needs it', async () => {
    const db = {$queryRaw: vi.fn().mockResolvedValueOnce([])};
    expect(await sweepGrace(db as never)).toEqual({checked: 0});
    expect(m.grace).not.toHaveBeenCalled();
  });
});
