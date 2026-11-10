import {describe, expect, it} from 'vitest';

import {mentionIdsIn} from '../src/server/routes/chat';

const names = new Map([
  [1, 'Ann'],
  [2, 'Ann Lee'],
  [3, 'José'],
]);
const ids = [1, 2, 3];

describe('server mentions', () => {
  it('accepts the start, whitespace and opening or markup characters before the @', () => {
    for (const body of ['@Ann hi', 'hi @Ann', '(@Ann)', '[@Ann]', '"@Ann"', "'@Ann'", '>@Ann', '*@Ann*', '_@Ann_', ';@Ann']) {
      expect(mentionIdsIn(body, names, ids), body).toEqual([1]);
    }
  });
  it('rejects an @ glued to a word (an email) and a name that continues', () => {
    expect(mentionIdsIn('mail@Ann', names, ids)).toEqual([]);
    expect(mentionIdsIn('@Annabel', names, ids)).toEqual([]);
    expect(mentionIdsIn('@José', new Map([[3, 'Jose']]), [3])).toEqual([]);
  });
  it('longest name first', () => {
    expect(mentionIdsIn('@Ann Lee and @Ann', names, ids).sort()).toEqual([1, 2]);
    expect(mentionIdsIn('@Ann Lee', names, ids)).toEqual([2]);
  });
});
