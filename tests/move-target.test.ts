import {describe, expect, it} from 'vitest';

import type {LaneT} from '../src/app/api';
import {moveIndex, moveSlots} from '../src/app/boards/move-target';

const lane = (id: number, ids: number[]) => ({id, cards: ids.map(i => ({id: i}))}) as unknown as LaneT;
const lanes = [lane(1, [10, 11, 12]), lane(2, [])];

describe('move-to helper', () => {
  it('counts slots without the moved card', () => {
    expect(moveSlots(lanes, 10, 1)).toBe(3);
    expect(moveSlots(lanes, 10, 2)).toBe(1);
    expect(moveSlots([lane(1, [10, 11])], 99, 1)).toBe(3);
  });
  it('maps a 1-based position to a clamped index', () => {
    expect(moveIndex(lanes, 10, 1, 1)).toBe(0);
    expect(moveIndex(lanes, 10, 1, 3)).toBe(2);
    expect(moveIndex(lanes, 10, 1, 9)).toBe(2);
    expect(moveIndex(lanes, 10, 2, 0)).toBe(0);
  });
});
