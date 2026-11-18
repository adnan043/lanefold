import {useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useRef, useState} from 'react';

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

/** No pointer, key, wheel or touch input for this long: the person is away, and the bell polls less often. */
export const BELL_IDLE_MS = 2 * 60_000;
const ACTIVE_MS = 30_000;
const MAX_MS = 5 * 60_000;

/**
 * How long the bell waits before its next count read: 30 s while the person is active, then twice as long for every
 * further stretch of idleness (1, 2, 4… minutes) up to 5 minutes; a failed read waits at least a minute. A hidden tab
 * does not poll at all (TanStack's default), and focus or the first input after being away reads at once.
 */
export function bellInterval(idleMs: number, failed: boolean): number {
  const steps = idleMs < BELL_IDLE_MS ? 0 : 1 + Math.floor(Math.log2(idleMs / BELL_IDLE_MS));
  const wait = Math.min(MAX_MS, ACTIVE_MS * 2 ** Math.min(steps, 4));
  return failed ? Math.max(wait, 60_000) : wait;
}

let lastInput = Date.now();
const INPUTS = ['pointerdown', 'keydown', 'pointermove', 'wheel', 'touchstart'] as const;

const countQuery = {
  queryKey: ['notifications', 'count'],
  queryFn: () => call<{count: number; more: boolean}>('GET', '/notifications/unread-count'),
  refetchInterval: (query: {state: {status: string; fetchFailureCount: number}}) =>
    bellInterval(Date.now() - lastInput, query.state.status === 'error' && query.state.fetchFailureCount > 0),
  refetchOnWindowFocus: true,
  staleTime: 10_000,
} as const;

/** The bell in the top bar: an unread count (polled, see bellInterval) and a list in a popover with mark read / mark all read. */
export function NotificationBell() {
  const t = useT();
  const queryClient = useQueryClient();
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const mounted = useRef(false);
  if (open) mounted.current = true;
  const count = useQuery(countQuery);
  // Track input; the first input after being away reads the count at once instead of waiting out a long interval.
  useEffect(() => {
    const onInput = () => {
      const away = Date.now() - lastInput >= BELL_IDLE_MS;
      lastInput = Date.now();
      if (away) void queryClient.invalidateQueries({queryKey: countQuery.queryKey});
    };
    for (const name of INPUTS) window.addEventListener(name, onInput, {passive: true});
    return () => {
      for (const name of INPUTS) window.removeEventListener(name, onInput);
    };
  }, [queryClient]);
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
          if (!open) {
            // Opening the list: the red count goes at once (all seen); the list keeps each unread one marked until read.
            // The list and count are re-read after the server has the "seen" mark, so the old count never comes back.
            queryClient.setQueryData(countQuery.queryKey, {count: 0, more: false});
            void call('POST', '/notifications/seen')
              .catch(() => undefined)
              .finally(() => void queryClient.invalidateQueries({queryKey: ['notifications']}));
          }
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
