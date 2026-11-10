import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useRef, useState} from 'react';

import {useT} from '../../i18n';
import {Icon} from '../../portal/ui';
import {call} from '../api';
import {lazyWithRetry} from '../lazy';
import './bell.css';

const panelWidget = lazyWithRetry(() => import('./panel').then(m => m.default));
const NotificationPanel = panelWidget.Component;
const loadPanel = panelWidget.preload;

export type NotificationT = {
  id: string;
  workspaceId: number;
  kind: string;
  actor: {id: number; name: string | null} | null;
  boardId: number | null;
  cardId: number | null;
  conversationId: number | null;
  read: boolean;
  createdAt: string;
  /** Morning digest rows only: the counts behind the line (no titles, no names). */
  digest?: {due: number; overdue: number; mentions: number} | null;
};

const countQuery = {
  queryKey: ['notifications', 'count'],
  queryFn: () => call<{count: number; more: boolean}>('GET', '/notifications/unread-count'),
  // Every 30 s while the tab is visible (TanStack pauses hidden tabs); focus refetches.
  refetchInterval: 30_000,
  refetchOnWindowFocus: true,
  staleTime: 10_000,
} as const;

/** The bell in the top bar: an unread count (polled every 30 s) and a list in a popover with mark read / mark all read. */
export function NotificationBell() {
  const t = useT();
  const queryClient = useQueryClient();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const mounted = useRef(false);
  if (open) mounted.current = true;
  const count = useQuery(countQuery);
  const unread = count.data?.count ?? 0;
  const label = unread > 0 ? t('notif.bellUnread', {n: count.data?.more ? `${unread}+` : unread}) : t('notif.bell');


  return (
    <>
      <button
        ref={button}
        type="button"
        className="button button-ghost icon-button notif-bell"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerEnter={() => void loadPanel()}
        onFocus={() => void loadPanel()}
        onClick={() => {
          setOpen(value => !value);
          if (!open) void queryClient.invalidateQueries({queryKey: ['notifications']});
        }}>
        <Icon name="bell" size={18} />
        {unread > 0 && (
          <span className="notif-count" aria-hidden="true">
            {count.data?.more ? '99+' : unread}
          </span>
        )}
      </button>
      {mounted.current && (
        <NotificationPanel open={open} setOpen={setOpen} anchor={button} unread={unread} onLoadError={() => setOpen(false)} />
      )}
    </>
  );
}
