import {useEffect, useRef} from 'react';

import {useMe} from '../portal/shared';

import {browserStorage, clearDraft, type DraftKind, draftKey, loadDraft, pruneDrafts, restoreDraft, saveDraft} from './draft-store';
import {useWorkspace} from './workspace';

let pruned = false;

/** Whether this field has a kept draft (to reopen an editor after sign-in returns). */
export function usePeekDraft(kind: DraftKind, id: number): boolean {
  const workspaceId = useWorkspace().current?.id;
  const userId = useMe().data?.viewer.id;
  if (!workspaceId || !userId) return false;
  return loadDraft(browserStorage(), draftKey(workspaceId, kind, id, userId)) !== null;
}

/**
 * Keeps the text of one field across a forced sign-in. Only the typed text, in sessionStorage, keyed by workspace + object.
 * `enabled` = the field is on screen. Returns `clear`: call it on a successful save and on cancel.
 */
export function useDraft(kind: DraftKind, id: number, value: string, setValue: (text: string) => void, baseline = '', enabled = true): () => void {
  const workspaceId = useWorkspace().current?.id;
  const userId = useMe().data?.viewer.id;
  const key = workspaceId && userId ? draftKey(workspaceId, kind, id, userId) : null;
  const latest = useRef({value, baseline, setValue});
  latest.current = {value, baseline, setValue};
  // Restore once each time the field appears, before the save effect below can touch the stored text.
  useEffect(() => {
    if (!enabled || !key) return;
    if (!pruned) {
      pruned = true;
      pruneDrafts(browserStorage());
    }
    const text = restoreDraft(latest.current.value, latest.current.baseline, loadDraft(browserStorage(), key));
    if (text !== null) latest.current.setValue(text);
  }, [enabled, key]);
  useEffect(() => {
    if (!enabled || !key) return;
    if (value === baseline) clearDraft(browserStorage(), key);
    else saveDraft(browserStorage(), key, value);
  }, [enabled, key, value, baseline]);
  return () => {
    if (key) clearDraft(browserStorage(), key);
  };
}
