import {useQueryClient} from '@tanstack/react-query';
import {recoverFailedAdd} from './add-recovery';
import {useNavigate} from '../nav';
import {useCallback, useMemo, useRef, useState} from 'react';

import {useI18n} from '../../i18n';
import {useToast} from '../../portal/ui';
import {ApiError, type BoardData, type BoardT, call, type CardT, type LaneT} from '../api';
import {putFile} from '../../platform/files-browser';
import {
  findCard,
  insertCard,
  keyBetween,
  mergeLanePage,
  moveCardInLanes,
  moveLaneInList,
  revertCardMove,
  revertLaneMove,
  nextCursor,
  patchCard,
  patchLane,
  removeCard,
  replaceTemps,
} from '../board-state';
import {markEnter} from '../motion';
import {tracked} from '../use-board-sync';
import {type BulkAnswer, type BulkUndoStep, runUndoSteps} from './bulk-run';

/** What a move or an archive hands back so the screen can offer "Undo". */
export type Undoable = {run: () => void; token: object} | null;

/** A write that failed after the screen already showed it: the message and what "Retry" runs. */
export type Failure = {message: string; retry: () => void};

/** A refused (403) or conflicting (409, not "stale") write fails the same way again: no "Try again" for it. */
const retryable = (error: unknown) => !(error instanceof ApiError && (error.status === 403 || (error.status === 409 && error.code !== 'stale')));

/** The bulk bar's actions (mirrors `POST /boards/:id/cards/bulk`): the card ids are sent with them. */
export type BulkAction =
  | {action: 'move'; laneId: number}
  | {action: 'archive'}
  | {action: 'label_add' | 'label_remove'; labelId: number}
  | {action: 'assign' | 'unassign'; userId: number}
  | {action: 'set_due'; dueDate: string | null}
  | {action: 'set_priority'; priority: string};

/** Temporary (not yet saved) cards and lanes carry a negative id. */
export const isTemp = (id: number) => id < 0;

/**
 * Every board write, in ONE place. Each is optimistic: the cached board changes at once, the request goes
 * out (tracked, so the sync poll waits for it), and a failure puts the snapshot back and says why in a toast.
 * Positions are never sent: only "right after this sibling" (`afterId`); the server makes the key.
 */
export function useBoardActions(boardId: number) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const {errorMessage, t} = useI18n();
  const key = useMemo(() => ['board', boardId], [boardId]);
  const loading = useRef(new Set<number>());
  const archiving = useRef(new Set<number>());
  /** Cards whose archive failed: their Undo must do nothing (the card was never archived). */
  const archiveFailed = useRef(new Set<number>());
  /** Star writes run one after the other, so a double click never lands PUT and DELETE out of order. */
  const starChain = useRef<Promise<unknown>>(Promise.resolve());
  const tempId = useRef(0);
  /** The token of the last Undoable whose write failed: the screen drops its Undo bar. */
  const [failedToken, setFailedToken] = useState<object | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** Lanes whose first page could not be loaded: they show "Try again" instead of a skeleton. */
  const [failedLanes, setFailedLanes] = useState<ReadonlySet<number>>(new Set());
  const clearFailure = useCallback(() => setFailure(null), []);

  const get = useCallback(() => queryClient.getQueryData<BoardData>(key), [queryClient, key]);
  const set = useCallback(
    (fn: (data: BoardData) => BoardData) => queryClient.setQueryData<BoardData>(key, data => (data ? fn(data) : data)),
    [queryClient, key]
  );
  const rollback = useCallback(
    (error: unknown, snapshot: BoardData | undefined, retry?: () => void) => {
      if (snapshot) queryClient.setQueryData(key, snapshot);
      if (error instanceof ApiError && error.code === 'stale') void queryClient.invalidateQueries({queryKey: key});
      if (retry && retryable(error)) setFailure({message: errorMessage(error), retry});
      else toast.danger(errorMessage(error));
    },
    [queryClient, key, toast, errorMessage]
  );
  /** Put the snapshot back and say why in a toast whose "Try again" runs `retry` (moves and archives). */
  const rollbackWithRetry = useCallback(
    (error: unknown, snapshot: BoardData | undefined, retry: () => void) => {
      if (snapshot) queryClient.setQueryData(key, snapshot);
      if (error instanceof ApiError && error.code === 'stale') void queryClient.invalidateQueries({queryKey: key});
      if (retryable(error)) toast.danger(errorMessage(error), {action: {label: t('common.retry'), onSelect: retry}});
      else toast.danger(errorMessage(error));
    },
    [queryClient, key, toast, errorMessage, t]
  );
  const setLanes = useCallback((fn: (lanes: LaneT[]) => LaneT[]) => set(data => ({...data, lanes: fn(data.lanes)})), [set]);

  const api = useMemo(() => {
    /** Move a card so it sits at `index` of lane `laneId` (index counted without the card). */
    const moveCard = (cardId: number, laneId: number, index: number): Undoable => {
      const data = get();
      const from = data && findCard(data.lanes, cardId);
      if (!data || !from || isTemp(cardId) || (from.laneId === laneId && from.index === index)) return null;
      // The target lane vanished (archived by someone else): nothing to move to.
      if (!data.lanes.some(l => l.id === laneId)) return null;
      const originCards = data.lanes.find(l => l.id === from.laneId)!.cards;
      const origin = originCards[from.index]!;
      // Undo is anchored on the card that stood before this one, not on an index (the board may have changed).
      const undoAfter = originCards[from.index - 1]?.id ?? null;
      const token = {};
      const moved = moveCardInLanes(data.lanes, cardId, laneId, index);
      const list = moved.find(l => l.id === laneId)?.cards;
      if (!list) return null;
      const prev = list[index - 1];
      const next = list[index + 1];
      const position = keyBetween(prev?.position, next?.position) ?? undefined;
      set(d => ({...d, lanes: position ? moveCardInLanes(d.lanes, cardId, laneId, index, position) : moved}));
      // A card still being saved has a temporary negative id the server cannot know: anchor on the nearest
      // saved card before the slot instead (the server never sees a negative afterId).
      const anchor = list.slice(0, index).reverse().find(card => !isTemp(card.id));
      tracked(() => call<{position: string}>('POST', `/cards/${cardId}/move`, {laneId, afterId: anchor?.id ?? null}))
        .then(res => setLanes(lanes => patchCard(lanes, cardId, {position: res.position})))
        .catch(error => {
          setFailedToken(token);
          // Only this card goes back: later optimistic edits (another move, a new card) stay.
          setLanes(lanes => revertCardMove(lanes, cardId, from.laneId, from.index, origin.position));
          rollbackWithRetry(error, undefined, () => void moveCardAfter(cardId, laneId, prev?.id ?? null, index));
        });
      return {token, run: () => void moveCardAfter(cardId, from.laneId, undoAfter, from.index)};
    };

    /** Move a card to sit right after `afterId` (first when null) in lane `laneId`, resolved against the board as it is NOW. */
    const moveCardAfter = (cardId: number, laneId: number, afterId: number | null, fallbackIndex = 0): Undoable => {
      const lane = get()?.lanes.find(l => l.id === laneId);
      if (!lane) return null;
      const others = lane.cards.filter(c => c.id !== cardId);
      const at = afterId === null ? -1 : others.findIndex(c => c.id === afterId);
      const index = afterId === null ? 0 : at >= 0 ? at + 1 : Math.min(Math.max(fallbackIndex, 0), others.length);
      return moveCard(cardId, laneId, index);
    };

    const moveLane = (laneId: number, index: number): Undoable => {
      const data = get();
      const from = data?.lanes.findIndex(l => l.id === laneId) ?? -1;
      if (!data || from < 0 || from === index) return null;
      const token = {};
      const original = data.lanes[from]!;
      const moved = moveLaneInList(data.lanes, laneId, index);
      const prev = moved[index - 1];
      const next = moved[index + 1];
      const position = keyBetween(prev?.position, next?.position) ?? undefined;
      setLanes(() => (position ? moveLaneInList(data.lanes, laneId, index, position) : moved));
      // Anchor on the nearest SAVED lane before the slot (a pending lane has a negative id the server cannot know).
      const anchor = moved.slice(0, index).reverse().find(l => !isTemp(l.id));
      tracked(() => call<{position: string}>('POST', `/lanes/${laneId}/move`, {afterId: anchor?.id ?? null}))
        .then(res => setLanes(lanes => patchLane(lanes, laneId, {position: res.position})))
        .catch(error => {
          setFailedToken(token);
          setLanes(lanes => revertLaneMove(lanes, laneId, from, original.position));
          rollback(error, undefined);
        });
      return {token, run: () => void moveLane(laneId, from)};
    };

    /**
     * New cards at the end of a lane, shown at once as pending cards (negative id) and swapped for the saved
     * ones on the answer. A failure removes them; the composer restores the text, or (no composer) the failure bar offers "Retry".
     */
    const addCards = async (laneId: number, titles: string[], onFail?: () => void): Promise<void> => {
      const temps: CardT[] = titles.map(title => {
        const id = --tempId.current;
        return {id, laneId, title, position: `~${String(-id).padStart(8, '0')}`, priority: 'none', dueDate: null, startDate: null, completed: false, checklistTotal: 0, checklistDone: 0, commentCount: 0, attachmentCount: 0, archived: false, labels: [], labelCount: 0, members: [], memberCount: 0, coverAttachmentId: null};
      });
      const tempIds = temps.map(card => card.id);
      const dropTemps = (lanes: LaneT[]) => temps.reduce((acc, card) => removeCard(acc, card.id), lanes);
      setLanes(lanes => lanes.map(l => (l.id === laneId ? {...l, cards: [...l.cards, ...temps], cardCount: l.cardCount + temps.length} : l)));
      void (async () => {
        let res: {items: CardT[]};
        try {
          res = await tracked(() => call<{items: CardT[]}>('POST', `/lanes/${laneId}/cards`, {titles}));
        } catch (error) {
          setLanes(dropTemps);
          // One recovery path: the composer puts the text back (no Retry), else the failure bar retries.
          rollback(error, undefined, recoverFailedAdd(onFail, () => void addCards(laneId, titles)));
          return;
        }
        // The cards are saved. They belong at the END of the lane: when the lane is only partly loaded, load the
        // rest first (the pending cards stay visible meanwhile) so they never vanish from view. A failed page
        // load is not a failed save: show them and reload the board.
        try {
          for (let pages = 0; pages < 30; pages++) {
            const lane = get()?.lanes.find(l => l.id === laneId);
            if (!lane || !lane.loaded || !lane.hasMore) break;
            const page = await call<{items: CardT[]; next: string | null}>('GET', `/lanes/${laneId}/cards?after=${encodeURIComponent(nextCursor(lane))}`);
            setLanes(lanes => mergeLanePage(lanes, laneId, page.items, page.next !== null));
          }
        } catch {
          void queryClient.invalidateQueries({queryKey: key});
        }
        setLanes(lanes => replaceTemps(lanes, laneId, tempIds, res.items));
        if (get()?.lanes.find(l => l.id === laneId)?.hasMore) void queryClient.invalidateQueries({queryKey: key});
      })();
    };

    const archiveCard = (cardId: number): Undoable => {
      const data = get();
      const at = data && findCard(data.lanes, cardId);
      if (!data || !at || isTemp(cardId) || archiving.current.has(cardId)) return null;
      const card = data.lanes.find(l => l.id === at.laneId)!.cards[at.index]!;
      const token = {};
      archiving.current.add(cardId);
      archiveFailed.current.delete(cardId);
      setLanes(lanes => removeCard(lanes, cardId));
      const request = tracked(() => call('POST', `/cards/${cardId}/archive`))
        .then(() => true)
        .catch(error => {
          archiveFailed.current.add(cardId);
          setFailedToken(token);
          // Only this card comes back; the rest of the board keeps its later edits.
          markEnter(`card-${cardId}`);
          setLanes(lanes => insertCard(lanes, card));
          rollbackWithRetry(error, undefined, () => void archiveCard(cardId));
          return false;
        })
        .finally(() => archiving.current.delete(cardId));
      return {
        token,
        // Undo while the archive is still in flight waits for it to settle, then restores.
        run: () =>
          void request.then(archived => {
            if (!archived || archiveFailed.current.delete(cardId)) return;
            if (archiving.current.has(cardId)) return;
            archiving.current.add(cardId);
            markEnter(`card-${cardId}`);
            setLanes(lanes => insertCard(lanes, card));
            tracked(() => call('POST', `/cards/${cardId}/restore`)).catch(error => {
              setLanes(lanes => removeCard(lanes, cardId));
              toast.danger(errorMessage(error));
            }).finally(() => archiving.current.delete(cardId));
          }),
      };
    };

    /** Title, priority, due date, done: shown at once; a failure puts the old values back and offers "Retry". */
    const updateCard = async (cardId: number, patch: {title?: string; priority?: string; dueDate?: string | null; completed?: boolean}): Promise<void> => {
      const data = get();
      const at = data && findCard(data.lanes, cardId);
      if (!data || !at || isTemp(cardId)) return;
      const before = data.lanes.find(l => l.id === at.laneId)!.cards[at.index]!;
      const old: Partial<CardT> = {title: before.title, priority: before.priority, dueDate: before.dueDate, completed: before.completed};
      setLanes(lanes => patchCard(lanes, cardId, patch));
      tracked(() => call<{card: CardT}>('PATCH', `/cards/${cardId}`, patch))
        .then(res => setLanes(lanes => patchCard(lanes, cardId, res.card)))
        .catch(error => {
          setLanes(lanes => patchCard(lanes, cardId, old));
          rollback(error, undefined, () => void updateCard(cardId, patch));
        });
    };

    /** The lane shows at once (negative id), then the saved one replaces it; a failure removes it and offers "Retry". */
    const addLane = async (name: string): Promise<void> => {
      const id = --tempId.current;
      const temp: LaneT = {id, name, position: `~${String(-id).padStart(8, '0')}`, colorHex: null, wipLimit: null, cardCount: 0, collapsed: false, archived: false, rev: '', cards: [], loaded: true, hasMore: false};
      setLanes(lanes => [...lanes, temp]);
      tracked(() => call<{lane: LaneT}>('POST', `/boards/${boardId}/lanes`, {name}))
        .then(res => setLanes(lanes => (lanes.some(l => l.id === res.lane.id) ? lanes.filter(l => l.id !== id) : lanes.map(l => (l.id === id ? res.lane : l)))))
        .catch(error => {
          setLanes(lanes => lanes.filter(l => l.id !== id));
          rollback(error, undefined, () => void addLane(name));
        });
    };

    /** Optimistic for quick toggles (collapse) and for the edit dialog; rejects so the dialog can show why. */
    const updateLane = async (laneId: number, patch: {name?: string; colorHex?: string | null; wipLimit?: number | null; collapsed?: boolean}) => {
      const before = get()?.lanes.find(l => l.id === laneId);
      const old: Partial<LaneT> = {};
      if (before) for (const k of Object.keys(patch) as (keyof typeof patch)[]) (old as Record<string, unknown>)[k] = before[k];
      setLanes(lanes => patchLane(lanes, laneId, patch));
      try {
        await tracked(() => call('PATCH', `/lanes/${laneId}`, patch));
      } catch (error) {
        if (before) setLanes(lanes => patchLane(lanes, laneId, old));
        throw error;
      }
    };

    const archiveLane = async (laneId: number) => {
      const all = get()?.lanes ?? [];
      const index = all.findIndex(l => l.id === laneId);
      const lane = all[index];
      setLanes(lanes => lanes.filter(l => l.id !== laneId));
      try {
        await tracked(() => call('POST', `/lanes/${laneId}/archive`));
      } catch (error) {
        if (lane) {
          markEnter(`lane-${laneId}`);
          setLanes(lanes => (lanes.some(l => l.id === laneId) ? lanes : [...lanes.slice(0, index), lane, ...lanes.slice(index)]));
        }
        throw error;
      }
    };

    /** The board's lanes as they are right now (the lane menu reads them when it opens). */
    const lanes = (): LaneT[] => get()?.lanes ?? [];

    /** Lane menu: a copy of the lane (with its open cards) right after it. The server decides the order, so the board reloads. */
    const copyLane = async (laneId: number, name: string) => {
      await tracked(() => call('POST', `/lanes/${laneId}/copy`, {name}));
      await queryClient.invalidateQueries({queryKey: key});
    };

    /** Lane menu: every open card to the end of another lane. Rejects (lane full, lane gone) so the dialog can say why. */
    const moveLaneCards = async (laneId: number, toLaneId: number): Promise<number> => {
      const res = await tracked(() => call<{moved: number}>('POST', `/lanes/${laneId}/move-cards`, {toLaneId}));
      await queryClient.invalidateQueries({queryKey: key});
      return res.moved;
    };

    /** Lane menu: archive every open card of the lane. Shown at once; a failure puts the cards back. */
    const archiveLaneCards = async (laneId: number): Promise<number> => {
      const before = get()?.lanes.find(l => l.id === laneId);
      setLanes(lanes => patchLane(lanes, laneId, {cards: [], cardCount: 0, hasMore: false, loaded: true}));
      try {
        const res = await tracked(() => call<{archived: number}>('POST', `/lanes/${laneId}/archive-cards`));
        return res.archived;
      } catch (error) {
        if (before) setLanes(lanes => patchLane(lanes, laneId, {cards: before.cards, cardCount: before.cardCount, hasMore: before.hasMore, loaded: before.loaded}));
        throw error;
      }
    };

    /**
     * Bulk bar: ONE action on the selected cards, all or nothing. Not optimistic: the board reloads from the server's
     * answer. Rejects so the bar can say why. The answer carries `undo` (the server's exact inverse steps) when there is one.
     */
    const bulkCards = async (cardIds: number[], action: BulkAction): Promise<BulkAnswer> => {
      const res = await tracked(() => call<BulkAnswer>('POST', `/boards/${boardId}/cards/bulk`, {cardIds, ...action}));
      await queryClient.invalidateQueries({queryKey: key});
      return res;
    };

    /** Take a bulk action back: the server's inverse steps one after the other; a card changed since is skipped. Never rejects. */
    const undoBulk = async (steps: readonly BulkUndoStep[]) => {
      const result = await runUndoSteps(steps, step => tracked(() => call<BulkAnswer>('POST', `/boards/${boardId}/cards/bulk`, step)));
      await queryClient.invalidateQueries({queryKey: key});
      return result;
    };

    /** Lane menu: re-order the lane's cards. The server renumbers them, so the board reloads. */
    const sortLane = async (laneId: number, by: 'name' | 'newest' | 'oldest' | 'due') => {
      await tracked(() => call('POST', `/lanes/${laneId}/sort`, {by}));
      await queryClient.invalidateQueries({queryKey: key});
    };

    /** Lane menu: this person's own pin and watch flags. Optimistic; a failure puts the old flags back. */
    const setLanePrefs = async (laneId: number, patch: {pinned?: boolean; watching?: boolean}) => {
      const before = get()?.lanes.find(l => l.id === laneId);
      const old = {pinned: before?.pinned ?? false, watching: before?.watching ?? false};
      setLanes(lanes => patchLane(lanes, laneId, patch));
      try {
        await tracked(() => call('PUT', `/lanes/${laneId}/prefs`, patch));
      } catch (error) {
        setLanes(lanes => patchLane(lanes, laneId, old));
        throw error;
      }
    };

    /** A lane's first or next cards (keyset). Quiet on failure: the "Show more" button is still there. */
    const loadLane = async (laneId: number) => {
      const lane = get()?.lanes.find(l => l.id === laneId);
      if (!lane || loading.current.has(laneId)) return;
      loading.current.add(laneId);
      setFailedLanes(prev => (prev.has(laneId) ? new Set([...prev].filter(id => id !== laneId)) : prev));
      try {
        const after = lane.loaded ? nextCursor(lane) : '';
        const res = await call<{items: CardT[]; next: string | null}>('GET', `/lanes/${laneId}/cards?after=${encodeURIComponent(after)}`);
        setLanes(lanes => mergeLanePage(lanes, laneId, res.items, res.next !== null));
      } catch (error) {
        // A lane that never loaded shows "Try again" in place of its skeleton; a later page toasts.
        if (lane.loaded) toast.danger(errorMessage(error));
        else setFailedLanes(prev => new Set(prev).add(laneId));
      } finally {
        loading.current.delete(laneId);
      }
    };

    const updateBoard = async (patch: {name?: string; visibility?: string; bgKind?: string; bgColor1?: string; bgColor2?: string; bgAngle?: number; archived?: boolean}) => {
      await tracked(() => call('PATCH', `/boards/${boardId}`, patch));
      const {archived, ...rest} = patch;
      set(data => ({...data, board: {...data.board, ...(rest as Partial<BoardT>), ...(archived === undefined ? {} : {archived})}}));
      void queryClient.invalidateQueries({queryKey: ['boards']});
      if (archived) void navigate({to: '/boards'});
    };

    /** A background photo, the three steps of docs/agent/files.md: ask, PUT the bytes to storage, confirm. */
    const uploadBackground = async (file: File) => {
      const grant = await tracked(() =>
        call<{uploadId: number; upload: Parameters<typeof putFile>[0]}>('POST', `/boards/${boardId}/background/upload`, {name: file.name, contentType: file.type, size: file.size})
      );
      const put = await putFile(grant.upload, file);
      if (!put.ok) throw new ApiError(put.message, put.status, put.code); // the unfinished row is swept after an hour
      const res = await tracked(() => call<{bgKind: string; bgImage: string | null}>('POST', `/boards/${boardId}/background/${grant.uploadId}/complete`));
      set(data => ({...data, board: {...data.board, bgKind: res.bgKind, bgImage: res.bgImage}}));
      void queryClient.invalidateQueries({queryKey: ['boards']});
    };

    const removeBackground = async () => {
      const res = await tracked(() => call<{bgKind: string}>('DELETE', `/boards/${boardId}/background`));
      set(data => ({...data, board: {...data.board, bgKind: res.bgKind, bgImage: null}}));
      void queryClient.invalidateQueries({queryKey: ['boards']});
    };

    const toggleStar = (starred: boolean) => {
      const was = get()?.board.starred;
      set(data => ({...data, board: {...data.board, starred}}));
      starChain.current = starChain.current.then(() =>
        tracked(() => call(starred ? 'PUT' : 'DELETE', `/boards/${boardId}/star`, starred ? {} : undefined))
          .then(() => queryClient.invalidateQueries({queryKey: ['boards']}))
          .catch(error => {
            if (was !== undefined) set(data => ({...data, board: {...data.board, starred: was}}));
            rollback(error, undefined);
          })
      );
    };

    /**
     * To ANOTHER board (the card keeps its id): not optimistic, the dialog waits on a pending button. On success the card
     * leaves this board at once and the target board reloads; a refusal is thrown for the dialog to show. No undo.
     */
    const moveCardToBoard = async (cardId: number, toBoardId: number, laneId: number) => {
      if (isTemp(cardId)) return;
      await tracked(() => call('POST', `/cards/${cardId}/move-to-board`, {boardId: toBoardId, laneId}));
      setLanes(lanes => removeCard(lanes, cardId));
      void queryClient.invalidateQueries({queryKey: ['board', toBoardId]});
      void queryClient.invalidateQueries({queryKey: key});
      // The server swapped the labels, dropped custom field values, the repeat rule and people without a seat: the open
      // panel (same card id, now on the new board) must reload them, not keep the old board's.
      void queryClient.invalidateQueries({queryKey: ['card', cardId]});
      void queryClient.invalidateQueries({queryKey: ['card-activity', cardId]});
      void queryClient.invalidateQueries({queryKey: ['card-recurrence', cardId]});
    };
    /** A copy lands last in the chosen lane of another board; that board reloads. This board is untouched. */
    const copyCardToBoard = async (cardId: number, toBoardId: number, laneId: number) => {
      if (isTemp(cardId)) return;
      const res = await tracked(() => call<{cardId: number}>('POST', `/cards/${cardId}/copy-to-board`, {boardId: toBoardId, laneId}));
      void queryClient.invalidateQueries({queryKey: ['board', toBoardId]});
      return res.cardId;
    };

    return {moveCard, moveCardToBoard, copyCardToBoard, moveCardAfter, moveLane, addCards, archiveCard, updateCard, addLane, updateLane, archiveLane, lanes, copyLane, moveLaneCards, archiveLaneCards, bulkCards, undoBulk, sortLane, setLanePrefs, loadLane, updateBoard, uploadBackground, removeBackground, toggleStar};
  }, [get, set, setLanes, rollback, rollbackWithRetry, boardId, queryClient, key, navigate, toast, errorMessage]);
  return useMemo(() => ({...api, failure, clearFailure, failedToken, failedLanes}), [api, failure, clearFailure, failedToken, failedLanes]);
}

export type BoardActions = ReturnType<typeof useBoardActions>;
