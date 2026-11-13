import {
  type Announcements,
  type CollisionDetection,
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  getFirstCollision,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {arrayMove, horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates} from '@dnd-kit/sortable';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {useI18n, useT} from '../../i18n';
import {useToast} from '../../portal/ui';
import type {BoardData, CardT, LaneT} from '../api';
import {findCard, moveCardInLanes} from '../board-state';
import {pauseBoardSync} from '../use-board-sync';
import type {BoardActions, Undoable} from './actions';
import {groupDrop} from './bulk-run';
import {CardFace} from './card';
import {useSelectedIds, useSelection, useSelectMode} from './selection';
import {useBulkRunner} from './use-bulk-runner';
import {LaneComposer} from './composers';
import {type DragState, LaneColumn, type LaneHandlers, LaneGhost} from './lane';

// Module constants: inline option objects would make dnd-kit rebuild its sensors on every render.
const MOUSE_OPTIONS = {activationConstraint: {distance: 6}};
const TOUCH_OPTIONS = {activationConstraint: {delay: 220, tolerance: 8}};
const KEYBOARD_OPTIONS = {coordinateGetter: sortableKeyboardCoordinates};

type Active = {type: 'card'; id: number} | {type: 'lane'; id: number} | null;

/**
 * On the held card's overlay: how many other ticked cards ride along. A component of its own so only the overlay
 * (mounted just while dragging) follows the selection, never the whole board.
 */
function DragGroupBadge({cardId}: {cardId: number}) {
  const t = useT();
  const mode = useSelectMode();
  const ids = useSelectedIds();
  const group = groupDrop({mode, ids}, cardId);
  return group ? <span className="lf-drag-count">{t('bulk.dragMore', {count: group.length - 1})}</span> : null;
}

const idOf = (dndId: string | number, prefix: string) => (String(dndId).startsWith(`${prefix}-`) ? Number(String(dndId).slice(prefix.length + 1)) : null);

/**
 * The board's lanes and cards with drag and drop (dnd-kit: mouse, touch with a short hold, keyboard on the
 * grip: Space lifts, arrows move, Space drops, Esc cancels; moves are announced in the user's language).
 * While dragging, a local `draft` of the lanes shows where the card WOULD land; on drop ONE optimistic
 * `moveCard` / `moveLane` commits it (and returns an undo). Nothing here touches the network itself.
 */
export function BoardCanvas({
  data,
  actions,
  handlers,
  onUndoable,
  match = null,
  collapseEmpty = false,
  swimlane = false,
  dndId,
}: {
  data: BoardData;
  actions: BoardActions;
  handlers: Omit<LaneHandlers, 'onAddCards' | 'onLoadMore'>;
  onUndoable: (label: string, undo: Undoable) => void;
  /** Board filter predicate (null: none). Only HIDES cards: drop positions are still computed from the full lanes. */
  match?: ((card: CardT) => boolean) | null;
  collapseEmpty?: boolean;
  /** One row of the swimlane view: `data` holds only this row's cards; no "add lane" tile, own DndContext id. */
  swimlane?: boolean;
  dndId?: string;
}) {
  const t = useT();
  const {errorMessage} = useI18n();
  const toast = useToast();
  const selection = useSelection();
  const runBulk = useBulkRunner(actions, selection, onUndoable);
  const canWrite = data.board.canWrite && !data.board.archived;
  const [active, setActive] = useState<Active>(null);
  const [draft, setDraft] = useState<LaneT[] | null>(null);
  const [overLane, setOverLane] = useState<number | null>(null);
  const lanes = draft ?? data.lanes;
  const lanesRef = useRef(lanes);
  lanesRef.current = lanes;
  /** The draft, updated the moment it changes (state lags a render): drop reads THIS, never a stale lanesRef. */
  const draftRef = useRef<LaneT[] | null>(null);
  const showDraft = (next: LaneT[] | null) => {
    draftRef.current = next;
    if (next) lanesRef.current = next;
    setDraft(next);
  };
  // The sync poll applies nothing while something is held; it always resumes (drop, cancel, leaving the board).
  useEffect(() => () => pauseBoardSync(false), []);

  const sensors = useSensors(useSensor(MouseSensor, MOUSE_OPTIONS), useSensor(TouchSensor, TOUCH_OPTIONS), useSensor(KeyboardSensor, KEYBOARD_OPTIONS));

  // Lanes: nearest lane. Cards: the lane/card under the pointer, then the closest card inside that lane.
  const collision = useCallback<CollisionDetection>(args => {
    if (args.active.data.current?.type === 'lane') {
      return closestCenter({...args, droppableContainers: args.droppableContainers.filter(c => c.data.current?.type === 'lane')});
    }
    const hits = pointerWithin(args);
    const found = hits.length ? hits : rectIntersection(args);
    let overId = getFirstCollision(found, 'id');
    if (overId == null) return [];
    const laneId = idOf(overId, 'drop');
    if (laneId !== null) {
      const cards = lanesRef.current.find(l => l.id === laneId)?.cards ?? [];
      if (cards.length) {
        // A Set, not cards.some() per container: this runs on every pointer move during a drag.
        const inLane = new Set<string | number>(cards.map(card => `card-${card.id}`));
        const nearest = closestCenter({
          ...args,
          droppableContainers: args.droppableContainers.filter(c => inLane.has(c.id)),
        });
        overId = nearest[0]?.id ?? overId;
      }
    }
    return [{id: overId}];
  }, []);

  const laneOfOver = (overId: string | number, list: LaneT[]): number | null => {
    const drop = idOf(overId, 'drop');
    if (drop !== null) return drop;
    const lane = idOf(overId, 'lane');
    if (lane !== null) return lane;
    const card = idOf(overId, 'card');
    return card === null ? null : (findCard(list, card)?.laneId ?? null);
  };

  const onDragStart = (event: DragStartEvent) => {
    const card = idOf(event.active.id, 'card');
    const lane = idOf(event.active.id, 'lane');
    pauseBoardSync(true);
    setActive(card !== null ? {type: 'card', id: card} : lane !== null ? {type: 'lane', id: lane} : null);
    showDraft(data.lanes);
  };

  const onDragOver = (event: DragOverEvent) => {
    const cardId = idOf(event.active.id, 'card');
    const {over} = event;
    if (cardId === null) return;
    setOverLane(over ? laneOfOver(over.id, lanesRef.current) : null);
    if (!over) return;
    const list = draftRef.current ?? data.lanes;
    const from = findCard(list, cardId);
    const toLane = laneOfOver(over.id, list);
    if (!from || toLane === null || from.laneId === toLane) return;
    const target = list.find(l => l.id === toLane);
    if (!target) return;
    const overCard = idOf(over.id, 'card');
    let index = target.cards.length;
    if (overCard !== null) {
      const overIndex = target.cards.findIndex(c => c.id === overCard);
      const translated = event.active.rect.current.translated;
      const below = translated ? translated.top > over.rect.top + over.rect.height / 2 : false;
      index = overIndex + (below ? 1 : 0);
    }
    showDraft(moveCardInLanes(list, cardId, toLane, index));
  };

  const onDragEnd = (event: DragEndEvent) => {
    const {over} = event;
    const list = draftRef.current ?? data.lanes;
    const cardId = idOf(event.active.id, 'card');
    const laneId = idOf(event.active.id, 'lane');
    setActive(null);
    showDraft(null);
    setOverLane(null);
    pauseBoardSync(false);
    if (!over) return;
    if (cardId !== null) {
      const at = findCard(list, cardId);
      if (!at) return;
      // A TICKED card dropped on ANOTHER lane while several are ticked: all the ticked cards go there (to its end, the
      // bulk move's rule). Dropped inside its own lane it is the usual single move, with its exact place.
      const group = selection ? groupDrop(selection.get(), cardId) : null;
      if (group && findCard(data.lanes, cardId)?.laneId !== at.laneId) {
        runBulk(group, {action: 'move', laneId: at.laneId}).catch(error => toast.danger(errorMessage(error)));
        return;
      }
      let index = at.index;
      const overCard = idOf(over.id, 'card');
      const lane = list.find(l => l.id === at.laneId)!;
      if (overCard !== null) {
        const overIndex = lane.cards.findIndex(c => c.id === overCard);
        if (overIndex >= 0 && overIndex !== at.index) {
          // Same lane (cross-lane moves are already in the draft): arrayMove semantics.
          index = overIndex;
        }
      } else if (idOf(over.id, 'drop') === at.laneId && lane.cards.length) {
        index = Math.min(at.index, lane.cards.length - 1);
      }
      // Send "right after this neighbour" resolved against the board as it is now, not an index of the draft.
      const ids = lane.cards.filter(c => c.id !== cardId).map(c => c.id);
      const prevId = ids[Math.min(index, ids.length) - 1] ?? null;
      const undo = actions.moveCardAfter(cardId, at.laneId, prevId, index);
      if (undo) onUndoable(t('polish.cardMoved'), undo);
      // The card was re-mounted in its new lane: a keyboard move puts focus back on it (a pointer drag leaves focus alone).
      if (event.activatorEvent instanceof KeyboardEvent) {
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`li[data-card-id="${cardId}"]`)?.focus());
      }
    } else if (laneId !== null) {
      const from = data.lanes.findIndex(l => l.id === laneId);
      const overLane = idOf(over.id, 'lane');
      const to = overLane === null ? from : data.lanes.findIndex(l => l.id === overLane);
      if (from >= 0 && to >= 0 && from !== to) {
        const moved = arrayMove(data.lanes, from, to);
        actions.moveLane(laneId, moved.findIndex(l => l.id === laneId));
      }
    }
  };

  const onDragCancel = () => {
    setActive(null);
    showDraft(null);
    setOverLane(null);
    pauseBoardSync(false);
  };

  const announcements = useMemo<Announcements>(() => {
    const describe = (id: string | number, overId?: string | number) => {
      const list = lanesRef.current;
      const cardId = idOf(id, 'card');
      if (cardId !== null) {
        const at = findCard(list, cardId);
        const lane = at && list.find(l => l.id === at.laneId);
        const card = lane?.cards[at!.index];
        return card && lane ? {kind: 'card' as const, title: card.title, lane: lane.name, position: at!.index + 1, total: lane.cards.length} : null;
      }
      const laneId = idOf(overId ?? id, 'lane') ?? idOf(id, 'lane');
      const index = list.findIndex(l => l.id === laneId);
      return index >= 0 ? {kind: 'lane' as const, title: list[index]!.name, lane: list[index]!.name, position: index + 1, total: list.length} : null;
    };
    return {
      onDragStart: ({active: a}) => {
        const d = describe(a.id);
        return d ? (d.kind === 'card' ? t('dnd.pickedUpCard', {title: d.title}) : t('dnd.pickedUpLane', {name: d.title})) : undefined;
      },
      onDragOver: ({active: a, over}) => {
        const d = describe(a.id, over?.id);
        return d ? (d.kind === 'card' ? t('dnd.movedCard', {title: d.title, lane: d.lane, position: d.position, total: d.total}) : t('dnd.movedLane', {name: d.title, position: d.position, total: d.total})) : undefined;
      },
      onDragEnd: ({active: a, over}) => {
        const d = describe(a.id, over?.id);
        return d ? (d.kind === 'card' ? t('dnd.droppedCard', {title: d.title, lane: d.lane, position: d.position, total: d.total}) : t('dnd.droppedLane', {name: d.title, position: d.position, total: d.total})) : undefined;
      },
      onDragCancel: () => t('dnd.cancelled'),
    };
  }, [t]);

  const {loadLane, addCards} = actions;
  const laneHandlers = useMemo<LaneHandlers>(
    () => ({...handlers, onLoadMore: lane => void loadLane(lane.id), onAddCards: addCards}),
    [handlers, loadLane, addCards]
  );

  const activeCard: CardT | null = active?.type === 'card' ? (lanes.flatMap(l => l.cards).find(c => c.id === active.id) ?? null) : null;
  // Lanes the card is not over share ONE object (overLaneId null), so only the lane being entered or left re-renders.
  const heldId = active?.type === 'card' ? active.id : null;
  const dragIdle = useMemo<DragState>(() => (heldId === null ? null : {cardId: heldId, overLaneId: null}), [heldId]);
  const dragOver = useMemo<DragState>(() => (heldId === null ? null : {cardId: heldId, overLaneId: overLane}), [heldId, overLane]);
  // A lane this person pinned shows first (their own view; the saved order is unchanged). Lane drops are computed from
  // lane ids against the saved order, so showing them in another order is safe.
  const shown = useMemo(() => (lanes.some(l => l.pinned) ? [...lanes.filter(l => l.pinned), ...lanes.filter(l => !l.pinned)] : lanes), [lanes]);
  const laneIds = useMemo(() => shown.map(l => `lane-${l.id}`), [shown]);
  const accessibility = useMemo(() => ({announcements, screenReaderInstructions: {draggable: t('dnd.instructions')}}), [announcements, t]);
  const activeLane = active?.type === 'lane' ? (lanes.find(l => l.id === active.id) ?? null) : null;

  return (
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
      accessibility={accessibility}>
      <div className="lf-lanes">
        <SortableContext items={laneIds} strategy={horizontalListSortingStrategy}>
          {shown.map(lane => (
            <LaneColumn key={lane.id} lane={lane} canWrite={canWrite} handlers={laneHandlers} drag={overLane === lane.id ? dragOver : dragIdle} loadFailed={actions.failedLanes.has(lane.id)} match={match} collapseEmpty={collapseEmpty} />
          ))}
        </SortableContext>
        {!swimlane && lanes.length === 0 && !canWrite && <p className="lf-empty">{t('bx.wip.noLanes')}</p>}
        {canWrite && !swimlane && <LaneComposer onAdd={actions.addLane} />}
      </div>
      <DragOverlay>
        {activeCard ? (
          <div className="lf-card lf-card-overlay lf-drag-group">
            <CardFace card={activeCard} canWrite={false} />
            <DragGroupBadge cardId={activeCard.id} />
          </div>
        ) : activeLane ? (
          <LaneGhost lane={activeLane} match={match} />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
