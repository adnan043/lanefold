/**
 * Pure rules of the bulk bar's Undo, the `x` key and dragging ticked cards (unit tested; no React here).
 *
 * The SERVER builds the Undo: its answer to a bulk action carries `undo`, the exact inverse requests, each guarded by
 * `ifUnchangedSince` so a card somebody wrote since is skipped. The client only replays them, one after the other.
 */

/** One inverse request: the body of `POST /boards/:id/cards/bulk` (the server made it; the client never edits it). */
export type BulkUndoStep = {action: string; cardIds: number[]; ifUnchangedSince: string} & Record<string, unknown>;

/** What a bulk request answers. */
export type BulkAnswer = {changed: number; skipped?: number; undo?: BulkUndoStep[]};

export type UndoResult = {changed: number; skipped: number; failed: unknown | null};

/**
 * Replay the inverse steps in order. NOT atomic across steps (each step is): the first failure stops the rest and is
 * returned with what had already been taken back, so the screen can say both.
 */
export async function runUndoSteps(steps: readonly BulkUndoStep[], send: (step: BulkUndoStep) => Promise<BulkAnswer>): Promise<UndoResult> {
  const result: UndoResult = {changed: 0, skipped: 0, failed: null};
  for (const step of steps) {
    try {
      const answer = await send(step);
      result.changed += answer.changed;
      result.skipped += answer.skipped ?? 0;
    } catch (error) {
      result.failed = error;
      break;
    }
  }
  return result;
}

/**
 * Dropping a card on a lane while cards are ticked: when the dragged card is one of SEVERAL ticked cards, all of them
 * go (to the end of the lane, the bulk move's rule); otherwise null and the drop is the usual single-card move with
 * its exact place.
 */
export function groupDrop(selection: {mode: boolean; ids: ReadonlySet<number>}, draggedId: number): number[] | null {
  if (!selection.mode || selection.ids.size < 2 || !selection.ids.has(draggedId)) return null;
  return [...selection.ids];
}

/** The slice of a key event the `x` rule reads (a real KeyboardEvent fits). */
export type KeyLike = {key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean; defaultPrevented: boolean};
/** The slice of the focused element it reads (a real Element fits). */
export type TargetLike = {tagName?: string; isContentEditable?: boolean; type?: string; closest?: (selector: string) => {getAttribute: (name: string) => string | null} | null};

/**
 * `x` on a focused card ticks or unticks it. Returns the card id, or null when the key must be left alone: a modifier
 * held, a repeat, typing in a text field (a checkbox is not typing: the tick is the first thing a card focuses),
 * focus not inside a card, or a card still being saved (negative id).
 */
export function selectKeyCardId(event: KeyLike, target: TargetLike | null, letter: string): number | null {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (letter !== 'x' || !target) return null;
  const tag = target.tagName ?? '';
  const checkbox = tag === 'INPUT' && (target.type === 'checkbox' || target.type === 'radio');
  if (target.isContentEditable || (!checkbox && ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag))) return null;
  const raw = target.closest?.('li[data-card-id]')?.getAttribute('data-card-id');
  const id = raw == null ? NaN : Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
