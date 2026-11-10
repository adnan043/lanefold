import {describe, expect, it} from 'vitest';

import {evenKeys, keyOrNull, MAX_KEY_LENGTH} from '../src/lib/position-key';

describe('evenKeys', () => {
  it('returns strictly increasing short keys', () => {
    for (const n of [0, 1, 2, 50, 500]) {
      const keys = evenKeys(n);
      expect(keys).toHaveLength(n);
      for (let i = 1; i < n; i++) expect(keys[i - 1] < keys[i]).toBe(true);
      for (const k of keys) expect(k.length).toBeLessThan(10);
    }
  });

  it('leaves room between neighbours so keyOrNull succeeds after a renumber', () => {
    const keys = evenKeys(500);
    expect(keyOrNull(keys[10], keys[11])).not.toBeNull();
    expect(keyOrNull(null, keys[0])).not.toBeNull();
    expect(keyOrNull(keys[499], null)).not.toBeNull();
  });

  it('is needed when a gap is exhausted', () => {
    const a = 'a0' + 'V'.repeat(MAX_KEY_LENGTH);
    expect(keyOrNull(a, a + 'V')).toBeNull();
  });
});
