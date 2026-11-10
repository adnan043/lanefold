import {describe, expect, it} from 'vitest';
import {idleBaseMs} from '../src/app/use-board-sync';

describe('board sync idle backoff', () => {
  it('polls every 5 s while active, then slows down on a quiet board', () => {
    expect(idleBaseMs(0)).toBe(5000);
    expect(idleBaseMs(11)).toBe(5000);
    expect(idleBaseMs(12)).toBe(10_000);
    expect(idleBaseMs(40)).toBe(15_000);
  });
});
