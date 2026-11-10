import {createContext, useContext, useSyncExternalStore} from 'react';

/**
 * Card selection for the bulk bar. State only (never saved): which cards are ticked and whether the board is in select
 * mode. A tiny external store, so a click re-renders only the card whose tick changed, not the whole board.
 *
 * The pure helpers below carry the rules (range, prune, toggle) and are unit tested; `createSelection` wraps them.
 */

/** The most cards one bulk request carries (the server refuses more). */
export const MAX_SELECTED = 50;

/** Toggle one id: the next set and whether it was refused because the cap is reached. */
export function toggleId(current: ReadonlySet<number>, id: number): {ids: ReadonlySet<number>; capped: boolean} {
  const next = new Set(current);
  if (next.delete(id)) return {ids: next, capped: false};
  if (next.size >= MAX_SELECTED) return {ids: current, capped: true};
  next.add(id);
  return {ids: next, capped: false};
}

/** Shift-click: everything between the anchor and `id` in the on-screen `order` joins the selection (up to the cap). */
export function rangeIds(current: ReadonlySet<number>, order: readonly number[], anchor: number | null, id: number): {ids: ReadonlySet<number>; capped: boolean} {
  const to = order.indexOf(id);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  if (to < 0 || from < 0) return toggleId(current, id);
  const [a, b] = from <= to ? [from, to] : [to, from];
  const next = new Set(current);
  let capped = false;
  for (const wanted of order.slice(a, b + 1)) {
    if (next.has(wanted)) continue;
    if (next.size >= MAX_SELECTED) {
      capped = true;
      break;
    }
    next.add(wanted);
  }
  return {ids: next, capped};
}

/** Drop ids whose card is gone (archived, moved away, deleted by another person's sync). Same set when nothing changed. */
export function pruneIds(current: ReadonlySet<number>, live: ReadonlySet<number>): ReadonlySet<number> {
  let changed = false;
  const next = new Set<number>();
  for (const id of current) {
    if (live.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : current;
}

type State = {mode: boolean; ids: ReadonlySet<number>; anchor: number | null};

export type Selection = ReturnType<typeof createSelection>;

export function createSelection(order: () => readonly number[]) {
  let state: State = {mode: false, ids: new Set(), anchor: null};
  const listeners = new Set<() => void>();
  const set = (next: State) => {
    if (next.mode === state.mode && next.ids === state.ids && next.anchor === state.anchor) return;
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: () => state,
    has: (id: number) => state.ids.has(id),
    /** Turn select mode on or off; turning it off clears the selection. */
    setMode(mode: boolean) {
      if (mode) set({...state, mode});
      else this.reset();
    },
    /** Tick or untick a card (`range`: Shift-click, from the last ticked card). Returns true when the cap refused it. */
    toggle(id: number, range = false): boolean {
      const result = range ? rangeIds(state.ids, order(), state.anchor, id) : toggleId(state.ids, id);
      set({mode: true, ids: result.ids, anchor: id});
      return result.capped;
    },
    clear() {
      if (state.ids.size === 0 && state.anchor === null) return;
      set({...state, ids: new Set(), anchor: null});
    },
    /** Selection and mode both off (Esc, after a finished action). */
    reset() {
      if (!state.mode && state.ids.size === 0 && state.anchor === null) return;
      set({mode: false, ids: new Set(), anchor: null});
    },
    prune(live: ReadonlySet<number>) {
      const ids = pruneIds(state.ids, live);
      if (ids !== state.ids) set({...state, ids, anchor: state.anchor !== null && ids.has(state.anchor) ? state.anchor : null});
    },
  };
}

export const SelectionContext = createContext<Selection | null>(null);

/** The board's selection store, or null outside a board (the card faces in the table and calendar views). */
export const useSelection = () => useContext(SelectionContext);

/** Is this card ticked? Re-renders only when ITS answer changes. */
export function useIsSelected(id: number): boolean {
  const store = useSelection();
  return useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    () => (store ? store.has(id) : false),
    () => false
  );
}

/** Is the board in select mode? */
export function useSelectMode(): boolean {
  const store = useSelection();
  return useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    () => (store ? store.get().mode : false),
    () => false
  );
}

/** The ticked ids (a new set only when it changed). */
export function useSelectedIds(): ReadonlySet<number> {
  const store = useSelection();
  return useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    () => (store ? store.get().ids : EMPTY),
    () => EMPTY
  );
}

const EMPTY: ReadonlySet<number> = new Set();
const noSubscribe = () => () => {};
