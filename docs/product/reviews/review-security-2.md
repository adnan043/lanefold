# Lanefold security review, round 2 (authorization first)

Read-only. Scope: what was added after round 1 (`board-extras.ts`, `card-detail.ts`, `chat-extras.ts`, `workspace-settings.ts`, `soft-limit.ts`, `notifications.ts`, `src/lib/markdown.tsx`, chat linkify and card chips, palette, settings sync, `seed-demo.ts`, checkout and thanks pages, join page, URL sinks). Round 1 findings are not repeated.

## Verdict
No Critical or High. No IDOR found. No XSS bypass found in the Markdown parser. One real open redirect (Low-Medium) and one abuse path in the notification cap (Medium-Low).

## Authorization (all clean unless listed)
- `card-detail.ts`: every route goes through `cardCtx` / `viaCard`, which puts workspace membership in the first query, then `boardAccess` (private boards) and `access.workspaceId === card.workspaceId`. Child rows (checklist, item, comment, attachment, label) are re-scoped by `workspaceId` and `cardId` in the write `where`. Comment edit is author-only; comment and attachment delete is author or board admin. Attachment `/view` checks access before it mints a 300 s link. Upload types are allow-listed, and SVG and documents always download (`files.md`). No finding.
- `chat-extras.ts`: `/conversations/:id` uses `conversationAccess`. `/members/search` has `requireWorkspaceRole('viewer')`, a tagged query, `likeEscape`, a limit of 20, and no email. `/cards/refs` puts the membership join, the private-board rule and the inbox rule in the WHERE, so ids the viewer may not see are simply absent. No finding.
- `board-extras.ts`: archived lists put the membership and private-board rule in the `where`, with `inboxOf: null`. No finding.
- `workspace-settings.ts`: rename needs admin. Transfer needs owner, takes a `FOR UPDATE` lock, and runs both role updates conditional on the expected roles in one transaction. The target must already be a member (`updateMany` on `workspaceId` + `userId`). Preferences are saved only for `viewer.id` and allow-listed. No finding.

## Findings

### 1. LOW-MEDIUM, open redirect: checkout "Go back" link accepts `/\evil.example` (CONFIRMED)
- `src/pages/checkout/index.astro:119`: `href={ask.cancelPath.startsWith('/') && !ask.cancelPath.startsWith('//') ? ask.cancelPath : '/'}`. `cancelPath` comes straight from `?cancelPath=` and is only guarded against `//`.
- Exploit: send a victim `https://site/checkout/?price=<real-price-key>&cancelPath=/\evil.example/login`. The page renders `<a href="/\evil.example/login">Go back and keep browsing</a>`. Browsers treat `\` as `/` in http URLs, so the click goes to `//evil.example/login`. It needs one click, but the link starts on the real site's checkout page, which makes it a good phishing hop.
- The server routes (`src/server/routes/checkout.ts:81`) already use `isSitePath`, which rejects `\` and whitespace. Only this page skips it.
- Fix: use `isSitePath(ask.cancelPath) ? ask.cancelPath : '/'` (import from `src/platform/payments`). Apply the same check to `successPath` before it is passed to `EmbeddedCheckout` and `CheckoutAskForm`.

### 2. MEDIUM-LOW, abuse: one member can mute a colleague's notifications for an hour (CONFIRMED by reading)
- `src/server/notifications.ts:25,57-63`: the cap of 60 per hour counts all of a recipient's notifications, whatever the actor. Over the cap, new ones are dropped silently.
- Exploit: a workspace member posts about 60 comments or chat messages that mention the victim (comments are limited to `commentsPerMinute` per author, so this takes a few minutes). After that, the victim's real mentions, assignments and replies from anyone else are silently dropped for the next hour. They get no signal that something was lost.
- Fix: make the cap per (recipient, actor), for example `WHERE user_id = u AND actor_id = ${actorId}`, and keep a looser global cap only for load. Alternatively, collapse repeated notifications from one actor on one card or conversation into a single row.

### 3. LOW, Markdown parser: no XSS bypass; one client CPU cost and one spoofing note (parser reviewed line by line)
- XSS, tried and failed:
  - `javascript:`, `data:`, `vbscript:` and protocol-relative targets. `safeUrl` (`markdown.tsx:33-50`) requires a literal `https?://` or `mailto:` prefix, rejects control characters, whitespace, `<>"` and the backtick, then returns the normalised `URL.href`.
  - Nested and balanced constructs (`[a]([b](x))`). Labels are parsed with `inLink=true`, so autolinks and links cannot nest inside a link.
  - Escapes. `\` only adds the next character to a text buffer.
  - Mentions. The `@name` text comes from server-supplied names and is rendered as a text node.
  - Output is React text children only. There is no `dangerouslySetInnerHTML` in `src/app`, `src/lib` or `src/i18n`. `set:html` appears only in `Base.astro:131` for JSON-LD from `jsonLdText`, which is not user data.
- `markdown.tsx:136-160` and `:103-135`: `[` and `*` openers scan up to `WINDOW` (2000) characters, and unmatched openers each rescan. A 20 KB body of `[[[[…` or `*a *a *a…` costs about 10^7 to 10^8 steps in the VIEWER's browser each time it renders (a hostile comment or description freezes the card panel for other members). SUSPECTED, not measured. Fix: cache "no closer after position p" for each mark, or cut `MAX_SOURCE` for comments to about 5000.
- Spoofing (no fix needed now): `[https://bank.example](https://evil.example)` shows one address and goes to another. Links open with `noopener noreferrer`. Optionally show the host next to the label.
- `src/app/chat/mentions.ts:79-97`: the chat linkify uses its own regex, not `safeUrl`. It requires `https?://`, so there is no script scheme. It does allow `https://user@host` and backslashes inside the href. This is a phishing nuance only. Reuse `safeUrl` for the chat href so the two renderers match.

### 4. LOW, `POST /boards/:id/duplicate` ignores the board-level role (CONFIRMED)
- `board-extras.ts:121` checks only the workspace rank (`>= 2`), not `access.canWrite`. A workspace member who is a board-level `viewer` on a private board can copy its lanes and settings into a board they own. It copies no cards, and they could already read the lanes, so the exposure is small.
- Also, `getEntitlements` blocks read-only workspaces but no board-count plan limit is checked, so a Free workspace can create up to 20 boards an hour by duplicating. Check this against the plan rules in `entitlements.ts`.
- Fix: `if (!access.canWrite || rankOf(access.workspaceRole) < 2)` and reuse the create-board plan check.

### 5. INFO, `soft-limit.ts` is fail-open and non-atomic (as documented in the file)
- It protects only the checkout (10 per 10 min) and search. `members.ts:411` also uses `softHit` for the invite-miss counter. That is fine only because invite tokens carry 43 random characters, so guessing is infeasible. Do not use `soft-limit` for anything where a burst matters, such as sign-in or password reset (those stay in `login_attempts`).

## Checked, nothing to report
- Settings sync (`src/app/settings/prefs.ts`, `sync.ts`): `data-theme`, `data-density`, `data-accent`, `data-font` and `data-motion` are set only from allow-lists (`THEMES`, `DENSITIES`, `ACCENTS`, `FONT_SCALES`), both when read from localStorage and when read from `GET /preferences`. The server also allow-lists `locale`, `themeMode` and `density` in `prefsBody`. Locale goes through `isLocale` before it reaches `root.lang` or the `lang-xx` class. A hostile stored value cannot inject an attribute or a class name. No `style=` is set.
- Palette (`src/app/palette`): navigates only with `navigate({to, params})` and numeric ids from the API. No external hrefs.
- Join page (`members/join-screen.tsx`): the token is validated with `TOKEN_RE` and POSTed in the body. Joining takes a button press. The token stays in the address bar after joining, so keep `Referrer-Policy: same-origin` or stricter (verify in `headers.ts`); the token is single-use or revocable per round 1.
- `/thanks/`: shows only what the platform confirmed (`status === 'paid'`). The retry link is `Astro.url.pathname + search`, a same-origin path with `Astro.url` already normalised, and `checkout` is passed to the backend as a param. Login `?next=` is checked by `nextPath` (`/\` and `//` are rejected).
- Link attachments are validated to http or https without credentials (`card-detail.ts:314-330`). Chat card chips are routed with numeric ids. The sign-in redirect in `shell.tsx` is built from `location` and URL-encoded.
- `scripts/seed-demo.ts`: refuses unless `DATABASE_URL` is localhost or 127.0.0.1 (line 91, 109), creates no user, and does no network call. No finding.
