# Client correctness review, round 2 (top 10)

Scripts (scratchpad): `res.mjs` resolves every `from '.../ui'` and `'.../ui/<file>'` named import under `src/` against the barrel and the files, and finds no missing names. `i18n.mjs` checks every `t('key')` and its placeholders against `messages/en.json`, with no missing keys or placeholders. The only catalogue gaps are the 4 plural `_one` keys that id, ja, ko, th, vi and zh do not need.

1. **A failed lazy chunk takes the whole shell down.** CONFIRMED, high. `src/app/shell.tsx:17-18,276-285`.
   - `React.lazy` has no error boundary, and the `Suspense` has only `fallback={null}`. Open the app, go offline, press Cmd/Ctrl+K or `?`. The import rejects and the throw reaches the router's `RouteError`. `lazy` also caches the rejection, so "Try again" cannot recover until a full reload.
   - Fix: make the loader catch and return `{default: () => null}` plus a toast ("Could not load, check connection") and reset `paletteOpen`. Or wrap each lazy widget in a small error boundary with a `null` fallback. The idle preload `void loadX()` should end in `.catch(() => {})`.

2. **Rollback restores a stale snapshot over later optimistic edits.** CONFIRMED, medium. `src/app/boards/actions.ts:89-96` (moveCard), `:129-135` (archiveCard) and `rollbackWithRetry`.
   - Move A, then move B or add a card while A is in flight. A fails and the whole `snapshot` is written back. B and the new card vanish locally, although B was saved on the server. The board shows the wrong state until the next sync tick.
   - Fix: on failure, revert only the card with an inverse move: `moveCardInLanes(... from.laneId, from.index)`, like `moveLane` and `revertLaneMove`. Do the same for archive, with `insertCard`.

3. **Board settings WIP loop attributes errors wrongly and can wipe limits.** CONFIRMED, medium. `src/app/boards/board-settings.tsx:89-103,61`.
   - `updateBoard` has already saved when lane PATCH number k fails. The catch calls `form.setServerErrors(fieldErrors(error))` (aimed at the name field) and shows a generic status. The drawer stays open without saying which lane failed, and `wipErrors` is never set.
   - A temporary lane (negative id, still saving) is in `shown`. The loop PATCHes `/lanes/-1`, so a 404 aborts the remaining lanes.
   - `wip` is initialised only when the drawer opens. A lane that arrives afterwards (sync or another user) has `wip[id] === undefined`, which reads as `''`, so `next=null !== lane.wipLimit`. Save then silently clears that lane's limit.
   - Fix: skip `isTemp` lanes. Compare only lanes present in `wip`. On a lane failure, set `wipErrors[lane.id]` and continue, or collect failures. Put the lane name in the status. Run the PATCHes through `Promise.all` in groups of about 5.

4. **Create-card dialog can show one board while submitting another.** SUSPECTED, medium. `src/app/chat/create-card-dialog.tsx:40-47,100`.
   - `boardId` starts as `defaultBoardId`. The `<Select>` options come only from the first page of `boardsQuery`, which probably excludes archived boards. If the default board is not in the list (more than one page, or archived), the native select shows the first option while state still holds the default id.
   - The user then creates the card on a board that is not shown, or sees the read-only notice with no way to tell why.
   - Fix: if `boardId` is not in `list`, set it to `list[0]`. Or add the default board to the options.

5. **A late profile GET overwrites the device's newer local choice.** CONFIRMED, medium. `src/app/settings/sync.ts:30-37`; `src/i18n/index.tsx:115`.
   - The profile is applied once. Change the theme or density in Settings before the GET returns and it is reverted. If the PATCH failed (offline), the next load applies the server value over the local one and rewrites the `lf_locale` cookie and `lf:theme`. The toast said "saved on this device".
   - Fix: mark a local "dirty" key set by `useSavePreferences` when a PATCH fails, and skip fields that are dirty. Also skip applying if the user changed a preference after mount (`mutation.isPending` or `isSuccess`).

6. **Undo clicked while the archive request is in flight does nothing.** CONFIRMED, low-medium. `src/app/boards/actions.ts:150-152`.
   - `run` returns early when `archiving.has(cardId)`, and the Undo bar disappears via `onDone`. The card stays archived with no feedback.
   - Fix: chain the restore after the archive promise (`archivePromise.then(() => restore)`), or keep the bar until `archiving` clears.

7. **Swatches are invisible in Windows High Contrast.** SUSPECTED, low-medium. `src/styles/forced-colors.css`; `board-settings.tsx` `Swatch` and `lf-swatch-preview`.
   - Board backgrounds, label dots and swatches use `background`, which forced colours drops. Only `.lf-swatch-dot` gets `forced-color-adjust: none`. The 13 board-colour swatches and the preview become identical empty buttons, labelled only by hex.
   - Fix: add `forced-color-adjust: none` and a `border: 1px solid CanvasText` to `.lf-swatch` and `.lf-swatch-preview`. Also add `.color-dot` and the label chips.
   - Also, `border: 1px solid` on `.segment`, `.switch`, `.cd-resize:hover` and similar adds 2px and shifts layout. Use `outline` or `box-shadow: inset` (inset shadows are removed too, so prefer a transparent border in the base rule).

8. **Move to... offers unmovable targets.** SUSPECTED, low-medium. `src/app/boards/move-card.tsx:67`; `move-target.ts:4-6`.
   - `lanes={data.lanes}` is not filtered the way `create-card-dialog` does (`!l.archived`). It also includes temporary lanes (negative ids), so the server answers 404 and the card rolls back.
   - Positions are counted among the loaded cards only. With a "Show more" lane, "last" is not the real end.
   - Fix: filter `!archived && !isTemp`. Note the limit in the position label, or load the lane first.

9. **Focus handling skips the heading when going card, then another board.** SUSPECTED, low. `src/app/shell.tsx:53-55`.
   - `wasPanel && onBoard` skips the `<h1>` focus on any card to board transition, including card to a different board (palette, notification). Focus then goes to the old opener or the document body, because the old panel's cleanup targets a card that is not on screen.
   - Fix: compare `boardId` params: skip only when it is the same board.

10. **Cmd/Ctrl+K gives no feedback while the chunk loads.** SUSPECTED, low. `src/app/shortcuts.tsx:38-42`; `shell.tsx:276-280`.
   - `Suspense fallback={null}` means a slow network shows nothing. A second press toggles `paletteOpen` back to false, so the palette never appears. It also opens over any open modal, because `togglePalette` runs before the dialog check.
   - Fix: a minimal fallback (a spinner in a dialog), and have Cmd+K only open while the chunk is pending. The locale catalog load in `i18n/index.tsx:100` also has no `.catch` (offline: unhandled rejection, stuck on English, no retry).

No problems found in: the barrel, i18n key and placeholder usage, the single `document` keydown listener (it registers once with live refs, and the palette has no listener of its own), `storedShortcuts()` read at event time, `failedToken` clearing the Undo bar, the plan-limit watcher, archived lanes restore (invalidates both queries), the setup checklist (keyed by workspace), and the onboarding double-submit (blocked by the disabled submit button).
