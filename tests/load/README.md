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

## The full app session (Kanban + chat, local)

`app-user.js` is a signed-in person at the app's own rhythm: the board poll (5 s), the chat pulse (3 s with the chat
open, `CHAT_OPEN` share of users, else 30 s), the bell (30 s), and one action every 3–10 s (70 % reads, 20 % card
writes, 10 % chat messages with @mentions). Each user is its own test account, signed in once. It measures board sync
and chat delivery from send to seen by another user, and catches lost or duplicated messages.
`SCENARIO=hot` puts everyone on one board and one chat; `spread` gives teams of 10 their own workspace.

```sh
node --env-file=.env --import ./tests/load/lib/ts-hook.mjs tests/load/seed.mjs   # USERS=500 (10..500): accounts + LT-* workspaces
K6=/path/to/k6 tests/load/run-level.sh spread 50                                  # one level: 1 m ramp, 3 m hold, report
K6=/path/to/k6 tests/load/run-ladder.sh hot "10 25 50 100 250 500"                # levels in order, stops at a stop condition
node --env-file=.env tests/load/cleanup.mjs                                       # remove every test account and LT-* workspace
```

| File | What it does |
| --- | --- |
| `seed.mjs` / `cleanup.mjs` | test data: accounts by SQL (sign-up is rate limited per IP), everything else through the API; LOCAL databases only |
| `app-user.js` | the k6 session above; reads `.fixtures.json` (written by the seed, git-ignored) |
| `check.mjs` | after a level: lane counts, card positions, board revisions, message numbers, duplicates, lost messages |
| `run-level.sh` | one level + a monitor that stops k6 when this computer drops under `MIN_FREE_MB` (1000) free memory |
| `report.mjs` | the level's report, plus a row in `results/summary.md` (git-ignored) |

Stop conditions (status `STOP`): HTTP p95 over 3 s or errors over 5 %. Targets (status `FAIL` when missed): p95 < 500 ms,
p99 < 1 s, errors < 1 %, board sync p95 < 6 s, chat p95 < 4 s, no data issues. k6 exits 99 whenever ANY threshold
fails, targets included, so the stop conditions are judged from the numbers in `report.mjs`.

A local run measures this computer (one `workerd` process, Postgres in Docker), never the live site's capacity.
