/**
 * The card's quick-actions menu (the pencil on a board card) opens the card with one part of it ready: the labels or
 * members picker, the due date, the attachments (cover). The card sets the action, then opens the card; the card panel
 * runs it once the card has loaded. One pending action at most, for one card; a stale one is dropped.
 */
export type QuickTarget = 'labels' | 'members' | 'dates' | 'cover';

type Pending = {cardId: number; target: QuickTarget; at: number};
let pending: Pending | null = null;

export function setQuickAction(cardId: number, target: QuickTarget): void {
  pending = {cardId, target, at: Date.now()};
}

/** The action waiting for this card (not cleared: React may run an effect twice). Older than 10 s: ignored. */
export function peekQuickAction(cardId: number): QuickTarget | null {
  const p = pending;
  if (!p || p.cardId !== cardId || Date.now() - p.at > 10_000) return null;
  return p.target;
}

/** Done: the action ran (or the card opened without one). */
export function clearQuickAction(): void {
  pending = null;
}

/** The control in the card panel each action presses (or, for the cover, scrolls to). */
export const QUICK_TARGET_SELECTOR: Record<QuickTarget, {selector: string; press: boolean}> = {
  labels: {selector: '#cd-labels-add', press: true},
  members: {selector: '#cd-members-add', press: true},
  dates: {selector: '#cd-dueDate', press: true},
  cover: {selector: '#cd-attachments', press: false},
};
