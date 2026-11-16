import {describe, expect, it} from 'vitest';

import type {PrismaClient} from '../src/generated/prisma/client';
import {accessSelect, resolveAccess, workspaceReadOnly, type AccessRow} from '../src/server/board-access-via';
import {boardAccess} from '../src/server/workspaces';

/**
 * board-access-via.ts re-reads board access in the same query as a card or lane: its resolution must be EXACTLY
 * boardAccess()'s. Both run here on the same rows, over every role, seat, visibility and Inbox combination.
 */

const ME = 7;
const OTHER = 8;

function row(over: Partial<AccessRow> & {wsRole?: string | null; seat?: string | null}): AccessRow {
  const {wsRole = 'member', seat = null, ...rest} = over;
  return {
    workspaceId: 3,
    visibility: 'workspace',
    inboxOf: null,
    archivedAt: null,
    rev: 12n,
    name: 'Roadmap',
    bgKind: 'color',
    bgColor1: '#112233',
    bgColor2: '#445566',
    bgAngle: 135,
    bgPattern: 'none',
    bgFileId: null,
    memberInvites: 'admins',
    selfJoin: false,
    boardMembers: seat ? [{role: seat}] : [],
    workspace: {graceUntil: null, members: wsRole ? [{role: wsRole}] : []},
    ...rest,
  };
}

/** A client whose board.findFirst answers `r` (boardAccess() reads exactly one board row). */
const fakeDb = (r: AccessRow | null) => ({board: {findFirst: async () => r}}) as unknown as PrismaClient;

describe('resolveAccess matches boardAccess', () => {
  const wsRoles = [null, 'viewer', 'member', 'admin', 'owner', 'bogus'];
  const seats = [null, 'viewer', 'member', 'admin', 'bogus'];
  const visibilities = ['private', 'workspace', 'public'];
  const inboxes = [null, ME, OTHER];
  const cases: AccessRow[] = [];
  for (const wsRole of wsRoles)
    for (const seat of seats)
      for (const visibility of visibilities)
        for (const inboxOf of inboxes)
          for (const archivedAt of [null, new Date(0)]) cases.push(row({wsRole, seat, visibility, inboxOf, archivedAt}));

  it(`gives the same answer on all ${cases.length} combinations`, async () => {
    for (const r of cases) {
      const expected = await boardAccess(fakeDb(r), 1, ME);
      expect(resolveAccess(r, ME), JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toEqual(expected);
    }
  });

  it('selects every column boardAccess() resolves from, plus the grace clock', () => {
    const select = accessSelect(ME);
    for (const key of Object.keys(row({}))) expect(select).toHaveProperty(key);
    expect(select.workspace.select).toHaveProperty('graceUntil', true);
    expect(select.boardMembers.where).toEqual({userId: ME});
    expect(select.workspace.select.members.where).toEqual({userId: ME});
  });
});

describe('workspaceReadOnly', () => {
  it('skips the entitlements read while a grace clock is still running', async () => {
    const db = {$queryRaw: () => Promise.reject(new Error('must not read'))} as unknown as PrismaClient;
    expect(await workspaceReadOnly(db, 3, new Date(Date.now() + 60_000))).toBe(false);
  });
});
