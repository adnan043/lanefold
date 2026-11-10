# Static QA findings (code reading, no browser)

Scope: QA-CHECKLIST sections 2 to 7 traced from `src/app/**` to the Site API shapes. Not browser tested.

## Checked and fine
- Every `to=` / `to:` in `src/app` points to a route in `routes.tsx` (boards, `/b/$boardId`, card child route, my-day, inbox, chat, members, join, onboarding, settings/*).
- Every literal `t('key')` in `src/app` exists in `en.json` (plural keys `card.comments`, `card.attachments`, `workspaceSettings.memberCount` exist as `_one/_other`). Dynamic keys (template strings) were not checked.
- Board writes (`boards/actions.ts`): optimistic moves, archives, adds and edits all roll back on failure; the Undo bar is dropped through `failedToken`; "Try again" is withheld for 403/409.
- Card writes (`cards/use-card.ts`): guarded fields use `expectedRev` with a refetch-and-retry on `stale`; checklist ticks roll back.

## Fixed in this pass
1. Card modal "Archive card" showed no toast and no Undo (the board's Undo bar is not mounted for the panel's own actions). Now a toast "Card archived." with Undo (`cards/card-panel.tsx`).
2. After a move, the board Undo bar and the card modal toast said "Move undone." (`card.moveUndone`) before anything was undone. They now say "Card moved." (key `polish.cardMoved` in `src/i18n/pending/polish.json`, English fallback via `tr`); the card modal toast also got an Undo action (`boards/canvas.tsx`, `boards/move-card.tsx`, `cards/move-popover.tsx`).
3. My Day stayed stale (30 s staleTime) after changing a card's done state, due date or assignees in the card modal: `useCardActions.send` now invalidates `['my-day']` (inactive queries only refetch when shown).
4. "Duplicate board" did not invalidate `['boards']`, so the copy was missing from `/app/boards` for up to 30 s (`boards/board-settings.tsx`).

## Fixed in a later pass (four items that were open here)
5. Card composer text is restored after a failed add: `addCards` in `src/app/boards/actions.ts` takes an `onFail` callback (passed through `lane.tsx`); the composer restores its text with a functional state update, so new typing is not overwritten (checked in `review-correctness-client-3.md`). Minor side effect noted there: using the restored text AND the failure bar's Retry adds the cards twice.
6. Workspace member count is refreshed after removing a member or accepting an invite: `['workspaces']` is now invalidated with `['members']` (`src/app/members/members-screen.tsx` lines 126 and 145, after removing a member; `src/app/members/join-screen.tsx` after accepting an invite).
7. A board opened after Inbox or My Day "done" / archive is no longer stale for about 5 s: those actions now also invalidate `['board']` (`src/app/inbox/inbox.tsx` lines 43 and 131, `src/app/my-day/my-day.tsx` line 47).
8. Checklist 3.2 now matches the New board modal: it says templates (Sprint, Content, Personal) are not in the modal and can be tried from the empty-state strip and onboarding, and that visibility is Workspace / Private with no public link (`docs/product/QA-CHECKLIST.md`). The modal (`boards/board-list.tsx`) was left as is.

## Remaining items (not changed)
- `card.moveUndone` ("Move undone.") is now unused; it could be shown as a toast when Undo is pressed.
- Move dialog: moving into a lane whose cards are only partly loaded can only choose among the loaded positions (hint `card.positionLoadedOnly` is shown); acceptable.
- Not verified without a browser: dialog focus traps, native `<dialog>` Esc handling over popovers, drag and drop with touch/keyboard, RTL, forced colours.
