import {describe, expect, it} from 'vitest';

import {canManageSaved, groupSavedFilters, isMyCards, ownCount, toggleMyCards, type SavedListItem} from '../src/app/boards/saved-filter-groups';

const item = (id: number, over: Partial<SavedListItem> = {}): SavedListItem => ({id, scope: 'private', mine: true, author: null, ...over});

describe('shared saved filters (client logic)', () => {
  it('lists mine first and keeps the shared ones of other people apart', () => {
    const items = [item(5, {scope: 'board', mine: false, author: {name: 'Ann'}}), item(4), item(3, {scope: 'board'}), item(2, {mine: false, scope: 'private'})];
    const g = groupSavedFilters(items);
    expect(g.mine.map(i => i.id)).toEqual([4, 3]);
    expect(g.sharedByOthers.map(i => i.id)).toEqual([5]);
  });
  it('counts only what I own toward my cap', () => {
    expect(ownCount([item(1), item(2, {scope: 'board'}), item(3, {mine: false, scope: 'board'})])).toBe(2);
  });
  it('lets an author manage theirs and a board admin manage the shared ones', () => {
    expect(canManageSaved(item(1), false)).toBe(true);
    expect(canManageSaved(item(2, {mine: false, scope: 'board'}), false)).toBe(false);
    expect(canManageSaved(item(2, {mine: false, scope: 'board'}), true)).toBe(true);
    expect(canManageSaved(item(3, {mine: false, scope: 'private'}), true)).toBe(false);
  });
});

describe('"My cards" chip', () => {
  it('is on only when the member filter is exactly me', () => {
    expect(isMyCards({memberIds: [7]}, 7)).toBe(true);
    expect(isMyCards({memberIds: [7, 8]}, 7)).toBe(false);
    expect(isMyCards({memberIds: [8]}, 7)).toBe(false);
    expect(isMyCards({}, 7)).toBe(false);
    expect(isMyCards({memberIds: [7]}, null)).toBe(false);
  });
  it('turns on keeping the other criteria, and off by clearing only the member filter', () => {
    expect(toggleMyCards({priority: 'high', memberIds: [3]}, 7)).toEqual({priority: 'high', memberIds: [7]});
    expect(toggleMyCards({priority: 'high', memberIds: [7]}, 7)).toEqual({priority: 'high'});
    expect(toggleMyCards({}, 7)).toEqual({memberIds: [7]});
  });
});
