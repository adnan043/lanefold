# Lanefold: handoff (decisions made after the spec was written)

Read with `docs/product/SPEC.md` and the template's `AGENTS.md`. Where this file and SPEC.md differ, **this file wins** on the points below. AGENTS.md still wins over both.

## 1. Goal
- Ship the **MVP (Phases 0 to 4b)** in about one day using several parallel agents. Phases 5 to 10 come the next day.
- Owner: Arif. Wants regular daily use by his team, so everything needed for that must be in the project.

## 2. Payments: changed from the spec
- **Payments exist from day one.** `app_settings.billing_mode` defaults to **`PAID`** (spec said `FREE_FOR_ALL`). The admin switch still exists.
- **Sandbox only.** No real gateway, no real money. Show `TestModeBadge` wherever checkout appears.
- **All state in our own database:** `plan_limits`, `workspaces.plan`, platform `orders` and `memberships`.
- New **Phase 0.7** (right after 0.5), moved up from Phase 9: plans and `plan_limits` seed, `getEntitlements()`, sandbox prices (`npm run platform -- prices add --key pro-monthly ...`), `POST /site-api/workspaces/:id/billing/checkout`, `onMembershipChanged` hook, upgrade UI, billing screens in `/dashboard`.
- Plans stay flat per workspace: Free (10 members, 10 MB files, 1 GB), Pro (50, 100 MB, 20 GB), Team (100, 100 MB, 100 GB, audit log, roles). Editable by the owner.
- Because limits apply from the start, the owner's own test workspace should be moved to Team through the sandbox checkout.
- Phase 9 keeps only: pricing page, landing page, tests for both billing modes.
- Going live later = connect a gateway (owner action). No code change expected.

## 3. Parallel work plan
**Wave 0 (one agent, 2 to 3 h):** Phase 0, 0.5, 0.7. This agent creates every shared file and **writes all Prisma migrations for the MVP in one go, one at a time** (boards, cards, chat, notifications, billing). Also: `/app` host page and shell, `membership()` helper, i18n scaffold, theme tokens, `app.ts` route lines for all planned route files (can be empty stubs).

**Wave 1 (3 to 4 h):**
| Agent | Work | Touches only |
|---|---|---|
| 1 | Phase 1: boards, lanes, cards, dnd, sync | `src/app/boards/**`, `src/server/routes/boards.ts` |
| 2 | UI kit: command palette, popover, color picker, date picker, chips, avatar stack | `src/portal/ui/**` |
| 3 | i18n catalogs for the 19 non-English launch languages (SPEC §11), key-parity test, RTL CSS (ar, ur, fa), per-locale lazy fonts | `src/i18n/**` |
| 4 | Marketing pages and `/dashboard` Billing, Plan limits, Workspaces screens | `src/pages/**` (public), dashboard screens |

**Wave 2 (3 to 4 h, after Wave 1 merges):** Phase 2 card panel and files, Phase 4b chat, Phase 4 invites, roles, notifications.

**Wave 3 (2 to 3 h):** Phase 3 (search, Cmd+K, My Day, Inbox), integration fixes, full tests.

**Rules for parallel agents**
- One git worktree and branch per agent (`git worktree add ../lanefold-chat -b feat/chat`).
- **One separate local Postgres database per worktree** (integration tests empty the DB).
- No new migrations outside Wave 0 unless the owner approves; if one is needed, ask first.
- In `src/server/app.ts` add only your own `.route()` line.
- Each agent stops when its assigned work is done and does not start another phase. (This replaces "finish a phase and stop" in the start prompt.)
- Merge one branch at a time into `main`, running `npm run build && npm test` after each.
- Realistic limit is the owner's RAM and review time: 3 to 4 agents at once, not 6.

## 4. Unchanged from the spec (reminders)
- Template rules win: no Tailwind, shadcn, Zod, lucide-react, sonner, date-fns, nanoid, cmdk, no second UI kit. Build missing UI in `src/portal/ui/`.
- Approved packages (owner to confirm before install, exact versions, lazy import): `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `fractional-indexing`, `@tanstack/react-virtual`, `marked`.
- Never edit `src/platform/**` or `docs/agent/**`. Never write auth code. Never create an admin. Do not start a dev server.
- Real-time is polling (no WebSockets). No invite or notification emails in the MVP (invite emails are Phase 11, notification emails Phase 12 after real use; email-to-board is not planned). Files need the Storage add-on turned on by the owner.
- UI language: vocabulary Workspace, Boards, Lanes, Cards, Flows, Add-ons, My Day, Inbox, Chat. Code says `lane`.

## 5. Spec edits to apply (not yet done)
1. SPEC §10: billing default `PAID`, sandbox only, flat plans, Phase 0.7.
2. SPEC §15: add Phase 0.7; trim Phase 9; replace the stop rule as in section 3.
3. Start prompt: add this line: "Billing is PAID from day one using sandbox payments only. Build plans, limits, checkout and upgrade UI in Phase 0.7. Show TestModeBadge where checkout appears." Also read this handoff file.

## 6. Owner actions
1. Confirm the optional dependencies.
2. Turn on Storage and a pack.
3. Set `SITE_OWNER_EMAILS`.
4. Create a local Postgres database per worktree.
5. Later: live payment gateway, native-speaker review of the 19 non-English catalogs, raise the background job rate if needed.

## 7. Open points
- Time estimates (30 to 50 h sequential, 12 to 16 h parallel) are rough guesses.
- Machine-translated catalogs must be marked `needsReview`.
- Phases 5 to 12 not scheduled yet. Run the team on the MVP for about two weeks before choosing what comes next.
