/** Pure rules of the account-deletion preflight screen (`account.tsx`). */
export type BlockerReason = 'last_workspace_owner' | 'paid_workspace' | 'workspace_needs_action';
export type BlockerAction = 'restore' | 'handover' | 'plan' | 'empty';

/** The one fix to offer: an archived workspace must be restored first; else by reason. */
export function blockerAction(b: {reason: BlockerReason; archived: boolean}): BlockerAction {
  if (b.archived) return 'restore';
  if (b.reason === 'last_workspace_owner') return 'handover';
  if (b.reason === 'paid_workspace') return 'plan';
  return 'empty';
}

/** True when a capped server count hit its cap, so the screen shows "1,000+". */
export const isCapped = (n: number, cap: number) => n >= cap;

/** Other members beyond the named candidates: the screen links to Members for them. */
export const hasMoreMembers = (otherMembers: number, candidates: number) => otherMembers > candidates;
