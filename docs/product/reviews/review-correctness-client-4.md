# Review: client correctness and privacy (round 4)

Fixed
- Draft privacy: keys had no user id and sessionStorage survives a user switch in one tab (the Preview's cookie jar proves the tab outlives sign-ins). Keys are now `lf:draft:u<userId>:<workspace>:<kind>:<id>`; hooks are off until the user id is known; `clearAllDrafts` runs on sign-out in `src/app/shell.tsx`. Test: `tests/draft-user-scope.test.ts`.
- `useCooldown` (`src/portal/ui/cooldown.ts`): the countdown stalled (a setTimeout keyed on `left` does not re-run when the recomputed value is equal, so `blocked` stuck for the 500 ms-granularity tick). Now an interval while blocked; interval cleaned up.

Checked, fine
- Drafts hold only `{t, at}`; 24 h TTL, 20k cap, pruned once per load; restore only into an untouched field (`restoreDraft`); StrictMode double effect is safe (restore re-queued setValue, save effect re-writes).
- Workspace separation is in the key. Lane dialog waits for `syncedId`, so no cross-lane write.
- retry policy: 4xx never retries, writes never retry, 401 check throttled 5 s; board sync stops on 401/403/404, clears timers and listeners.
- `parseRetryAfter`/`cooldownMs` cap and validate; `useWriteCooldown` unsubscribes.
- Minor, left: a draft is lost from `usePeekDraft` if `me` is not yet loaded at first render (shell loads it first, so rare). Hard sign-out elsewhere (other tab) leaves drafts, but they are user-keyed now and expire in 24 h.
