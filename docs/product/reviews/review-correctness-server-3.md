# Correctness review, server (round 3)

Scope: chat.ts, card-detail.ts (seatFilter, label routes), soft-limit.ts, jobs/invite-email.ts, members.ts resend, files.ts.

## Fixed
- jobs/invite-email.ts: a job retry (thrown because ANOTHER invite in the batch was transient) re-processed invites already settled as `failed` (provider 4xx, bad seal, inviter lost role) and mailed them again, bumping `emailAttempts`. Now `failed` rows are skipped like `sent`. Safe vs resend: resend rotates the token and sets `queued` first, so a fresh send is never skipped. Test added in tests/invite-email-job.test.ts.

## Checked, no bug
- chat send: outcome order replay -> 429 -> 404(parent) holds; replay never writes; unique race (P2002) falls back to replay of the winner, else rethrows (500); mentions/cardRefs ids are deduped so P2002 cannot come from them; seq via atomic increment in the tx; read marker math clamps to [0, seq].
- linkableBoardWhere: admins see open boards (own Inbox or none); others also need non-private, own Inbox, or a seat. Correct.
- /chat/pulse: parallel reads fine; cap 200 ordered by conversationId (users with >200 conversations lose the newest from pulse; acceptable, minor).
- seatFilter: Inbox -> owner only; private -> owner/admin or board member; else all. Correct.
- label PATCH: readOnly blocks update, delete stays allowed (heals read-only), consistent with own-message delete.
- soft-limit: read-then-write race documented, fails open; correct for a cost guard.
- resend: only failed/not_configured, guarded again in the updateMany where (race-safe), enqueue failure restores `failed`. Old in-flight job is neutralised by the token hash check.
- files.ts cast: harmless.

## Minor, left
- Pulse still reports seq counts for a board chat whose board became private to the user (counts only, no content).
