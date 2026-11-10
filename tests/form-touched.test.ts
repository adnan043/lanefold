import {describe, expect, it} from 'vitest';
import {blurCounts} from '../src/lib/form';

describe('blurCounts', () => {
  it('ignores a blur before any interaction', () => expect(blurCounts(false, false)).toBe(false));
  it('counts a blur after interaction', () => expect(blurCounts(true, false)).toBe(true));
  it('counts a blur after submit', () => expect(blurCounts(false, true)).toBe(true));
});
