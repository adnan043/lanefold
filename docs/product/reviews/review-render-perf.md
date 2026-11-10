# Render performance review: board canvas, table, calendar (code reading only)

Scope: `src/app/boards/*` for ~500 cards in ~8 lanes. No browser, build or tests were run.

## Fixed (behaviour unchanged)
1. `lane.tsx`: `SortableContext items={visibleCards.map(...)}` built a new array every render. dnd-kit then publishes a new
   context value and re-renders every `useSortable` consumer in the lane, bypassing `memo(SortableCard)`. Now `useMemo` on `visibleCards`.
2. `canvas.tsx`: the same for the lane id list (`laneIds`), and `accessibility` is memoized.
3. `canvas.tsx`: sensor options were inline objects, so `useSensor`/`useSensors` rebuilt sensors each render. Now module constants.
4. `card.tsx`: `CardFace` is `memo`; the drag grip element is `useMemo`'d (it was a fresh element each render, which would defeat the memo).
   Dnd-kit re-renders every card's `useSortable` on drag moves; now the card body (labels, meta, Menu, avatars) is skipped.
5. `canvas.tsx` + `lane.tsx`: `LaneColumn` is `memo`; the `drag` prop is shared by all lanes the card is not over (`dragIdle`), so
   only the lane entered or left gets a new prop (was a fresh object per render for all lanes).

## Checked, fine
- Intl formatters are cached (`i18n/format.ts` map); the table's `Intl.Collator` is created once per sort, not per row.
- I18n context value and `t` are memoized; lane/card handlers keep one identity (`board-screen.tsx` ref pattern, `cardHandlers`).
- `Menu` adds document listeners only while open; no per-card observers or listeners. Keys are stable ids everywhere.
- `moveCardInLanes` keeps untouched lanes and cards by identity, so the draft during a drag does not invalidate memo.
- Table: rows and sort are `useMemo`'d. Calendar: grouping, weeks, agenda are `useMemo`'d.
- Lane paging: cards load by keyset page (`loadLane`), "Load more" appends; first page loads once per lane (`loading` ref guards).

## Remaining (not changed, small or risky)
- No windowing: a lane with many loaded pages renders all its cards (`@tanstack/react-virtual` not installed; no new deps). Page size
  bounds the cost; consider windowing only if lanes routinely hold 300+ cards.
- `matchFn` in `board-screen.tsx` depends on `query.data`, so each sync poll with an active filter makes a new predicate and
  re-filters every lane (one pass over loaded cards, `fold` normalizes per card). Fine at 500; caching folded titles would help beyond that.
- `filteredData` (table/calendar) rebuilds all lane copies on each data change; table/calendar are not memoized per row/day
  (`DayCell`, `CardChip` use `useDroppable`/`useDraggable`, so memo would not stop dnd-kit context re-renders anyway).
- `DataTable` renders all rows without windowing.
- `canvas.tsx` `activeCard` does a `flatMap` over all cards per render while dragging (500 items, negligible; `findCard` would avoid it).
- Per card, `todayISO()` runs only for dated, incomplete cards; negligible.
