import {describe, expect, it} from 'vitest';

import {cleanFilter} from '../src/app/boards/filter-logic';
import {isEmptyFilter} from '../src/app/boards/saved-filters';

describe('saved filters (client logic)', () => {
  it('treats a blank snapshot as nothing to save', () => {
    expect(isEmptyFilter({})).toBe(true);
    expect(isEmptyFilter({text: '   ', labelIds: []})).toBe(true);
  });
  it('treats any active field as saveable', () => {
    expect(isEmptyFilter({text: 'bug'})).toBe(false);
    expect(isEmptyFilter({labelIds: [3]})).toBe(false);
    expect(isEmptyFilter({priority: 'urgent'})).toBe(false);
    expect(isEmptyFilter({dues: ['overdue']})).toBe(false);
  });
  it('drops unknown or malformed fields when a stored filter is applied', () => {
    expect(cleanFilter({priority: 'urgent', memberIds: [2, 'x'], evil: 1})).toEqual({priority: 'urgent', memberIds: [2]});
  });
});
