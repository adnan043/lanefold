import {describe, expect, it} from 'vitest';

import {isStale, isStaleDays, STALE_DAY_OPTIONS} from '../src/lib/stale';

const DAY = 86_400_000;
const now = new Date('2026-11-10T12:00:00.000Z');

describe('stale card rule (pure)', () => {
  it('offers exactly 3, 7, 14 and 30 days', () => {
    expect([...STALE_DAY_OPTIONS]).toEqual([3, 7, 14, 30]);
    for (const ok of [3, 7, 14, 30]) expect(isStaleDays(ok)).toBe(true);
    for (const bad of [0, 1, 5, 31, -7, 7.5, '7', null, undefined, NaN]) expect(isStaleDays(bad)).toBe(false);
  });

  it('is stale at exactly N days and after, not before', () => {
    expect(isStale(new Date(now.getTime() - 7 * DAY), 7, now)).toBe(true);
    expect(isStale(new Date(now.getTime() - 7 * DAY - 1), 7, now)).toBe(true);
    expect(isStale(new Date(now.getTime() - 7 * DAY + 1), 7, now)).toBe(false);
    expect(isStale(new Date(now.getTime() - 2 * DAY), 3, now)).toBe(false);
  });

  it('is never stale when the setting is off or not a real choice', () => {
    expect(isStale(new Date(now.getTime() - 400 * DAY), null, now)).toBe(false);
    expect(isStale(new Date(now.getTime() - 400 * DAY), 5, now)).toBe(false);
  });
});
