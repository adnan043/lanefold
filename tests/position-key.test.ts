import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {evenKeys, keyOrNull, MAX_KEY_LENGTH} from '../src/lib/position-key';

describe('position-key', () => {
  it('keyOrNull sorts strictly between neighbours', () => {
    const k = keyOrNull('a0', 'a1')!;
    expect(k > 'a0' && k < 'a1').toBe(true);
    expect(keyOrNull(null, null)).toBeTruthy();
  });
  it('keyOrNull refuses equal, reversed and invalid neighbours', () => {
    expect(keyOrNull('a0', 'a0')).toBeNull();
    expect(keyOrNull('a1', 'a0')).toBeNull();
    expect(keyOrNull('!!', null)).toBeNull();
  });
  it('keyOrNull refuses a key longer than the cap', () => {
    let hi = 'a1';
    let key: string | null = 'a0';
    for (let i = 0; i < 400 && key !== null; i++) {
      hi = key;
      key = keyOrNull('a0', hi);
    }
    expect(key).toBeNull();
    expect(hi.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
  });
  it('evenKeys are strictly increasing, unique and short for a full lane', () => {
    expect(evenKeys(0)).toEqual([]);
    for (const n of [1, 51, 501]) {
      const keys = evenKeys(n);
      expect(keys).toHaveLength(n);
      for (let i = 1; i < n; i++) expect(keys[i] > keys[i - 1]).toBe(true);
      expect(Math.max(...keys.map(k => k.length))).toBeLessThan(MAX_KEY_LENGTH);
    }
  });
  it('rebalance statements stay scoped to workspace, board and list', () => {
    const src = readFileSync('src/server/routes/boards.ts', 'utf8');
    expect(src).toMatch(/cards\.workspace_id = \$\{workspaceId\}::int AND cards\.board_id = \$\{boardId\}::int AND cards\.lane_id/);
    expect(src).toMatch(/lanes\.workspace_id = \$\{workspaceId\}::int AND lanes\.board_id = \$\{boardId\}::int/);
    expect(src).not.toMatch(/\$(queryRaw|executeRaw)Unsafe/);
  });
});
