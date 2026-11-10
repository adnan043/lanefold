import {describe, expect, it} from 'vitest';

import {incomingSince, newestSeq} from '../src/app/chat/announce';

const m = (seq: number, sender: number, deleted = false) => ({seq, sender: {id: sender, name: null}, deleted});

describe('chat announcements', () => {
  it('counts only newer messages from others', () => {
    const items = [m(1, 2), m(2, 1), m(3, 2), m(4, 3), m(5, 2, true)];
    expect(incomingSince(items, 2, 1)).toEqual({count: 2, maxSeq: 5});
  });
  it('ignores older pages and own messages', () => {
    expect(incomingSince([m(1, 2), m(2, 2)], 5, 1)).toEqual({count: 0, maxSeq: 5});
    expect(incomingSince([m(6, 1)], 5, 1)).toEqual({count: 0, maxSeq: 6});
  });
  it('finds the newest seq', () => {
    expect(newestSeq([])).toBe(0);
    expect(newestSeq([m(3, 1), m(9, 1), m(4, 1)])).toBe(9);
  });
});
