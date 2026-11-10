import {describe, expect, it} from 'vitest';

import {seatFilter} from '../src/server/routes/card-detail';

/** Review 5: who a card may name (assign / @mention) follows who can OPEN the board. */
describe('seatFilter', () => {
  it('a personal Inbox admits only its owner', () => {
    const f = seatFilter({visibility: 'private', boardId: 5, inboxOf: 42});
    expect(f.sql).toContain('m.user_id =');
    expect(f.sql).not.toContain("'admin'");
    expect(f.values).toEqual([42]);
  });
  it('a private board admits owners/admins and seated members', () => {
    const f = seatFilter({visibility: 'private', boardId: 5, inboxOf: null});
    expect(f.sql).toContain("'owner', 'admin'");
    expect(f.values).toEqual([5]);
  });
  it('a workspace board adds no filter', () => {
    expect(seatFilter({visibility: 'workspace', boardId: 5, inboxOf: null}).sql.trim()).toBe('');
  });
});

describe('label edits in a read-only workspace', () => {
  it('labelWrite checks the workspace entitlements before an update (static guard; DB behaviour is in the integration suite)', async () => {
    const {readFileSync} = await import('node:fs');
    const src = readFileSync('src/server/routes/card-detail.ts', 'utf8');
    const body = src.slice(src.indexOf('async function labelWrite'), src.indexOf('async function cardLabel'));
    expect(body).toMatch(/getEntitlements[\s\S]*workspace_read_only/);
  });
});
