# Security review 4: members, workspace settings, billing, checkout, payment hooks, entitlements

Scope: src/server/routes/{members,workspace-settings,billing,checkout}.ts, src/server/{payments-hooks,entitlements}.ts (plus workspaces.ts guards).

## Authorization table
| Route | Who | Object-level |
| --- | --- | --- |
| GET members | member (viewer+) | workspaceId from guard; masked email only for admin+ |
| PATCH/DELETE members/:userId | admin+ | `canManageMember` + `canGrant`; self change refused; conditional updateMany on the read role |
| POST leave | member | last owner refused inside the locked transaction |
| join-links / invites list, create, revoke, resend | admin+ | `workspaceId` in every where; owner-made rows only revocable by owners |
| POST invites/accept | signed in | token hash lookup; generic 404; per-user miss limit; seat taken atomically; removal marker |
| PATCH workspace, transfer, archive, restore | admin / owner / owner / owner | owner role IN the where for archive and restore; transfer in one locked transaction |
| billing GET, checkout (workspace) | viewer / admin+ | workspace guard; price key from our table; customerRef set server-side only |
| billing settings, plans, staff list | `site:billing:manage`, `site:plans:manage`, `site:workspace:read` | staff list audited, no emails |
| checkout (generic), memberships | public / signed in | plan price keys refused; memberships limited by `visibleTo`; cancel re-checks admin/owner |

Masked emails: only `maskEmail` for admin+, invites store an HMAC hash only. Timeouts: platform client uses `AbortSignal.timeout`; the superseded-plan loop is bounded (5).
Payment hooks: order and membership writes are upserts with P2002 handling, stale events ignored, refunded is final, plan change is a conditional updateMany.

## Findings fixed
1. **Privilege escalation (members.ts, accept)**: a join link or invite that grants `admin` stayed valid after its maker was demoted or removed, so a demoted admin could still mint admins (or hand an accomplice an admin seat) with an old link. Now, for role `admin`, accept requires the maker to be an admin or owner at that moment (otherwise the generic 404). Tests: `tests/integration/review4-members.test.ts` (skipped without `TEST_DATABASE_URL`; none was available, so they did not run).
2. **Client metadata could carry `workspaceId` / `plan` (checkout.ts)**: the refund hook reads `workspaceId` from order metadata to cancel a plan subscription. The generic checkout now drops those two keys from the browser's metadata.
3. **No rate limit on starting a generic checkout (checkout.ts)**: signed-in buyers now limited to 20 per 10 minutes (soft limit, like the workspace checkout).

## Left open (minor)
- Anonymous generic checkout and `GET /checkout/:id` (an unguessable id acts as the capability) have no per-visitor limit: the IP is not available to the soft limiter.
- `createdRecently` / `emailLimited` counts are read-then-write, so a burst can slip a few over the hourly caps.
- `applyWorkspacePlan` reads then writes conditionally; two simultaneous events could settle on a slightly stale plan until the next event or the daily sweep.
- A non-admin (member) link made by a since-removed admin still works for members/viewers (owner can revoke); only admin-role links are now tied to the maker's current role.

## Performance
Main routes use 2 to 4 sequential round trips (guard, entitlements read in parallel with cached settings, write). No N+1 (invite-email and members list use one `in` query). Keyset paging everywhere; billing mine capped at 50.
