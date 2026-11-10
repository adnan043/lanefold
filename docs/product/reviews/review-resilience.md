# Client resilience review (/app)

Scope: `src/app/api.ts` (`call`), `AppRoot.tsx` (query client), `use-board-sync.ts`, `src/i18n/errors.ts`, shell.

## Already fine
- 401 `token_expired`: `siteFetch` refreshes once (shared, cross-tab lock), replays the request.
- Signed out: shell redirects to `/account/login/?next=<path+query>`.
- 409/limit codes: `PLAN_LIMIT_CODES` + `plan-limits.tsx` toast with "See plans"; `errors.*` keys exist for them.
- 422: `fields` / `fieldCodes` land on fields through `useI18n().fieldErrors`.
- Board poll: backoff 5 s to 60 s with jitter, pauses when hidden, 404 stops and reloads.
- Palette handles 429 with a cool-down; writes are wrapped in `tracked`.

## Gaps found and fixed
1. A 401/403/404/429/5xx without a JSON `error` code (managed guard, proxy, platform outage) showed English "Request failed (N)". `call` now defaults the code from the status (`codeForStatus`), so the existing `errors.unauthorized|forbidden|not_found|rate_limited|server|network` keys apply.
2. `Retry-After` was dropped. `ApiError.retryAfter` (seconds, capped 300) now carries it.
3. Retry policy: before, any non-4xx error retried once with the default delay. Now `shouldRetryQuery` (network: 2 retries; 502/503/504: 1; 4xx and 500: none) with exponential backoff and jitter (`retryDelay`). Mutations are explicitly `retry: false` (no double submit through retry).
4. A 401 during a mutation or a read (after the refresh failed) only showed a toast; the shell learned of it up to 60 s later (`me` staleTime). `AppRoot` Query/Mutation caches now invalidate `['me']` (throttled 5 s) so the shell redirects with the return path. The board poll does the same and stops polling on 401.
5. Offline: key `sync.offline` existed but nothing showed it. `offline-banner.tsx` (UI-kit `Notice`, warning tone) shows while `navigator.onLine` is false; queries recover through the backoff.

Tests: `tests/resilience.test.ts` (status-to-code incl. catalog existence, Retry-After, retry policy, delay, session lost).

## Not changed / report
- No missing i18n keys.
- Unsaved-draft protection on a forced sign-in redirect: per-form drafts now exist for the card description, a new comment, adding a checklist item and a lane rename (`src/app/draft-store.ts`), besides the composer's own restore. Other forms (for example other card or lane edit drawers) still lose unsent input on redirect.
- 429 `Retry-After`: `ApiError.retryAfter` is now used. The 429 wait exists in `src/lib/cooldown.ts`, so an action is disabled for the wait instead of only the palette backing off. Screens that do not use it yet re-enable on failure as before.
- Double-submit: relies on each form's `Button pending`; not audited screen by screen.
- Build, tsc over the whole project and integration tests were not run (instructed); only the new unit test was run (8 pass).
