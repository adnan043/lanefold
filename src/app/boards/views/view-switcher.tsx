import {useCallback, useEffect, useState} from 'react';

import {useT} from '../../../i18n';
import {Icon, type IconName} from '../../../portal/ui';
import {type BoardView, isBoardView, viewStorageKey} from './view-logic';

export const VIEW_ICONS: Record<BoardView, IconName> = {board: 'layout-kanban', calendar: 'calendar', dashboard: 'trending-up', workload: 'users'};

/** Shown in the board toolbar; the others (dashboard, workload) live in the app sidebar (shell.tsx). */
export const TOOLBAR_VIEWS: BoardView[] = ['board', 'calendar'];
export const SIDEBAR_VIEWS: BoardView[] = ['dashboard', 'workload'];

// The toolbar and the sidebar each hold the view; a choice in one tells the other through this window event.
const VIEW_EVENT = 'lanefold:board-view';

/** The chosen view, remembered per board per user in localStorage (the board is the default; storage can be blocked). */
export function useBoardView(userId: number | null, boardId: number): [BoardView, (view: BoardView) => void] {
  const key = viewStorageKey(userId, boardId);
  const read = (): BoardView => {
    try {
      const value = window.localStorage.getItem(key);
      return isBoardView(value) ? value : 'board';
    } catch {
      return 'board';
    }
  };
  const [view, setView] = useState<BoardView>(read);
  useEffect(() => setView(read()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{key: string; view: BoardView}>).detail;
      if (detail?.key === key) setView(detail.view);
    };
    window.addEventListener(VIEW_EVENT, onChange);
    return () => window.removeEventListener(VIEW_EVENT, onChange);
  }, [key]);
  const choose = useCallback(
    (next: BoardView) => {
      setView(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        /* private mode: the choice lasts until the page closes */
      }
      window.dispatchEvent(new CustomEvent(VIEW_EVENT, {detail: {key, view: next}}));
    },
    [key]
  );
  return [view, choose];
}

export function ViewSwitcher({view, onChange}: {view: BoardView; onChange: (view: BoardView) => void}) {
  const t = useT();
  return (
    <div className="lf-view-switch" role="group" aria-label={t('views.switcher')}>
      {TOOLBAR_VIEWS.map(v => (
        <button key={v} type="button" className="lf-view-btn" aria-pressed={view === v} onClick={() => onChange(v)}>
          <Icon name={VIEW_ICONS[v]} size={16} />
          <span className="lf-head-label">{t(`views.${v}` as 'views.board')}</span>
        </button>
      ))}
    </div>
  );
}
