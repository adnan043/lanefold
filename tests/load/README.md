# Load tests (k6)

Run with [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/), not `npm test` (vitest only
runs `*.test.ts`). The `k6-load-testing` skill in `.claude/skills/` explains k6 itself.

| Script | What it does |
| --- | --- |
| `public.js` | a signed-out visitor: marketing pages, blog, sitemap, `/site-api/health`, `/me`, `/site` (and a shared board with `PUBLIC_BOARD_TOKEN`) |
| `signed-in.js` | a signed-in person: `/me`, workspaces, a workspace's boards, a board (`LOAD_EMAIL`, `LOAD_PASSWORD`: a test account without two-step sign-in) |

```sh
BASE_URL=http://localhost:4321 k6 run tests/load/public.js                 # smoke (default)
BASE_URL=http://localhost:4321 PROFILE=load k6 run tests/load/public.js    # smoke | load | stress | spike | soak
BASE_URL=http://localhost:4321 VUS=200 k6 run tests/load/public.js         # any number of users: 1 m ramp, HOLD (3m), 30 s down
```

- `BASE_URL` is required: no default, so nothing hits the live site by accident.
- Anything heavier than `smoke` against an address that isn't local needs `CONFIRM_LIVE=yes`.
  On the live site every request costs real, billed database queries: agree on a time and size first.
- Start with `smoke`. Never load-test from the editor sandbox (it shares the machine with the Preview).
- Sign-in, sign-up and code requests are rate limited on purpose: don't put them under load,
  you'd only measure the limits.
