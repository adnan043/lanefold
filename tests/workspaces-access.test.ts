import {describe, expect, it} from 'vitest';

import {computeEntitlements, SAFETY_CAPS, type PlanLimits} from '../src/server/entitlements';
import {
  isWorkspaceRole,
  rankOf,
  resolveBoardRole,
  ROLE_RANK,
  WORKSPACE_ROLES,
  type WorkspaceRole,
} from '../src/server/workspaces';
import {idOf, intField, invalid, likeEscape, objectOf, textField} from '../src/server/validation';

const FREE: PlanLimits = {plan: 'free', maxMembers: 10, maxFileBytes: 10_000_000, storageQuotaBytes: 1_000_000_000, maxFlows: 0, auditLog: false};
const NOW = new Date('2026-01-10T00:00:00Z');
const ws = (over: Partial<Parameters<typeof computeEntitlements>[0]['workspace']> = {}) => ({
  id: 1, plan: 'free', memberCount: 1, storageUsedBytes: 0, graceUntil: null, ...over,
});

describe('workspace roles', () => {
  it('ranks owner > admin > member > viewer and rejects unknown roles', () => {
    expect(WORKSPACE_ROLES.map(r => ROLE_RANK[r])).toEqual([1, 2, 3, 4]);
    expect(isWorkspaceRole('owner')).toBe(true);
    for (const bad of ['toString', '__proto__', 'Owner', '', null, 3]) expect(isWorkspaceRole(bad)).toBe(false);
    expect(rankOf('constructor')).toBe(0);
    expect(rankOf('admin')).toBe(3);
  });
});

describe('resolveBoardRole', () => {
  it('owners and admins are always board admins, even on private boards', () => {
    for (const r of ['owner', 'admin'] as WorkspaceRole[]) {
      expect(resolveBoardRole(r, 'private', null)).toBe('admin');
      expect(resolveBoardRole(r, 'workspace', 'viewer')).toBe('admin');
    }
  });
  it('hides private boards from members without a seat', () => {
    expect(resolveBoardRole('member', 'private', null)).toBeNull();
    expect(resolveBoardRole('viewer', 'private', null)).toBeNull();
    expect(resolveBoardRole('member', 'private', 'viewer')).toBe('viewer');
  });
  it('falls back to the workspace role on shared boards; an override wins', () => {
    expect(resolveBoardRole('member', 'workspace', null)).toBe('member');
    expect(resolveBoardRole('viewer', 'public', null)).toBe('viewer');
    expect(resolveBoardRole('member', 'workspace', 'viewer')).toBe('viewer');
    expect(resolveBoardRole('member', 'workspace', 'admin')).toBe('admin');
  });
  it('a workspace viewer is ALWAYS a viewer, whatever the board override says', () => {
    for (const vis of ['workspace', 'public', 'private']) {
      expect(resolveBoardRole('viewer', vis, 'admin')).toBe('viewer');
      expect(resolveBoardRole('viewer', vis, 'member')).toBe('viewer');
    }
    expect(resolveBoardRole('viewer', 'private', null)).toBeNull();
  });
});

describe('computeEntitlements', () => {
  it('PAID enforces plan limits and is writable under them', () => {
    const e = computeEntitlements({limits: FREE, workspace: ws({memberCount: 10}), mode: 'PAID', now: NOW});
    expect(e.limits).toEqual({maxMembers: 10, maxFileBytes: 10_000_000, storageQuotaBytes: 1_000_000_000, maxFlows: 0});
    expect([e.overLimit, e.inGrace, e.readOnly, e.upgradeUi]).toEqual([false, false, false, true]);
    expect(e.features).toEqual({auditLog: false, flows: false});
  });
  it('over the member or storage limit: grace until the date, read-only after', () => {
    const members = computeEntitlements({limits: FREE, workspace: ws({memberCount: 11}), mode: 'PAID', now: NOW});
    expect([members.overLimit, members.inGrace, members.readOnly, members.graceUntil]).toEqual([true, true, false, null]);
    const future = new Date('2026-01-20T00:00:00Z');
    const g = computeEntitlements({limits: FREE, workspace: ws({storageUsedBytes: 1_000_000_001, graceUntil: future}), mode: 'PAID', now: NOW});
    expect([g.inGrace, g.readOnly, g.graceUntil]).toEqual([true, false, future.toISOString()]);
    const over = computeEntitlements({limits: FREE, workspace: ws({memberCount: 11, graceUntil: NOW}), mode: 'PAID', now: NOW});
    expect([over.inGrace, over.readOnly]).toEqual([false, true]);
  });
  it('an expired clock does not matter once back under the limits', () => {
    const e = computeEntitlements({limits: FREE, workspace: ws({memberCount: 10, graceUntil: new Date('2020-01-01')}), mode: 'PAID', now: NOW});
    expect([e.overLimit, e.readOnly, e.graceUntil]).toEqual([false, false, null]);
  });
  it('FREE_FOR_ALL uses only the safety caps, unlocks features, never read-only', () => {
    const e = computeEntitlements({limits: FREE, workspace: ws({memberCount: 400, graceUntil: new Date('2020-01-01')}), mode: 'FREE_FOR_ALL', now: NOW});
    expect(e.limits).toEqual({...SAFETY_CAPS});
    expect([e.overLimit, e.readOnly, e.upgradeUi]).toEqual([false, false, false]);
    expect(e.features).toEqual({auditLog: true, flows: true});
  });
  it('a missing plan row falls back to the strictest plan', () => {
    const e = computeEntitlements({limits: null, workspace: ws({plan: 'gone', memberCount: 11}), mode: 'PAID', now: NOW});
    expect(e.limits.maxMembers).toBe(10);
    expect(e.limits.maxFileBytes).toBe(10 * 1024 * 1024);
    expect(e.plan).toBe('gone');
    expect(e.overLimit).toBe(true);
  });
  it('flows and audit log follow the plan', () => {
    const e = computeEntitlements({limits: {...FREE, maxFlows: 5, auditLog: true}, workspace: ws(), mode: 'PAID'});
    expect(e.features).toEqual({auditLog: true, flows: true});
  });
});

describe('validation helpers', () => {
  it('idOf accepts only positive 32-bit ids', () => {
    expect(idOf('42')).toBe(42);
    for (const bad of ['0', '-1', '1.5', '01x', '', '2147483648', '99999999999', undefined, 5]) expect(idOf(bad)).toBeUndefined();
    expect(idOf('2147483647')).toBe(2147483647);
  });
  it('objectOf rejects arrays and scalars', () => {
    expect(objectOf({a: 1})).toEqual({a: 1});
    for (const bad of [[], 'x', null, undefined, 3]) expect(objectOf(bad)).toBeNull();
  });
  it('textField trims and enforces bounds', () => {
    expect(textField('  hi  ', 1, 5)).toEqual({ok: true, value: 'hi'});
    expect(textField('   ', 1, 5)).toMatchObject({ok: false, error: {code: 'required'}});
    expect(textField('abcdef', 1, 5)).toMatchObject({ok: false, error: {code: 'too_long'}});
    expect(textField(5, 1, 5)).toMatchObject({ok: false, error: {code: 'required'}});
    expect(textField('', 0, 5)).toEqual({ok: true, value: ''});
  });
  it('intField takes JSON integers only', () => {
    expect(intField(3, 1, 5)).toEqual({ok: true, value: 3});
    for (const bad of ['3', 1.5, NaN, Infinity, 0, 6, null]) expect(intField(bad, 1, 5)).toMatchObject({ok: false, error: {code: 'out_of_range'}});
  });
  it('likeEscape makes wildcards literal', () => {
    expect(likeEscape('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
  it('invalid() answers 422 with fields and codes, even when given nothing', async () => {
    const c = {json: (body: unknown, status: number) => ({body, status})} as never;
    const res = invalid(c, {name: {code: 'required', message: 'Enter a name.'}}) as unknown as {body: Record<string, unknown>; status: number};
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({error: 'invalid_input', fields: {name: 'Enter a name.'}, fieldCodes: {name: 'required'}});
    expect(() => invalid(c, {})).not.toThrow();
  });
});
