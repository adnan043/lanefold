import {describe, expect, it} from 'vitest';

import {pulseRows} from '../src/server/routes/chat';

/** The visibility and order rules run in real Postgres (tests/integration/pulse.test.ts); here: one round trip, shape, bounds. */
describe('chat pulse query', () => {
  it('is ONE tagged query, newest activity first, bounded, with the board rule inside', async () => {
    const calls: {sql: string; values: unknown[]}[] = [];
    const db: any = {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push({sql: strings.join('?'), values});
        return [{id: 4, workspace_id: 2, last_seq: 9n, last_read_seq: 3n, muted_at: null}];
      },
    };
    const rows = await pulseRows(db, 7);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/ORDER BY cv\.updated_at DESC, cv\.id DESC\s+LIMIT \?/);
    expect(calls[0]!.sql).toMatch(/b\.inbox_of IS NOT NULL/);
    expect(calls[0]!.sql).toMatch(/b\.visibility = 'private'/);
    expect(calls[0]!.sql).toMatch(/archived_at IS NULL/);
    expect(calls[0]!.values).toEqual([7, 7, 7, 200]);
    expect(rows).toEqual([{lastReadSeq: 3n, mutedAt: null, conversation: {id: 4, workspaceId: 2, lastSeq: 9n}}]);
  });

  it('honours a smaller cap', async () => {
    let seen: unknown[] = [];
    const db: any = {$queryRaw: async (_s: TemplateStringsArray, ...v: unknown[]) => ((seen = v), [])};
    expect(await pulseRows(db, 7, 3)).toEqual([]);
    expect(seen.at(-1)).toBe(3);
  });
});
