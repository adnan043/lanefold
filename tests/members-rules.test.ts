import {describe, expect, it} from 'vitest';

import {recipientsOf} from '../src/server/notifications';
import {canGrant, canManageMember, maskEmail, tokenKind} from '../src/server/routes/members';

describe('member rules', () => {
  it('owners are never managed by others; admins manage only members and viewers', () => {
    expect(canManageMember('owner', 'owner')).toBe(false);
    expect(canManageMember('admin', 'owner')).toBe(false);
    expect(canManageMember('admin', 'admin')).toBe(false);
    expect(canManageMember('admin', 'member')).toBe(true);
    expect(canManageMember('owner', 'admin')).toBe(true);
    expect(canManageMember('member', 'viewer')).toBe(false);
    expect(canManageMember('viewer', 'viewer')).toBe(false);
  });

  it('nobody grants owner or more than they hold', () => {
    expect(canGrant('owner', 'owner')).toBe(false);
    expect(canGrant('owner', 'admin')).toBe(true);
    expect(canGrant('admin', 'admin')).toBe(true);
    expect(canGrant('admin', 'owner')).toBe(false);
    expect(canGrant('member', 'admin')).toBe(false);
  });

  it('masks emails and never returns the full address', () => {
    expect(maskEmail('maria@gmail.com')).toBe('m•••@•••.com');
    expect(maskEmail('maria@gmail.com')).not.toContain('gmail');
    expect(maskEmail('nonsense')).toBe('•••');
    expect(maskEmail('maria@gmail.com')).not.toContain('maria');
  });

  it('masks the whole local part of a short address', () => {
    for (const email of ['a@x.com', 'ab@x.com', 'abc@x.com']) {
      const masked = maskEmail(email);
      expect(masked).toBe('•••@•••.com');
      expect(masked).not.toMatch(/[abc]•|^[abc]/);
    }
    expect(maskEmail('abcd@x.com')).toBe('a•••@•••.com');
  });

  it('tells join links from invites by shape and rejects anything else', () => {
    const body = 'A'.repeat(43);
    expect(tokenKind(`lj_${body}`)).toBe('join');
    expect(tokenKind(`iv_${body}`)).toBe('invite');
    for (const bad of ['', 'lj_short', `xx_${body}`, `lj_${body}A`, `lj_${body.slice(1)}!`, `${body}`]) expect(tokenKind(bad)).toBeNull();
  });
});

describe('notification recipients', () => {
  it('drops the actor, duplicates and invalid ids, and is bounded', () => {
    expect(recipientsOf([1, 2, 2, 3, 0, -4, 1.5, NaN], 2)).toEqual([1, 3]);
    expect(recipientsOf([], null)).toEqual([]);
    expect(recipientsOf(Array.from({length: 500}, (_, i) => i + 1), null)).toHaveLength(100);
  });
});

import {underCap, NOTIFICATIONS_PER_ACTOR_HOUR, NOTIFICATIONS_PER_HOUR} from '../src/server/notifications';
describe('notification hourly caps', () => {
  it('drops only recipients at the per-actor cap', () => {
    const recent = new Map([
      [1, {total: NOTIFICATIONS_PER_ACTOR_HOUR, byActor: NOTIFICATIONS_PER_ACTOR_HOUR}],
      [2, {total: NOTIFICATIONS_PER_ACTOR_HOUR - 1, byActor: NOTIFICATIONS_PER_ACTOR_HOUR - 1}],
    ]);
    expect(underCap([1, 2, 3], recent)).toEqual([2, 3]);
  });
  it('one actor at the cap does not block others, but the overall cap still does', () => {
    const recent = new Map([
      [1, {total: NOTIFICATIONS_PER_ACTOR_HOUR, byActor: 0}], // spammed by someone else: this actor still gets through
      [2, {total: NOTIFICATIONS_PER_HOUR, byActor: 0}],
    ]);
    expect(underCap([1, 2], recent)).toEqual([1]);
  });
});
