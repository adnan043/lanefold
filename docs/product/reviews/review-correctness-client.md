# Client correctness review (src/app, src/portal, src/lib, src/i18n)

Read-only review, top 10. Server response shapes were checked route by route against `src/app/api.ts`, `chat/api.ts`, `cards/use-card.ts`, `queries.ts`, `inbox/queries.ts`, `my-day/queries.ts` and `notifications/bell.tsx`. They all match: ids come back as numbers where typed as numbers, message and activity ids as strings, lists as `{items, next*}`, errors as `{error, message, fields}`.

i18n: scripts in the scratchpad found no missing keys and no placeholder-argument mismatches. The two "missing" hits (`card.comments`, `card.attachments`) are plural keys (`_one` and `_other`) and resolve correctly. Dynamic keys all have a matching prefix.

Routes: every `to:` and `<Link>` path matches `routes.tsx` (`/b/$boardId`, `/b/$boardId/c/$cardId`, `/chat?c=`, `/members`, `/join/$token`, `/settings/*`). The join links built in `onboarding.tsx` and `invite-modal.tsx` use `/app/join/<token>`, which matches the basepath.

## Findings

1. **Board sync loop multiplies on focus and visibility events** (`src/app/use-board-sync.ts:56-75`). SUSPECTED, medium.
   - Scenario: `wake()` clears `timer` and calls `tick()`. If a `tick` is already awaiting `rev` or `changes`, that old tick still calls `schedule()` when it finishes, and so does the new one. Each focus or visibilitychange during an in-flight tick leaves one extra permanent poll chain. After a few tab switches, polling runs at 2x to 4x the intended rate. The server rate limit or the 5 s budget gets hit, and failure backoff is per chain.
   - Fix: add a `running` flag. `wake` returns if `running`, and `tick` sets and clears it. Call `clearTimeout(timer)` inside `schedule()` so there is only ever one timer.

2. **Setup checklist ignores its saved state on direct load** (`src/app/setup-checklist.tsx:25`). CONFIRMED, medium.
   - Scenario: open `/app/my-day` directly. `MyDay` mounts before `workspacesQuery` resolves, so `useState(() => read(workspaceId))` runs with `workspaceId = 0` and reads `lf:setup:0`. A dismissed checklist, or ticked steps, reappear on every reload. The state is also never re-read when the workspace is switched, and `save()` then writes the previous workspace's state under the new key.
   - Fix: `<SetupChecklist key={workspaceId}>`, rendered only once `current` is known, or re-read in an effect on `workspaceId`.

3. **Card panel is not keyed by `cardId`** (`src/app/cards/card-panel.tsx:263`, route `cardRoute`). SUSPECTED, medium-high if it does not remount.
   - Scenario: with card A open and "Edit description" in progress (`editing` and `draft` are local state), click card B on the board. Only the route param changes. If the matched component is not remounted, the A draft stays in the editor. Saving calls `actions.patchDetails` bound to B and overwrites B's description with A's text. Comment and checklist composer drafts leak the same way. `opener` also keeps the first card.
   - Fix: wrap it as `function CardPanel(){const {cardId}=useParams(...); return <CardPanelInner key={cardId} />}`.

4. **A chat notification from another workspace opens an empty "pick a conversation" pane** (`src/app/chat/chat-screen.tsx:79-80`, `src/app/notifications/bell.tsx:go`). CONFIRMED, medium.
   - Scenario: the bell lists notifications across all of the user's workspaces. Clicking a `message_mention` from workspace B while workspace A is current navigates to `/chat?c=<id>`. `byId.data.workspaceId !== workspaceId`, so `fetched` is null and the empty pane shows. Nothing switches the workspace, unlike the board screen, which calls `setCurrentId`.
   - Fix: in `Chat`, add an effect that calls `setCurrentId(byId.data.workspaceId)` when it differs. Alternatively, have `go()` fetch the conversation first.

5. **`localStorage` is read unguarded in route loaders** (`src/app/routes.tsx:68` and `:105`, the `/boards` and `/inbox` loaders). CONFIRMED, low-medium.
   - Scenario: with storage blocked (private mode, blocked site data), `getItem` throws a SecurityError inside the loader. The route shows `RouteError` instead of the Boards or Inbox screen. Every other storage access in the app is wrapped, and `workspace.tsx` has a guarded `remembered()`.
   - Fix: export `remembered()` from `workspace.tsx` and use it in both loaders.

6. **Undo after a failed archive or move can delete a card from the view** (`src/app/boards/actions.ts` `archiveCard.run` and `moveCard`; `board-screen.tsx` `UndoBar`, 8 s). SUSPECTED, medium.
   - Scenario: archive fails (offline or 409), the snapshot is restored and a retry toast appears. The Undo bar stays for 8 s. Clicking Undo calls `insertCard` (a duplicate or no-op) and then `/restore`. That fails because the card was never archived, and the catch runs `removeCard`, so the card vanishes locally until the next sync.
   - Fix: record `failed = true` in the original call's catch and make `run` return early. Better, call `clearUndo` from the failure path.

7. **Sending a message advances `known` past other people's newer-than-known messages** (`src/app/chat/use-message-feed.ts`, `transmit` calling `setKnownSeq(res.message.seq)`). CONFIRMED logic, low-medium.
   - Scenario: known=10. Someone else posts 11, then you send and get seq 12. `known` becomes 12, so the next `after=12` poll never returns 11. It only shows up when `refreshWindow` runs (every 20 s, newest 50 only). For a thread with a quiet `pollMs` it is the same.
   - Fix: after a send, call `poll()` and merge. Only advance `known` when `res.seq === knownRef.current + 1`.

8. **Failed "Load older" leaves a stale scroll anchor** (`src/app/chat/conversation-view.tsx`, the `anchor.current` set in the button `onClick`). CONFIRMED, low.
   - Scenario: `loadOlder` fails, so `olderError` is set and no messages were added, but the anchor stays. The next new message runs the anchor branch of the layout effect. It adds the height delta to `scrollTop` and skips stick-to-bottom, so the list jumps and the reader misses the new message.
   - Fix: clear `anchor.current` when `loadingOlder` goes false with no change in `total`, or set it inside `loadOlder` after success only.

9. **Inbox shows "Inbox is empty" while the workspace is loading or has failed** (`src/app/inbox/inbox.tsx`, `query.isPending && workspaceId > 0`). CONFIRMED, low.
   - Scenario: on a direct load, `workspaceId` is 0 and the query is disabled, so `isPending` is true but the guard is false. The code falls through to `items.length === 0` and shows the empty state plus a hint to capture. If `/workspaces` errors, it stays like that forever with no retry. The `inbox` and `setup-checklist` screens have the same `workspaceId > 0` pattern.
   - Fix: show `LoadingBlock` when `workspacePending || (workspaceId > 0 && query.isPending)`, and an error note when the workspace read fails.

10. **Whole-snapshot rollbacks and a few small races** (`src/app/boards/actions.ts` `rollback`, `updateLane`, `archiveLane`; `use-card.ts` `toggleItem`; `toggleStar`; `parts.tsx` `useAction`). SUSPECTED, low.
    - Scenario: a failure restores the entire board or card snapshot, so two quick edits revert together and other optimistic changes made since the snapshot are lost until the next rev poll. Double-clicking the star can send PUT and DELETE out of order with no in-flight guard. `useAction` has one `busy` id, so a second concurrent `run` frees the first row's pending state early.
    - Fix: revert only the touched entity (the pattern `updateCard` already uses). Guard `toggleStar` with an in-flight ref. Track busy as a Set.

## Checked and fine

- Pulse, notification-count and `useVisibleInterval` timers: all have cleanup. The pulse backs off to 30 s on errors.
- `useBoardSync` stops on a 404 and invalidates the board query. `BoardScreen`, `CardPanel` and `BoardChat` all handle 404 and error states, so none gets stuck in loading.
- `AppRoot` is `client:only`, so there is no hydration mismatch for `/app`.
- Query keys: `members`, `join-links`, `invites`, `boards`, `board`, `inbox`, `my-day`, `notifications` and `archived-*` are invalidated after their writes.
- Minor, not ranked: the role change and member removal do not invalidate `['chat','people',ws]` (5 min stale), so a removed member can still appear in the mention picker. The server re-validates mentions.
