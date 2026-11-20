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
    expect(seatFilter({visibility: 'workspace', boardId: 5, inboxOf: null, guest: false}).sql.trim()).toBe('');
  });
  it('a GUEST caller on a workspace board reaches only seated people and owners/admins (no workspace-wide name probe)', () => {
    const f = seatFilter({visibility: 'workspace', boardId: 5, inboxOf: null, guest: true});
    expect(f.sql).toContain("'owner', 'admin'");
    expect(f.sql).toContain('board_members');
    expect(f.values).toEqual([5]);
  });
  it('the card assign/mention check and bulk assign pass the caller’s guest flag', async () => {
    const {readFileSync} = await import('node:fs');
    expect(readFileSync('src/server/routes/card-detail.ts', 'utf8')).toMatch(/const seats = \(ctx: Ctx\) => seatFilter\(\{[^}]*guest: ctx\.access\.guest\}\)/);
    expect(readFileSync('src/server/routes/card-bulk.ts', 'utf8')).toMatch(/seatFilter\(\{[^}]*guest: access\.guest\}\)/);
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
