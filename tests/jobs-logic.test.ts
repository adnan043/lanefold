import {describe, expect, it} from 'vitest';

import {cutoff, keepDays, membershipEnded, nextCursor, shouldFallToFree} from '../src/server/jobs/logic';

const NOW = Date.parse('2026-11-02T00:00:00Z');
const PAST = '2026-10-01T00:00:00Z';
const FUTURE = '2026-12-01T00:00:00Z';

describe('scheduled job rules', () => {
  it('knows when a membership has ended', () => {
    expect(membershipEnded('canceled', PAST, NOW)).toBe(true);
    expect(membershipEnded('canceled', FUTURE, NOW)).toBe(false);
    expect(membershipEnded('canceled', null, NOW)).toBe(true);
    expect(membershipEnded('active', null, NOW)).toBe(false);
  });
  it('only falls to free when every membership ended', () => {
    expect(shouldFallToFree('pro', [{status: 'canceled', accessEndsAt: PAST}], NOW)).toBe(true);
    expect(shouldFallToFree('pro', [{status: 'canceled', accessEndsAt: PAST}, {status: 'active', accessEndsAt: null}], NOW)).toBe(false);
    expect(shouldFallToFree('pro', [], NOW)).toBe(false);
    expect(shouldFallToFree('free', [{status: 'canceled', accessEndsAt: PAST}], NOW)).toBe(false);
  });
  it('clamps retention days', () => {
    expect(keepDays(30, 5)).toBe(30);
    expect(keepDays(0, 5)).toBe(7);
    expect(keepDays('x', 5)).toBe(5);
    expect(keepDays(99999, 5)).toBe(3650);
  });
  it('computes a cutoff and the next keyset cursor', () => {
    expect(cutoff(NOW, 1).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(nextCursor([{id: 1}, {id: 2}], 2)).toBe(2);
    expect(nextCursor([{id: 1}], 2)).toBeNull();
    expect(nextCursor([{id: 5n}], 1)).toBe(5);
  });
});
