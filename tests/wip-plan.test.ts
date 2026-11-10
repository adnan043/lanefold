import {describe, expect, it} from 'vitest';

import {draftKey} from '../src/app/draft-store';
import {planWipSaves} from '../src/app/boards/wip-plan';

describe('planWipSaves', () => {
  it('keeps the limit of a lane that appeared after the drawer opened', () => {
    const lanes = [{id: 1, wipLimit: 3}, {id: 2, wipLimit: 5}];
    expect(planWipSaves(lanes, {1: '4'})).toEqual([{id: 1, wipLimit: 4}]);
  });
  it('skips temporary lanes and unchanged values, clears on empty', () => {
    const lanes = [{id: -1, wipLimit: null}, {id: 1, wipLimit: 3}, {id: 2, wipLimit: 5}];
    expect(planWipSaves(lanes, {[-1]: '2', 1: '3', 2: ' '})).toEqual([{id: 2, wipLimit: null}]);
  });
});

describe('board draft key', () => {
  it('is per user and board', () => {
    expect(draftKey(1, 'board', 2, 7)).not.toBe(draftKey(1, 'board', 3, 7));
    expect(draftKey(1, 'board', 2, 7)).not.toBe(draftKey(1, 'board', 2, 8));
  });
});
