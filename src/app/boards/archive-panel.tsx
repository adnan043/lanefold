import {useInfiniteQuery, useMutation, useQueryClient} from '@tanstack/react-query';
import {useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {Button, Drawer, EmptyState, ErrorNote, LoadingBlock, useToast} from '../../portal/ui';
import {call} from '../api';
import {useWriteCooldown} from '../write-cooldown';
import {backgroundStyle} from './background';
import './settings.css';

type ArchivedCard = {id: number; title: string; laneName: string; laneArchived: boolean; archivedAt: string | null};
type CardsPage = {items: ArchivedCard[]; canRestore: boolean; nextBefore: number | null};
export type ArchivedBoard = {id: number; name: string; visibility: string; bgKind: string; bgColor1: string; bgColor2: string; bgAngle: number; archivedAt: string | null; canRestore: boolean};
type ArchivedLane = {id: number; name: string; cardCount: number; archivedAt: string | null};
type LanesPage = {items: ArchivedLane[]; canRestore: boolean; nextBefore: number | null};
type BoardsPage = {items: ArchivedBoard[]; nextBefore: number | null};

/** The board's archived cards, with Restore. Loads only when opened (keyset pages of 30). */
function ArchivedCards({boardId, open}: {boardId: number; open: boolean}) {
  const t = useT();
  const {errorMessage, formatRelative} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<number | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['archived-cards', boardId],
    queryFn: ({pageParam}) => call<CardsPage>('GET', `/boards/${boardId}/archived-cards?before=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last: CardsPage) => last.nextBefore ?? undefined,
    enabled: open,
    gcTime: 0,
  });
  const cooldown = useWriteCooldown();
  const restore = useMutation({
    mutationFn: (id: number) => call('POST', `/cards/${id}/restore`),
    onMutate: id => setBusyId(id),
    onSuccess: async () => {
      toast.success(t('bx.archive.restored'));
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ['archived-cards', boardId]}),
        queryClient.invalidateQueries({queryKey: ['board', boardId]}),
      ]);
    },
    onError: error => toast.danger(errorMessage(error)),
    onSettled: () => setBusyId(null),
  });
  const items = query.data?.pages.flatMap(p => p.items);
  const canRestore = query.data?.pages[0]?.canRestore ?? false;
  if (query.isPending) return <LoadingBlock rows={3} />;
  if (query.error && !items?.length) return <ErrorNote error={query.error} title={t('states.loadError')} />;
  if (!items?.length) return <EmptyState icon="archive" title={t('bx.archive.noCards')}>{t('bx.archive.noCardsBody')}</EmptyState>;
  return (
    <>
      <ul className="lf-archive-list" aria-label={t('bx.archive.cards')}>
        {items.map(card => (
          <li key={card.id} className="lf-archive-row">
            <div className="lf-archive-text">
              <span className="lf-archive-title" dir="auto">{card.title}</span>
              <span className="lf-settings-sub">
                {t('bx.archive.in', {lane: card.laneName})}
                {card.archivedAt ? ` · ${t('bx.archive.when', {when: formatRelative(card.archivedAt)})}` : ''}
              </span>
              {card.laneArchived && <span className="lf-settings-sub">{t('bx.archive.laneHidden')}</span>}
            </div>
            {canRestore && (
              <Button size="sm" variant="secondary" pending={busyId === card.id} pendingLabel={t('bx.restoring')} disabled={(busyId !== null && busyId !== card.id) || cooldown.blocked} onClick={() => restore.mutate(card.id)}>
                {t('bx.archive.restore')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <div className="load-more">
          <Button variant="secondary" pending={query.isFetchingNextPage} pendingLabel={t('common.loading')} onClick={() => void query.fetchNextPage()}>
            {t('bx.archive.more')}
          </Button>
        </div>
      )}
    </>
  );
}

/** The board's archived lanes, with Restore (lane returns at the end of the board, cards as they were). */
function ArchivedLanes({boardId, open}: {boardId: number; open: boolean}) {
  const t = useT();
  const {errorMessage, formatRelative} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<number | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['archived-lanes', boardId],
    queryFn: ({pageParam}) => call<LanesPage>('GET', `/boards/${boardId}/archived-lanes?before=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last: LanesPage) => last.nextBefore ?? undefined,
    enabled: open,
    gcTime: 0,
  });
  const cooldown = useWriteCooldown();
  const restore = useMutation({
    mutationFn: (id: number) => call('POST', `/lanes/${id}/restore`),
    onMutate: id => setBusyId(id),
    onSuccess: async () => {
      toast.success(t('bx.archive.laneRestored'));
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ['archived-lanes', boardId]}),
        queryClient.invalidateQueries({queryKey: ['board', boardId]}),
      ]);
    },
    onError: error => toast.danger(errorMessage(error)),
    onSettled: () => setBusyId(null),
  });
  const items = query.data?.pages.flatMap(p => p.items);
  const canRestore = query.data?.pages[0]?.canRestore ?? false;
  if (query.isPending) return <LoadingBlock rows={2} />;
  if (query.error && !items?.length) return <ErrorNote error={query.error} title={t('states.loadError')} />;
  if (!items?.length) return <EmptyState icon="archive" title={t('bx.archive.noLanes')}>{t('bx.archive.noLanesBody')}</EmptyState>;
  return (
    <>
      <ul className="lf-archive-list" aria-label={t('bx.archive.lanes')}>
        {items.map(lane => (
          <li key={lane.id} className="lf-archive-row">
            <div className="lf-archive-text">
              <span className="lf-archive-title" dir="auto">{lane.name}</span>
              <span className="lf-settings-sub">
                {t('bx.archive.laneCards', {count: lane.cardCount})}
                {lane.archivedAt ? ` · ${t('bx.archive.when', {when: formatRelative(lane.archivedAt)})}` : ''}
              </span>
            </div>
            {canRestore && (
              <Button size="sm" variant="secondary" pending={busyId === lane.id} pendingLabel={t('bx.restoring')} disabled={(busyId !== null && busyId !== lane.id) || cooldown.blocked} onClick={() => restore.mutate(lane.id)}>
                {t('bx.archive.restore')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <div className="load-more">
          <Button variant="secondary" pending={query.isFetchingNextPage} pendingLabel={t('common.loading')} onClick={() => void query.fetchNextPage()}>
            {t('bx.archive.more')}
          </Button>
        </div>
      )}
    </>
  );
}

/** The archived cards drawer of a board; opened from the sidebar's "Archived cards" item. */
export function ArchivedCardsDrawer({boardId, open, onClose}: {boardId: number; open: boolean; onClose: () => void}) {
  const t = useT();
  const setOpen = (value: boolean) => {
    if (!value) onClose();
  };
  return (
    <>
      <Drawer open={open} onClose={() => setOpen(false)} title={t('bx.archive.cards')} description={t('bx.archive.cardsHint')}>
        <ArchivedCards boardId={boardId} open={open} />
        <h3 className="lf-settings-sub">{t('bx.archive.lanes')}</h3>
        <ArchivedLanes boardId={boardId} open={open} />
      </Drawer>
    </>
  );
}

/** Archived boards of a workspace, with Restore (board admins); opened from the boards list. */
export function ArchivedBoards({workspaceId, open}: {workspaceId: number; open: boolean}) {
  const t = useT();
  const {errorMessage, formatRelative} = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<number | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['archived-boards', workspaceId],
    queryFn: ({pageParam}) => call<BoardsPage>('GET', `/workspaces/${workspaceId}/boards/archived?before=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last: BoardsPage) => last.nextBefore ?? undefined,
    enabled: open && workspaceId > 0,
    gcTime: 0,
  });
  const cooldown = useWriteCooldown();
  const restore = useMutation({
    mutationFn: (id: number) => call('PATCH', `/boards/${id}`, {archived: false}),
    onMutate: id => setBusyId(id),
    onSuccess: async () => {
      toast.success(t('bx.archive.boardRestored'));
      await Promise.all([
        queryClient.invalidateQueries({queryKey: ['archived-boards', workspaceId]}),
        queryClient.invalidateQueries({queryKey: ['boards', workspaceId]}),
      ]);
    },
    onError: error => toast.danger(errorMessage(error)),
    onSettled: () => setBusyId(null),
  });
  const items = query.data?.pages.flatMap(p => p.items);
  if (!open) return null;
  if (query.isPending) return <LoadingBlock rows={2} />;
  if (query.error && !items?.length) return <ErrorNote error={query.error} title={t('states.loadError')} />;
  if (!items?.length) return <EmptyState icon="archive" title={t('bx.archive.noBoards')}>{t('bx.archive.noBoardsBody')}</EmptyState>;
  return (
    <>
      <ul className="lf-archive-list" aria-label={t('bx.archive.boards')}>
        {items.map(board => (
          <li key={board.id} className="lf-archive-row">
            <span className="lf-board-swatch lf-archive-swatch" aria-hidden="true" ref={node => backgroundStyle(node, board)} />
            <div className="lf-archive-text">
              <span className="lf-archive-title" dir="auto">{board.name}</span>
              {board.archivedAt && <span className="lf-settings-sub">{t('bx.archive.when', {when: formatRelative(board.archivedAt)})}</span>}
            </div>
            {board.canRestore && (
              <Button size="sm" variant="secondary" pending={busyId === board.id} pendingLabel={t('bx.restoring')} disabled={(busyId !== null && busyId !== board.id) || cooldown.blocked} onClick={() => restore.mutate(board.id)}>
                {t('bx.archive.restore')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <div className="load-more">
          <Button variant="secondary" pending={query.isFetchingNextPage} pendingLabel={t('common.loading')} onClick={() => void query.fetchNextPage()}>
            {t('bx.archive.more')}
          </Button>
        </div>
      )}
    </>
  );
}
