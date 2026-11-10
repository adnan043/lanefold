# Client correctness review 3

Checked: nav.tsx, region-boundary.tsx (+5 usages), composers/actions, query invalidations, Menu Esc, account, import-export.

## Fixed
- Card panel RegionBoundary was not keyed: after a crash, opening another card kept the error fallback. Now `key={cardId}` (board-screen.tsx).
- Menu: Tab closed the menu without moving focus; the menu is portaled to body, so Tab continued from the end of the page. Tab now returns focus to the trigger (overlay.tsx), then the browser moves on from there.

## Verified OK
- nav.tsx: casts of the same TanStack Link/useNavigate/redirect, identical runtime (hash/search/params/replace/preload pass through). All route strings and param names (`$boardId`, `$cardId`, `$token`, chat `search.c`) match routes.tsx.
- RegionBoundary: retry resets state; settings routes each have their own wrapper (remount per route); board region keyed by view; chat keyed by conversation. Errors are logged (kind only) and not swallowed; the root boundary still catches errors outside the regions.
- Composer onFail: addCards is fire-and-forget, so onAdd resolves, text clears, then onFail restores via functional setState (does not overwrite new typing). Unmounted setState is harmless.
- Invalidations: prefix keys (`my-day`, `board`, `card-people`, `members`) match defined keys; inactive queries are only marked stale, so no refetch storm.
- Toast timer / Menu Esc (preventDefault + stopPropagation) fine.

## Minor, not changed
- After a failed add the text is restored AND the failure bar offers Retry: using both adds the cards twice (user choice, not a crash).
- import-export: switching workspace between file check and "Import" imports into the new current workspace; the dry run was for the old one (server still enforces limits).
