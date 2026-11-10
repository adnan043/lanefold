import type {BoardFilter} from './filter-logic';

/** Pure logic of shared saved filters and the "My cards" chip (tests/saved-filter-share.test.ts): no React, no network. */
export type SavedScope = 'private' | 'board';
export type SavedListItem = {id: number; scope: SavedScope; mine: boolean; author: {name: string | null} | null};

/** Mine first (private and shared by me), then the ones other people shared; both keep the server's newest-first order. */
export function groupSavedFilters<T extends SavedListItem>(items: T[]): {mine: T[]; sharedByOthers: T[]} {
  return {mine: items.filter(i => i.mine), sharedByOthers: items.filter(i => !i.mine && i.scope === 'board')};
}

/** The cap counts only what I own (private and shared); the shared ones of others are not mine. */
export const ownCount = (items: SavedListItem[]) => items.filter(i => i.mine).length;

/** May the viewer rename, share, unshare or delete this one? Mine, or a shared one when they administer the board. */
export const canManageSaved = (item: SavedListItem, canAdmin: boolean) => item.mine || (item.scope === 'board' && canAdmin);

/** The "My cards" chip is on when the member filter is exactly me. */
export const isMyCards = (filter: BoardFilter, meId: number | null | undefined): boolean =>
  meId != null && filter.memberIds?.length === 1 && filter.memberIds[0] === meId;

/** Turn the chip on (member filter = me, other criteria kept) or off (member filter cleared). */
export function toggleMyCards(filter: BoardFilter, meId: number): BoardFilter {
  if (isMyCards(filter, meId)) {
    const {memberIds: _off, ...rest} = filter;
    return rest;
  }
  return {...filter, memberIds: [meId]};
}
