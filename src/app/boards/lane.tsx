import {SortableContext, useSortable, verticalListSortingStrategy} from '@dnd-kit/sortable';
import {useDroppable} from '@dnd-kit/core';
import {CSS} from '@dnd-kit/utilities';
import {memo, type Ref, useEffect, useMemo, useRef, useState} from 'react';

import {useT} from '../../i18n';
import {Button, Icon, IconButton} from '../../portal/ui';
import type {BoardData, CardT, LaneT} from '../api';
import {useEnter} from '../motion';
import {isTemp} from './actions';
import {CardFace, SortableCard} from './card';
import {CardComposer} from './composers';
import {LaneMenu, type LaneMenuApi} from './lane-menu';
import {CardSkeletons} from './polish';

export type LaneHandlers = {
  onEditCard: (card: CardT) => void;
  onArchiveCard: (card: CardT) => void;
  onMoveCard?: (card: CardT) => void;
  onCopyCardLink?: (card: CardT) => void;
  onEditLane: (lane: LaneT) => void;
  /** Inline rename from the lane header (optimistic; a failure rolls back and toasts). */
  onRenameLane: (lane: LaneT, name: string) => void;
  onArchiveLane: (lane: LaneT) => void;
  onToggleCollapse: (lane: LaneT) => void;
  onLoadMore: (lane: LaneT) => void;
  onAddCards: (laneId: number, titles: string[], onFail?: () => void) => Promise<void>;
  /** The lane actions menu's operations (Copy, Move, Sort, Pin, Watch, colour, archive cards). */
  menu: LaneMenuApi;
};

/** What a drag in progress tells a lane: which card is held and which lane it is over. */
export type DragState = {cardId: number; overLaneId: number | null} | null;

const collapseKey = (laneId: number) => `lf:lane-collapsed:${laneId}`;
const readCollapsed = (laneId: number): boolean | null => {
  try {
    const v = window.localStorage.getItem(collapseKey(laneId));
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
};

/** Longest lane name the server accepts (mirrors the rename route's validator and the edit dialog). */
const LANE_NAME_MAX = 80;

/**
 * The lane's name; for an editor, a click (or Enter on it) swaps it for an input in place.
 * Enter or leaving the field saves, Escape cancels; an empty or unchanged name keeps the old one.
 */
function LaneName({lane, editable, onRename}: {lane: LaneT; editable: boolean; onRename: (lane: LaneT, name: string) => void}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(lane.name);
  const button = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  const open = () => {
    done.current = false;
    setValue(lane.name);
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (save && name && name !== lane.name && name.length <= LANE_NAME_MAX) onRename(lane, name);
    setEditing(false);
    requestAnimationFrame(() => button.current?.focus());
  };
  // A drag on the field selects text; it never picks the lane up.
  const stop = (e: {stopPropagation: () => void}) => e.stopPropagation();

  if (editable && editing)
    return (
      <input
        className="lf-lane-name-input"
        dir="auto"
        autoComplete="off"
        aria-label={t('lane.name')}
        maxLength={LANE_NAME_MAX}
        value={value}
        ref={node => {
          if (node && document.activeElement !== node) {
            node.focus();
            node.select();
          }
        }}
        onChange={e => setValue(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
        onPointerDown={stop}
        onMouseDown={stop}
        onTouchStart={stop}
      />
    );
  return (
    <h2 className="lf-lane-name" dir="auto">
      {editable ? (
        <button ref={button} type="button" className="lf-lane-name-btn" title={t('lane.edit')} onClick={open}>
          {lane.name}
        </button>
      ) : (
        lane.name
      )}
    </h2>
  );
}

/** One lane: soft tint from its colour, header with grip, name, count pill and WIP meter, then its cards. */
export const LaneColumn = memo(function LaneColumn({
  lane,
  canWrite,
  handlers,
  drag,
  loadFailed = false,
  match,
  collapseEmpty = false,
}: {
  lane: BoardData['lanes'][number];
  canWrite: boolean;
  handlers: LaneHandlers;
  drag?: DragState;
  /** The lane's first page could not be loaded: show "Try again" instead of the skeleton. */
  loadFailed?: boolean;
  /** Board filter: cards that fail it are hidden (still in `lane.cards`, so drops are computed from the full lane). */
  match?: ((card: CardT) => boolean) | null;
  /** Filter panel's "Collapse lists with no matching cards": a lane with no match folds while the filter is on. */
  collapseEmpty?: boolean;
}) {
  const t = useT();
  const pending = isTemp(lane.id);
  /** Bumped by the menu's "Add card": the composer opens and takes focus. */
  const [addRequest, setAddRequest] = useState(0);
  const self = useRef<HTMLElement | null>(null);
  // Brought back (a failed archive): it grows in instead of popping into place.
  useEnter(`lane-${lane.id}`, self, 'inline');
  const sortable = useSortable({id: `lane-${lane.id}`, data: {type: 'lane'}, disabled: !canWrite || pending});
  // Collapsing is a personal view, for everyone: kept in this browser; the lane's own flag is only the default.
  const [local, setLocal] = useState<boolean | null>(() => readCollapsed(lane.id));
  const noMatch = !!match && collapseEmpty && lane.loaded && lane.cards.length > 0 && !lane.cards.some(match);
  const collapsed = noMatch || (local ?? lane.collapsed);
  const toggleCollapse = () => {
    const next = !collapsed;
    setLocal(next);
    try {
      window.localStorage.setItem(collapseKey(lane.id), next ? '1' : '0');
    } catch {
      /* storage blocked: the choice lasts until the page closes */
    }
  };
  const visibleCards = useMemo(() => (match ? lane.cards.filter(match) : lane.cards), [lane.cards, match]);
  // A new `items` array makes dnd-kit publish a new context value, which re-renders every card of the lane.
  const cardIds = useMemo(() => visibleCards.map(c => `card-${c.id}`), [visibleCards]);
  const held = drag?.cardId ?? null;
  const emptyForDrag = held !== null && lane.cards.every(c => c.id === held);
  // A pending lane (negative id) has no server row yet: nothing can be dropped on it.
  const drop = useDroppable({id: `drop-${lane.id}`, data: {type: 'drop', laneId: lane.id}, disabled: pending});
  const over = lane.wipLimit !== null && lane.cardCount > lane.wipLimit;
  // One object per set of handler identities, so the memoized SortableCard compares equal between renders.
  const cardHandlers = useMemo(
    () => ({onEdit: handlers.onEditCard, onArchive: handlers.onArchiveCard, onMove: handlers.onMoveCard, onCopyLink: handlers.onCopyCardLink}),
    [handlers.onEditCard, handlers.onArchiveCard, handlers.onMoveCard, handlers.onCopyCardLink]
  );

  // A lane the board answer left empty (its card cap) loads its first cards when it scrolls near the view, not all at
  // once on open: a 50-lane board would otherwise fire ~40 page requests (and ~40 board re-renders) together.
  const {loaded, id: laneId} = lane;
  const {onLoadMore} = handlers;
  useEffect(() => {
    if (loaded) return;
    const node = self.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      onLoadMore(lane);
      return;
    }
    const root = node.closest('.lf-lanes');
    const io = new IntersectionObserver(
      entries => {
        if (!entries.some(e => e.isIntersecting)) return;
        io.disconnect();
        onLoadMore(lane);
      },
      // About one lane ahead on either side, so the next lane is usually ready before it is seen.
      {root, rootMargin: '0px 400px'}
    );
    io.observe(node);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, laneId]);

  const tint = (node: HTMLElement | null) => {
    if (!node) return;
    if (lane.colorHex) node.style.setProperty('--lane', lane.colorHex);
    else node.style.removeProperty('--lane');
  };

  return (
    <section
      ref={node => {
        self.current = node;
        sortable.setNodeRef(node);
        tint(node);
      }}
      className="lf-lane"
      data-lane-id={lane.id}
      data-colored={lane.colorHex ? '' : undefined}
      data-collapsed={collapsed ? '' : undefined}
      data-pending={pending ? '' : undefined}
      data-pinned={lane.pinned ? '' : undefined}
      data-drop-target={held !== null && drag?.overLaneId === lane.id ? '' : undefined}
      data-over={over ? '' : undefined}
      data-card-drag={held !== null ? '' : undefined}
      data-dragging={sortable.isDragging ? '' : undefined}
      style={{transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition}}
      aria-label={lane.name}>
      {/* The header is the lane's drag handle (pointer, touch hold, or Space while it has focus). Its own buttons keep
          their clicks (a drag needs 6 px of movement) and keys pressed on them never start a drag. */}
      <header
        ref={sortable.setActivatorNodeRef}
        className="lf-lane-head"
        data-draggable={canWrite && !pending ? '' : undefined}
        tabIndex={canWrite && !pending ? 0 : undefined}
        aria-roledescription={canWrite && !pending ? sortable.attributes['aria-roledescription'] : undefined}
        aria-describedby={canWrite && !pending ? sortable.attributes['aria-describedby'] : undefined}
        title={canWrite && !pending ? t('lane.drag', {name: lane.name}) : undefined}
        {...sortable.listeners}>
        {lane.colorHex &&<span className="lf-lane-dot" role="img" aria-label={t('lane.colorMarker')} ref={tint} />}
        <LaneName lane={lane} editable={canWrite && !pending} onRename={handlers.onRenameLane} />
        {over && <span className="lf-over-text">{t('lane.wipOver')}</span>}
        {lane.wipLimit !== null && (
          <meter
            className="lf-meter"
            min={0}
            max={lane.wipLimit}
            value={Math.min(lane.cardCount, lane.wipLimit)}
            aria-label={t('lane.countLimit', {count: lane.cardCount, limit: lane.wipLimit})}
          />
        )}
        {lane.pinned && (
          <span className="lf-lane-flag" role="img" aria-label={t('laneMenu.pinned')}>
            <Icon name="pin" size={14} />
          </span>
        )}
        {lane.watching && (
          <span className="lf-lane-flag" role="img" aria-label={t('laneMenu.watching')}>
            <Icon name="eye" size={14} />
          </span>
        )}
        <IconButton
          icon={collapsed ? 'chevrons-right' : 'chevrons-left'}
          size="sm"
          label={t(collapsed ? 'lane.expand' : 'lane.collapse')}
          aria-expanded={!collapsed}
          className="lf-lane-collapse"
          onClick={toggleCollapse}
        />
        {canWrite && !pending && (
          <LaneMenu
            lane={lane}
            api={handlers.menu}
          />
        )}
      </header>
      {!collapsed && (
        <div className="lf-lane-body" ref={drop.setNodeRef}>
          <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
            <ul className="lf-cards">
              {visibleCards.map(card => (
                <SortableCard key={card.id} card={card} canWrite={canWrite} handlers={cardHandlers} />
              ))}
            </ul>
          </SortableContext>
          {emptyForDrag && lane.loaded && <p className="lf-drop-hint">{t('lane.dropHere')}</p>}
          {!emptyForDrag && lane.cards.length === 0 && lane.loaded && <p className="lf-empty">{t('lane.empty')}</p>}
          {!lane.loaded && !loadFailed && <CardSkeletons label={t('common.loading')} />}
          {!lane.loaded && loadFailed && (
            <div role="alert">
              <p className="lf-empty">{t('states.loadError')}</p>
              <Button variant="ghost" size="sm" onClick={() => handlers.onLoadMore(lane)}>
                {t('common.retry')}
              </Button>
            </div>
          )}
          {lane.hasMore && lane.loaded && (
            <Button variant="ghost" size="sm" icon="chevron-down" onClick={() => handlers.onLoadMore(lane)}>
              {t('lane.loadMore')}
            </Button>
          )}
        </div>
      )}
      {!collapsed && canWrite && !pending && (
        <div className="lf-lane-foot">
          <CardComposer
            openRequest={addRequest}
            onAdd={async (titles, onFail) => {
              await handlers.onAddCards(lane.id, titles, onFail);
              // The composer stays put under the list: bring the new cards (at the end of the list) into view.
              requestAnimationFrame(() => {
                const body = self.current?.querySelector<HTMLElement>('.lf-lane-body');
                body?.scrollTo({top: body.scrollHeight});
              });
            }}
          />
        </div>
      )}
    </section>
  );
});

/** Cards the floating copy of a held lane draws at most: enough to look whole, cheap for a huge lane. */
const GHOST_CARDS = 30;

/** What the drag overlay shows while a lane moves: the whole column (colour, header, cards), floating like a held card. */
export function LaneGhost({lane, match = null}: {lane: LaneT; match?: ((card: CardT) => boolean) | null}) {
  const t = useT();
  const visible = match ? lane.cards.filter(match) : lane.cards;
  const shown = visible.slice(0, GHOST_CARDS);
  const tint = (node: HTMLElement | null) => {
    if (node && lane.colorHex) node.style.setProperty('--lane', lane.colorHex);
  };
  return (
    <div ref={tint} className="lf-lane lf-lane-ghost" data-colored={lane.colorHex ? '' : undefined} aria-hidden="true">
      <header className="lf-lane-head">
        <h2 className="lf-lane-name" dir="auto">{lane.name}</h2>
        <span className="lf-count">{lane.cardCount}</span>
      </header>
      <div className="lf-lane-body">
        <ul className="lf-cards">
          {shown.map(card => (
            <li key={card.id} className="lf-card">
              <CardFace card={card} canWrite={false} />
            </li>
          ))}
        </ul>
        {visible.length > shown.length && <p className="lf-empty">+{visible.length - shown.length}</p>}
        {lane.cards.length === 0 && lane.loaded && <p className="lf-empty">{t('lane.empty')}</p>}
      </div>
    </div>
  );
}
