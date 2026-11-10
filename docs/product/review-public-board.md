# Review: public board (`/b/:token`, `GET /site-api/public/boards/:token`)

Security (authorization first)
- Token: 43 base64url chars checked by regex, SHA-256 hashed, looked up by a unique index; the token is never stored, cached, logged or echoed. Lookup is by hash equality in the database (no secret-dependent compare in app code).
- Visibility is in the query `where` (public, not archived, not inbox, workspace not archived), always uncached, so revoke or going private is immediate. Cache key is `pubboard:<boardId>:<rev>` (ids only), reached only after that check.
- Every miss (malformed, unknown, private, archived, inbox) returns the same 404 body; the page renders the same NotFound.
- Leakage: explicit `select` lists; user query selects only `id, name`, names reduced to "First L."; no email, user id, comment, attachment, file id or chat in the payload. Descriptions are plain text and rendered escaped by Astro. Colours validated as `#RRGGBB` server and client; applied through the CSSOM (CSP-safe, no style attributes).
- Headers: `Cache-Control: private, no-cache`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex...`, page also `noindex` + referrer meta, no cookies read.

Fixed
1. HIGH (availability): `backend()` does not forward `cf-connecting-ip`, so every page visitor shared the `local` rate-limit bucket: 20 misses from anyone would 429 every viewer. The page now forwards the header (Cloudflare sets/overwrites it, so it cannot be spoofed in production).
2. `publicName` leaked an address typed in a later name part ("Maria a@b.com"): now null if any part has `@`.
3. DoS bounds: cards per lane 500 to 200, description 2000 chars, labels and members per card capped at 12, user lookup 5000; keeps the cached value under the 256 KB cache limit in normal use.
4. Cache TTL 1 h to 5 min: label, member-name and workspace-name edits do not bump `rev`.
5. Tests: second-name email, revoke/private shows 404 immediately.

Performance: 3 queries on a cold board (link check, lanes+cards+labels+members nested, users), 1 on a warm one; no N+1; all bounded.

Open
- Rate-limit counters are read-modify-write on the Site Cache (approximate under bursts); acceptable for guess-stopping.
- Outside Cloudflare (Preview) all callers share the `local` bucket.
- Lanes beyond 20 or cards beyond 200 per lane are silently omitted from the public view.
- Create/revoke share-link routes (separate agent) must bump `rev` is not needed, but must set `visibility`/`shareTokenHash` atomically and return the token once.
