import {describe, expect, it} from 'vitest';

import {addDays} from '../src/app/boards/bulk-bar';
import {createSelection, MAX_SELECTED, pruneIds, rangeIds, toggleId} from '../src/app/boards/selection';

describe('selection rules', () => {
  it('toggles an id on and off', () => {
    const on = toggleId(new Set(), 5);
    expect([...on.ids]).toEqual([5]);
    expect(toggleId(on.ids, 5).ids.size).toBe(0);
  });
  it('refuses a card past the cap but still lets one go', () => {
    const full = new Set(Array.from({length: MAX_SELECTED}, (_, i) => i + 1));
    const refused = toggleId(full, 999);
    expect(refused.capped).toBe(true);
    expect(refused.ids).toBe(full);
    expect(toggleId(full, 1).ids.size).toBe(MAX_SELECTED - 1);
  });
  it('ticks the range between the anchor and the clicked card, in either direction', () => {
    const order = [1, 2, 3, 4, 5, 6];
    expect([...rangeIds(new Set([2]), order, 2, 5).ids].sort()).toEqual([2, 3, 4, 5]);
    expect([...rangeIds(new Set([5]), order, 5, 3).ids].sort()).toEqual([3, 4, 5]);
    // no anchor, or an anchor that is not on screen: a plain toggle
    expect([...rangeIds(new Set(), order, null, 4).ids]).toEqual([4]);
    expect([...rangeIds(new Set(), order, 99, 4).ids]).toEqual([4]);
  });
  it('a range stops at the cap', () => {
    const order = Array.from({length: 80}, (_, i) => i + 1);
    const result = rangeIds(new Set([1]), order, 1, 80);
    expect(result.ids.size).toBe(MAX_SELECTED);
    expect(result.capped).toBe(true);
  });
  it('prunes ids whose card is gone and keeps the same set when nothing changed', () => {
    const current = new Set([1, 2, 3]);
    expect([...pruneIds(current, new Set([1, 3, 9]))].sort()).toEqual([1, 3]);
    expect(pruneIds(current, new Set([1, 2, 3, 4]))).toBe(current);
  });
});

describe('selection store', () => {
  it('select mode on ticks, off clears; listeners hear each change once', () => {
    const order = [10, 11, 12];
    const store = createSelection(() => order);
    let heard = 0;
    store.subscribe(() => heard++);
    expect(store.toggle(10)).toBe(false);
    expect(store.get().mode).toBe(true);
    store.toggle(12, true); // range from 10
    expect([...store.get().ids].sort()).toEqual([10, 11, 12]);
    store.clear();
    expect(store.get().ids.size).toBe(0);
    expect(store.get().mode).toBe(true);
    store.toggle(11);
    store.setMode(false);
    expect(store.get()).toMatchObject({mode: false});
    expect(store.get().ids.size).toBe(0);
    expect(heard).toBeGreaterThan(3);
    const before = heard;
    store.reset(); // already off and empty: no change, no notification
    expect(heard).toBe(before);
  });
  it('prune drops a vanished card and its anchor', () => {
    const store = createSelection(() => [1, 2]);
    store.toggle(1);
    store.toggle(2);
    store.prune(new Set([1]));
    expect([...store.get().ids]).toEqual([1]);
    expect(store.get().anchor).toBeNull();
  });
});

describe('addDays', () => {
  it('adds calendar days across a month and a year end', () => {
    expect(addDays('2026-01-30', 7)).toBe('2026-02-06');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});
