# Client correctness review 5 (src/app)

Read: chat (use-message-feed, conversation-view, composer), boards (canvas, lane, saved-filters, archive-panel), cards (use-card, comments, checklists, attachments), inbox, my-day, notifications panel. Rounds 2-4 findings not repeated. `npx tsc --noEmit` is clean.

## Fixed
- Thread panel was not keyed: with a thread open, clicking Reply on another message reused the same `ThreadPanel`, so the reply composer kept its text, picked mentions and card chips and sent them into the NEW thread. Now `key={parent.id}` (chat/conversation-view.tsx).
- Archive drawer (cards, lanes, boards): a failed "Load more" (or a failed background refetch) replaced the whole list with an error and no retry. Now the error shows only when nothing is loaded; otherwise the list stays and "Load more" retries (boards/archive-panel.tsx).
- My Day: a failed background refetch (data kept by `keepPreviousData`) replaced the list with the error. Now the error shows only when there is no data (my-day/my-day.tsx).

## Verified OK
- use-message-feed: generation guards on load/poll/refresh/older; `busy`/`refreshing` flags reset in `finally`; failed send keeps `clientId` for retry; gap polling after send.
- canvas drag: drop reads `draftRef`, sync pause always resumes (drop, cancel, unmount); same-lane index maths against the lane minus the card.
- use-card: guarded writes serialized, stale-409 retry only when guarded fields unchanged; checklist toggle rollback is per item.
- Lane first-load effect cannot loop (keyed on loaded/id); saved-filters, inbox, notifications mutations invalidate matching keys and reset pending in onSettled.

## Minor, not changed
- Lightbox (cards/attachments.tsx): if the open image is removed elsewhere, `index` can point past `images`; the modal closes but the arrow handler stays until the parent resets. Cosmetic.
- Inbox MoveModal keeps the previously chosen board/lane after a successful move (only Cancel resets them).
- A cross-lane drop onto the lower half of a card can resolve to the card's own index when `over` is a card (onDragEnd re-derives index); not reproduced.
- Lane collapse state is read once per mounted lane id, so a temp lane that becomes real does not carry a collapse choice.
