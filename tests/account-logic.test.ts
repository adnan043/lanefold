import {describe, expect, it} from 'vitest';

import {blockerAction, hasMoreMembers, isCapped} from '../src/app/settings/account-logic';

describe('account deletion preflight rules', () => {
  it('restores an archived workspace first, whatever the reason', () => {
    for (const reason of ['last_workspace_owner', 'paid_workspace', 'workspace_needs_action'] as const) {
      expect(blockerAction({reason, archived: true})).toBe('restore');
    }
  });
  it('maps each reason to its fix', () => {
    expect(blockerAction({reason: 'last_workspace_owner', archived: false})).toBe('handover');
    expect(blockerAction({reason: 'paid_workspace', archived: false})).toBe('plan');
    expect(blockerAction({reason: 'workspace_needs_action', archived: false})).toBe('empty');
  });
  it('detects a capped count and extra members', () => {
    expect(isCapped(1000, 1000)).toBe(true);
    expect(isCapped(999, 1000)).toBe(false);
    expect(hasMoreMembers(6, 5)).toBe(true);
    expect(hasMoreMembers(3, 3)).toBe(false);
  });
});
