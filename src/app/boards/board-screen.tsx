import {useQuery} from '@tanstack/react-query';
import {Outlet, useParams} from '@tanstack/react-router';
import {Link, useNavigate} from '../nav';
import {lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

import {useI18n, useT} from '../../i18n';
import {Button, buttonClass, EmptyState, ErrorNote, Icon, IconButton, Notice, useConfirm, useOverlayHost, useToast} from '../../portal/ui';
import {ApiError, type CardT, type LaneT} from '../api';
import {copyCardLink} from '../cards/card-link';
import {leave, leaveAll} from '../motion';
import {boardQuery} from '../queries';
import {useBoardSync} from '../use-board-sync';
import {browserStorage, draftKey, loadDraft} from '../draft-store';
import {useSetPageTitle, useWorkspace} from '../workspace';
import type {Undoable} from './actions';
import {useBoardActions} from './actions';
import {backgroundStyle} from './background';
import {BoardCanvas} from './canvas';
import {BoardSkeleton, FailureBar} from './polish';
import './polish.css';
import './a11y.css';
import {MoveCardDialog} from './move-card';
import {BulkBarHost, SelectToggle} from './bulk-bar';
import {createSelection, MAX_SELECTED, SelectionContext} from './selection';
import {selectKeyCardId} from './bulk-run';
import {letterOf} from '../shortcut-keys';
import {storedShortcuts} from '../settings/prefs';
import type {LaneHandlers} from './lane';
import {EditLaneDialog} from './dialogs';
import {BoardSettingsDrawer} from './board-settings';
import {BoardPeople} from './board-people';
import {JoinBoardButton, ShareBoardButton} from './share-board';
import {useMe} from '../../portal/shared';
import {CalendarView} from './views/calendar-view';
import {DashboardView} from './views/dashboard';
import {WorkloadView} from './views/workload';
import {filterToPerson} from './views/workload-logic';
import {useBoardView, ViewSwitcher} from './views/view-switcher';
import './views/views.css';
import './views/dashboard.css';
import './trello.css';
import {cardFilter, collectFacets, countMatches, isActive} from './filter-logic';
import {FilterBar, useBoardFilter, useCollapseEmpty} from './filter-bar';
import {RegionBoundary} from '../region-boundary';

const BoardChat = lazy(() => import('../chat/board-chat').then(m => ({default: m.BoardChat})));

/** The board's "Undo" bar: one action at a time, gone after 8 s. Announced politely, never a toast that steals focus. */
function UndoBar({item, onDone}: {item: {label: string; undo: NonNullable<Undoable>} | null; onDone: () => void}) {
  const t = useT();
  useEffect(() => {
    if (!item) return;
    const timer = window.setTimeout(onDone, 8000);
    return () => window.clearTimeout(timer);
  }, [item, onDone]);
  const host = useOverlayHost();
  const bar = (
    <div className="lf-undo-region" role="status" aria-live="polite">
      {item && (
        <div className="lf-undo">
          <span>{item.label}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              item.undo.run();
              onDone();
            }}>
            {t('card.undo')}
          </Button>
          <IconButton icon="x" size="sm" label={t('common.dismiss')} className="lf-undo-close" onClick={onDone} />
        </div>
      )}
    </div>
  );
  // Inside the open card modal the body is hidden (top layer) and inert: show the bar in the modal then.
  return host ? createPortal(bar, host) : bar;
}

/** `/app/b/$boardId`: lanes and cards, drag and drop, polling sync. */
export function BoardScreen() {
  const t = useT();
  const {errorMessage} = useI18n();
  const {boardId: raw, cardId: openCardId} = useParams({strict: false}) as {boardId: string; cardId?: string};
  const boardId = Number(raw);
  const query = useQuery(boardQuery(boardId));
  const actions = useBoardActions(boardId);
  const setTitle = useSetPageTitle();
  const {setCurrentId, current: currentWorkspace} = useWorkspace();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const [editLane, setEditLane] = useState<LaneT | null>(null);
  const [settings, setSettings] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [undo, setUndo] = useState<{label: string; undo: NonNullable<Undoable>} | null>(null);
  const clearUndo = useCallback(() => setUndo(null), []);
  const [moveCard, setMoveCard] = useState<CardT | null>(null);
  const [view, setView] = useBoardView(useMe().data?.viewer.id ?? null, boardId);
  const [filter, setFilter] = useBoardFilter(useMe().data?.viewer.id ?? null, boardId);
  const [collapseEmpty, setCollapseEmpty] = useCollapseEmpty(boardId);
  // One shared predicate for the Board, Table and Calendar views ("now" is read when the filter changes or the board data does).
  const matchFn = useMemo(() => (isActive(filter) ? cardFilter(filter, new Date()) : null), [filter, query.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const facets = useMemo(() => collectFacets(query.data?.lanes ?? []), [query.data?.lanes]);
  const counts = useMemo(() => (matchFn ? countMatches(query.data?.lanes ?? [], matchFn) : {shown: 0, total: 0}), [matchFn, query.data?.lanes]);
  const filteredData = useMemo(() => (query.data && matchFn ? {...query.data, lanes: query.data.lanes.map(l => ({...l, cards: l.cards.filter(matchFn)}))} : query.data), [query.data, matchFn]);
  // A write that failed never leaves an Undo bar behind.
  const failedToken = actions.failedToken;
  useEffect(() => {
    if (failedToken) setUndo(cur => (cur && cur.undo.token === failedToken ? null : cur));
  }, [failedToken]);
  // After a forced sign-in returns: reopen the lane rename that still has an unsent name (once per screen).
  const lanesLoaded = query.data?.lanes;
  const reopened = useRef(false);
  useEffect(() => {
    if (reopened.current || !lanesLoaded || !currentWorkspace) return;
    reopened.current = true;
    const found = lanesLoaded.find(l => loadDraft(browserStorage(), draftKey(currentWorkspace.id, 'lane', l.id)) !== null);
    if (found) setEditLane(found);
  }, [lanesLoaded, currentWorkspace]);
  const showUndo = useCallback((label: string, item: Undoable) => item && setUndo({label, undo: item}), []);
  // The lane/card handlers keep ONE identity for the screen's life (they read the latest values through a ref),
  // so the memoized cards do not re-render on every board update.
  const latest = useRef({actions, t, confirm, toast, errorMessage});
  latest.current = {actions, t, confirm, toast, errorMessage};
  const handlers = useMemo<Omit<LaneHandlers, 'onAddCards' | 'onLoadMore'>>(
    () => ({
      // A card opens in the slide-over panel (a child route: the board stays mounted behind it).
      onEditCard: card => void navigate({to: '/b/$boardId/c/$cardId', params: {boardId: String(boardId), cardId: String(card.id)}}),
      // The card shrinks away first, then leaves the board (and the Undo toast shows).
      onArchiveCard: card =>
        void leave(document.querySelector(`.lf-card[data-card-id="${card.id}"]`)).then(() =>
          showUndo(latest.current.t('card.archivedToast'), latest.current.actions.archiveCard(card.id))
        ),
      onMoveCard: setMoveCard,
      onCopyCardLink: card =>
        void copyCardLink(boardId, card.id).then(ok => {
          if (ok) latest.current.toast.success(latest.current.t('card.linkCopied'));
          else latest.current.toast.danger(latest.current.t('card.linkCopyFailed'));
        }),
      onEditLane: setEditLane,
      onRenameLane: (lane, name) =>
        void latest.current.actions.updateLane(lane.id, {name}).catch(error => latest.current.toast.danger(latest.current.errorMessage(error))),
      onToggleCollapse: lane =>
        void latest.current.actions.updateLane(lane.id, {collapsed: !lane.collapsed}).catch(error => latest.current.toast.danger(latest.current.errorMessage(error))),
      onArchiveLane: lane => {
        const {t, confirm, toast, actions} = latest.current;
        void confirm({
          title: t('lane.archiveTitle', {name: lane.name}),
          body: t('lane.archiveBody'),
          confirmLabel: t('lane.archive'),
          action: async () => {
            await leave(document.querySelector(`.lf-lane[data-lane-id="${lane.id}"]`), 'inline');
            await actions.archiveLane(lane.id);
            toast.success(t('lane.archived'));
          },
        });
      },
      menu: {
        lanes: () => latest.current.actions.lanes(),
        move: (lane, index) => showUndo(latest.current.t('laneMenu.moved'), latest.current.actions.moveLane(lane.id, index)),
        copy: async (lane, name) => {
          await latest.current.actions.copyLane(lane.id, name);
          latest.current.toast.success(latest.current.t('laneMenu.copied'));
        },
        moveCards: async (lane, toLaneId) => {
          const count = await latest.current.actions.moveLaneCards(lane.id, toLaneId);
          latest.current.toast.success(latest.current.t('laneMenu.cardsMoved', {count}));
        },
        sort: async (lane, by) => {
          await latest.current.actions.sortLane(lane.id, by);
          latest.current.toast.success(latest.current.t('laneMenu.sorted'));
        },
        prefs: (lane, patch) => {
          const {t, toast, errorMessage, actions} = latest.current;
          actions.setLanePrefs(lane.id, patch).then(
            () => {
              if (patch.pinned !== undefined) toast.success(t(patch.pinned ? 'laneMenu.pinnedToast' : 'laneMenu.unpinnedToast'));
              if (patch.watching !== undefined) toast.success(t(patch.watching ? 'laneMenu.watchingToast' : 'laneMenu.unwatchedToast'));
            },
            error => toast.danger(errorMessage(error))
          );
        },
        color: (lane, hex) =>
          void latest.current.actions.updateLane(lane.id, {colorHex: hex}).catch(error => latest.current.toast.danger(latest.current.errorMessage(error))),
        archiveCards: lane => {
          const {t, confirm, toast, actions} = latest.current;
          void confirm({
            title: t('laneMenu.archiveCardsTitle', {name: lane.name}),
            body: t('laneMenu.archiveCardsBody'),
            confirmLabel: t('laneMenu.archiveCards'),
            action: async () => {
              await leaveAll(document.querySelector(`.lf-lane[data-lane-id="${lane.id}"]`), '.lf-card');
              const count = await actions.archiveLaneCards(lane.id);
              toast.success(t('laneMenu.cardsArchived', {count}));
            },
          });
        },
        archiveLane: lane => handlers.onArchiveLane(lane),
      },
    }),
    [navigate, boardId, showUndo]
  );
  const data = query.data;

  // Bulk select: one store per board (state only). `order` is the on-screen card order, for Shift-click ranges.
  const order = useRef<number[]>([]);
  const selection = useMemo(() => createSelection(() => order.current), [boardId]); // eslint-disable-line react-hooks/exhaustive-deps
  order.current = (filteredData ?? data)?.lanes.flatMap(l => l.cards.map(c => c.id).filter(id => id > 0)) ?? [];
  // A card that left the board (archived, moved, removed by someone else's sync) leaves the selection too.
  useEffect(() => {
    if (data) selection.prune(new Set(data.lanes.flatMap(l => l.cards.map(c => c.id))));
  }, [data, selection]);
  // Esc: first untick everything, then leave select mode (an open dialog or a text field keeps its own Esc).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !selection.get().mode) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="menu"]') || document.querySelector('dialog[open]')) return;
      if (selection.get().ids.size > 0) selection.clear();
      else selection.reset();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selection]);
  // `x` on a focused card ticks or unticks it (and turns select mode on). Only where the bar exists (the board view, a
  // writer), never while typing or with a dialog or menu open, and only while single-key shortcuts are on (WCAG 2.1.4).
  const canSelect = useRef(false);
  canSelect.current = view === 'board' && !!data?.board.canWrite && !data.board.archived;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!canSelect.current || !storedShortcuts()) return;
      const id = selectKeyCardId(event, event.target as HTMLElement | null, letterOf(event));
      if (id === null || document.querySelector('dialog[open], [role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      if (selection.toggle(id)) latest.current.toast.danger(latest.current.t('bulk.limit', {max: MAX_SELECTED}));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selection]);

  useBoardSync(boardId);
  useEffect(() => {
    if (data) setTitle(data.board.name);
    return () => setTitle(null);
  }, [data?.board.name, setTitle]); // eslint-disable-line react-hooks/exhaustive-deps
  // A board opened by link lives in its own workspace: make that the current one.
  useEffect(() => {
    // A guest is not a member of the board's workspace: keep their own workspace as the current one.
    if (data && !data.board.guest) setCurrentId(data.board.workspaceId);
  }, [data?.board.workspaceId, setCurrentId]); // eslint-disable-line react-hooks/exhaustive-deps

  const canvasRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (canvasRef.current && data) backgroundStyle(canvasRef.current, data.board);
  }, [data?.board.bgKind, data?.board.bgColor1, data?.board.bgColor2, data?.board.bgAngle, data?.board.bgImage]); // eslint-disable-line react-hooks/exhaustive-deps

  if (query.isPending) {
    return (
      <BoardSkeleton />
    );
  }
  if (query.error || !data) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="app-page">
        {missing || !query.error ? (
          <EmptyState
            icon="lock"
            title={t('boards.notFoundTitle')}
            action={
              <Link to="/boards" className={buttonClass({variant: 'secondary'})}>
                {t('boards.backToBoards')}
              </Link>
            }>
            {t('boards.notFoundBody')}
          </EmptyState>
        ) : (
          <>
            <ErrorNote error={query.error} title={t('states.loadError')} />
            <Button variant="secondary" icon="refresh" pending={query.isFetching} pendingLabel={t('common.loading')} onClick={() => void query.refetch()}>
              {t('common.retry')}
            </Button>
          </>
        )}
      </div>
    );
  }

  const {board} = data;

  const archiveBoard = () =>
    void confirm({
      title: t('boards.archiveTitle', {name: board.name}),
      body: t('boards.archiveBody'),
      confirmLabel: t('boards.archive'),
      action: async () => {
        await actions.updateBoard({archived: true});
        setSettings(false);
        toast.success(t('boards.archivedToast'));
      },
    });

  return (
    <SelectionContext.Provider value={selection}>
    <div className="lf-board" ref={canvasRef} role="region" aria-label={t('boards.canvas', {name: board.name})}>
      <div className="lf-board-top">
        <FilterBar boardId={board.id} filter={filter} onChange={setFilter} labels={facets.labels} members={facets.members} canSave={!board.archived} collapseEmpty={collapseEmpty} onCollapseEmpty={setCollapseEmpty} shown={counts.shown} total={counts.total} />
        <div className="lf-board-members">
          <BoardPeople boardId={board.id} />
          <JoinBoardButton board={board} />
          {!board.archived && <ShareBoardButton board={board} />}
        </div>
      </div>
      <div className="lf-board-head">
        <IconButton
          icon="star"
          label={board.starred ? t('boards.starRemove') : t('boards.starAdd')}
          aria-pressed={board.starred}
          className={board.starred ? 'lf-star is-on' : 'lf-star'}
          onClick={() => actions.toggleStar(!board.starred)}
        />
        {board.visibility === 'private' && (
          <span className="lf-board-private" title={t('boards.visibility.privateHint')}>
            <Icon name="lock" size={14} />
            {t('boards.visibility.private')}
          </span>
        )}
        <ViewSwitcher view={view} onChange={setView} />
        {view === 'board' && board.canWrite && !board.archived && <SelectToggle selection={selection} />}
        <span className="lf-board-head-spacer" />
        {/* Board chat belongs to the workspace: a guest sees the board only. */}
        {!board.guest && (
          <Button variant="secondary" size="sm" icon="message" aria-pressed={chatOpen} onClick={() => setChatOpen(open => !open)}>
            <span className="lf-head-label">{t('chat.boardChatTab')}</span>
          </Button>
        )}
        {board.canAdmin && !board.archived && (
          <Button variant="secondary" size="sm" icon="settings" aria-haspopup="dialog" aria-expanded={settings} onClick={() => setSettings(true)}>
            <span className="lf-head-label">{t('boards.settings')}</span>
          </Button>
        )}
      </div>
      {view === 'board' && <BulkBarHost boardId={board.id} lanes={data.lanes} actions={actions} selection={selection} onUndoable={showUndo} />}
      {board.archived && (
        <Notice
          tone="warning"
          action={
            board.canAdmin ? (
              <Button size="sm" variant="secondary" onClick={() => void actions.updateBoard({archived: false}).catch(error => toast.danger(errorMessage(error)))}>
                {t('boards.restore')}
              </Button>
            ) : undefined
          }>
          {t('boards.archivedNotice')}
        </Notice>
      )}
      {!board.canWrite && !board.archived && <Notice tone="info">{t('boards.readOnly')}</Notice>}
      <RegionBoundary region="board" key={view}>
      {view === 'calendar' ? (
        <CalendarView data={filteredData ?? data} actions={actions} onOpenCard={handlers.onEditCard} />
      ) : view === 'dashboard' ? (
        <DashboardView data={filteredData ?? data} actions={actions} />
      ) : view === 'workload' ? (
        <WorkloadView boardId={board.id} rev={board.rev} onShowPerson={userId => { setFilter(filterToPerson(filter, userId)); setView('board'); }} />
      ) : (
        <BoardCanvas
          data={data}
          actions={actions}
          onUndoable={showUndo}
          handlers={handlers}
          match={matchFn}
          collapseEmpty={collapseEmpty}
        />
      )}
      </RegionBoundary>
      {chatOpen && (
        <Suspense fallback={null}>
          <RegionBoundary region="board chat" compact onClose={() => setChatOpen(false)}>
          <BoardChat boardId={board.id} workspaceId={board.workspaceId} role={board.role === 'admin' ? 'admin' : board.role} onClose={() => setChatOpen(false)} />
          </RegionBoundary>
        </Suspense>
      )}
      <FailureBar failure={actions.failure} onDone={actions.clearFailure} />
      <UndoBar item={undo} onDone={clearUndo} />
      <RegionBoundary region="card panel" key={openCardId ?? 'none'} onClose={() => void navigate({to: '/b/$boardId', params: {boardId: String(board.id)}})}>
        <Outlet />
      </RegionBoundary>
      <MoveCardDialog card={moveCard} boardId={board.id} workspaceId={board.workspaceId} lanes={data.lanes} actions={actions} onUndoable={showUndo} onClose={() => setMoveCard(null)} />
      <EditLaneDialog lane={editLane} actions={actions} onClose={() => setEditLane(null)} />
      {board.canAdmin && <BoardSettingsDrawer board={board} lanes={data.lanes} actions={actions} open={settings} onClose={() => setSettings(false)} onArchive={archiveBoard} />}
    </div>
    </SelectionContext.Provider>
  );
}
