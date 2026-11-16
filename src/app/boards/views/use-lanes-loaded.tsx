import {useEffect, useRef} from 'react';

import {useT} from '../../../i18n';
import {Button, Notice} from '../../../portal/ui';
import type {LaneT} from '../../api';
import type {BoardActions} from '../actions';

/**
 * The Table and Calendar show every lane's cards, but never fetch unbounded: a lane the board answer left empty
 * (the card cap) loads its FIRST page once when the view opens; later pages come only from "Load more", which asks
 * each lane for its next page (the same keyset route the board's lanes use).
 */
/** Lane requests in flight at once: a 50-lane board never sends 40 requests (and re-renders 40 times) together. */
const AT_ONCE = 4;

/** `load` for each id, at most AT_ONCE at a time (`loadLane` never throws: a failure marks the lane). */
export async function loadLimited(ids: readonly number[], load: (id: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < ids.length) await load(ids[next++]!);
  };
  await Promise.all(Array.from({length: Math.min(AT_ONCE, ids.length)}, worker));
}

export function useFirstPages(lanes: LaneT[], actions: BoardActions) {
  const asked = useRef(new Set<number>());
  const {loadLane} = actions;
  useEffect(() => {
    const wanted = lanes.filter(lane => !lane.loaded && !asked.current.has(lane.id)).map(lane => lane.id);
    if (wanted.length === 0) return;
    for (const id of wanted) asked.current.add(id);
    void loadLimited(wanted, loadLane);
  }, [lanes, loadLane]);
}

export function LoadMoreBar({lanes, actions}: {lanes: LaneT[]; actions: BoardActions}) {
  const t = useT();
  const pending = lanes.filter(l => l.loaded && l.hasMore);
  const failed = lanes.filter(l => actions.failedLanes.has(l.id));
  const loading = lanes.some(l => !l.loaded) && failed.length === 0;
  const shown = lanes.reduce((n, l) => n + l.cards.length, 0);
  const total = lanes.reduce((n, l) => n + l.cardCount, 0);
  if (!pending.length && !failed.length && !loading) return null;
  return (
    <div className="lf-vw-more">
      {failed.length > 0 && (
        <Notice tone="warning" action={<Button size="sm" variant="secondary" onClick={() => void loadLimited(failed.map(l => l.id), actions.loadLane)}>{t('common.retry')}</Button>}>
          {t('views.loadFailed')}
        </Notice>
      )}
      {loading && <p className="lf-vw-note" role="status">{t('views.loadingCards')}</p>}
      {pending.length > 0 && (
        <>
          <p className="lf-vw-note">{t('views.partial', {shown, total})}</p>
          <Button variant="secondary" onClick={() => void loadLimited(pending.map(l => l.id), actions.loadLane)}>
            {t('views.loadMore')}
          </Button>
        </>
      )}
    </div>
  );
}
