import {useCallback} from 'react';

import {useI18n} from '../../i18n';
import {useToast} from '../../portal/ui';
import type {BoardActions, BulkAction, Undoable} from './actions';
import type {BulkUndoStep} from './bulk-run';
import type {Selection} from './selection';

/**
 * Run ONE bulk action on `ids` and say what happened: the ticks clear, and the board's "Undo" bar offers to take it
 * back when the server sent an inverse (a toast when there is nothing to undo). Rejects when the action fails, so the
 * caller shows the reason where the person is looking (the bar's line, a toast after a drop).
 */
export function useBulkRunner(actions: BoardActions, selection: Selection | null, onUndoable: (label: string, undo: Undoable) => void) {
  const {t, errorMessage} = useI18n();
  const toast = useToast();
  const {bulkCards, undoBulk} = actions;

  const undo = useCallback(
    async (steps: readonly BulkUndoStep[]) => {
      const result = await undoBulk(steps);
      if (result.failed) toast.danger(errorMessage(result.failed));
      else if (result.skipped > 0) toast.info(t('bulk.undoneSome', {count: result.changed, skipped: result.skipped}));
      else toast.success(t('bulk.undone', {count: result.changed}));
    },
    [undoBulk, toast, t, errorMessage]
  );

  return useCallback(
    async (ids: number[], action: BulkAction): Promise<number> => {
      const answer = await bulkCards(ids, action);
      selection?.clear();
      const label = t('bulk.updated', {count: answer.changed});
      const steps = answer.undo;
      if (steps?.length && answer.changed > 0) onUndoable(label, {token: {}, run: () => void undo(steps)});
      else toast.success(label);
      return answer.changed;
    },
    [bulkCards, selection, t, onUndoable, undo, toast]
  );
}
