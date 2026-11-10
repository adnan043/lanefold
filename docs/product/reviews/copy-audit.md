# Copy audit (read-only review, 2026-11-03)

Scope: `src/i18n/messages/en.json`, `src/content/site.ts`, `src/content/blog/*.md`, JSX literals in `src/app` and `src/portal`. Ordered by severity.

## Claims the product cannot back (fix first)

1. `site.ts` HOME.features.items[5] "Import from Trello / Bring your boards over from a Trello export and keep going." No Trello import exists in `src/app` or `src/server`. The blog post `moving-from-trello-to-lanefold.md` says it is "not available yet" (a direct contradiction).
   Proposed: replace the tile with "Roles and access" detail or "Keyboard first: command palette and shortcuts". If kept, "Import from Trello (planned)" is still not advisable on a features grid.
2. `site.ts` HOME.how.steps[1] "...or import an existing board." Proposed: "Make lanes for your process and add your first cards."
3. `site.ts` PRICING.plans[0].features "Import from Trello". Remove (also listed as a Free-plan feature). Proposed: "Keyboard shortcuts and command palette".
4. `site.ts` ABOUT.sections[1] "...and you can bring a board over from a Trello export." Remove; proposed: "Roles control who can do what."
5. `site.ts` HOME.faq / SITE.description says "boards, cards and team conversation"; fine. But check "Pro and Team raise the member and storage limits": Pro/Team data is correct, no issue. Flows and Add-ons are NOT mentioned in public copy (good); `common.comingSoon` exists, so check it is not shown for Flows/Add-ons in nav.
6. `site.ts` HOME.visual lane card "Import a Trello board" (illustrative card). Change to "Write the launch checklist" to avoid implying the feature.

## Terminology and consistency

7. `onboarding.intent.personal.desc` "Starts with To do, Doing, Done." vs `boards.lane.doing` "In progress" (and the hero visual "In progress"). Proposed: "Starts with To do, In progress, Done." Also "Keep your own tasks in order" and `onboarding.board.personal` "My tasks": task vs card. Proposed: "Keep your own cards in order." / "My cards" (or "Personal"). `card.addPlaceholder` "What needs doing?" is fine as an example.
8. team vs workspace: `chat.groupPlaceholder` "Launch team", `onboarding.namePlaceholder` "Acme design team", `onboarding.intent.team` "My team" ("Starts with a Sprint board"), `onboarding.board.team` "Sprint board". A workspace-name placeholder reading "team" nudges users to name a workspace a team. Proposed: "Acme Design" and "Launch" (group chat). Public copy uses "team" for people, which is fine; "Share the workspace" in HOME.how.steps[2] is fine. `moving-from-trello` table is correct (List -> Lane).
9. Blog `lanefold-keyboard-shortcuts.md` and en.json `shortcuts.description` "Shortcuts for boards and cards arrive with those screens." Stale/internal wording. Proposed: "Press ? to see shortcuts for the screen you are on." (Verify the blog list matches `shortcuts.*`: `n` text in blog "Press the screen's first add button" vs `shortcuts.new` "Add a card (on a board) or a board (on the list)": "list" here should be "boards page". Proposed: "Add a card (on a board) or a board (on Boards)".)

## Plurals and formatting

10. `lane.count` "{count} cards" has no `_one/_other` pair (1 -> "1 cards"). The key is currently unused (lane.tsx shows the bare number), but `lane.countLimit` "{count} of {limit} cards" is used for aria-label; "1 of 5 cards" is fine. Still: `chat.attachedCards`, `card.tooMany` "Add up to 20 cards at once." OK. Fix: add `lane.count_one` "{count} card" / `lane.count_other` "{count} cards" or delete the key. Also `myDay.truncated` "Showing the first 200 cards." fine (constant). `workspaceSettings.memberCount` "{count} in this workspace" is vague; proposed: `_one` "{count} member in this workspace" / `_other` "{count} members in this workspace".
11. Ellipsis style: pending labels are consistent with the unicode "…", but several are bare verbs or off-pattern: `cd.commentAdding` "Posting…" (key says Adding; fine), `chat.creatingGeneral` "Creating #general…" fine. `members.copyFailed`, `states.loadError` fine. No ASCII "..." found in en.json. Placeholders `shell.palettePlaceholder` "Type a command or search…" OK. No change except keep it that way.
12. Capitalisation: `nav.workspaceSettings` "Workspace" duplicates `nav.workspace`; proposed "Workspace settings". `errors.workspace_read_only` "...until its plan limits are fixed." vs `errors.read_only` "...read-only right now." Merge and say how to fix: "This workspace is read-only because it is over its plan limits. An owner can upgrade the plan or remove members or files."

## Errors that do not say how to fix, or blame/vague

13. Vague: `errors.not_found` "We could not find that." -> "That no longer exists. It may have been deleted. Go back and try again."; `errors.too_long` "That is too long." and `errors.too_short` "That is too short." give no limit: use "Use at most {max} characters." / "Use at least {min} characters."; `errors.invalid` "That value is not valid." -> "Check this value and try again."; `errors.out_of_range` "That number is out of range." -> "Use a number within the allowed range." (best: include min/max); `errors.validation` "Some fields need fixing." -> "Check the highlighted fields and try again." (matches `errors.invalid_input`, so merge). `errors.site_database_disabled` "The database is not connected yet." and `errors.auth_not_configured` "Sign-in is not set up yet." are owner-facing; add "Tell the site owner." `errors.unknown` / `errors.server` pair near-duplicates: unify to one "Something went wrong on our side. Try again in a moment." (drop "Please" repetition: `errors.rate_limited` "Too many tries." sounds like blame; proposed "You are going a little fast. Wait a moment and try again.").
14. Platform storage errors (`errors.E_STORAGE_*`, `E_FILE_TOO_LARGE`) refer to "the site owner" and "Storage tab of the app dashboard": jargon, and a workspace member cannot act on it. `E_FILE_TOO_LARGE` "Pick a file from 1 byte up to 100 MB." -> "Pick a file under 100 MB." (also conflicts with plan-specific limits in `errors.file_too_large`; Free is 10 MB). Proposed: "That file is over your plan's {limit} limit. Pick a smaller file or upgrade." `errors.E_STORAGE_NEEDS_PACK` -> "File uploads are not available yet. Ask your workspace owner."

## Confirmations without the object name

15. Confirm dialogs that name no object: `boards.archiveTitle` "Archive this board?" -> "Archive “{name}”?" (lane archive already does this); `chat.deleteTitle` "Delete this message?" (acceptable, message has no name, but add preview: body "“{preview}” is removed for everyone."); `cd.commentDeleteTitle` "Delete this comment?" (same fix); `cd.removeTitle` "Remove “{name}”?" body "The attachment is deleted from this card." OK. `members.removeTitle` "Remove {name}?" OK. `lane.archiveBody` "The lane and its cards leave the board." should state recoverability and count: "“{name}” and its {count} cards leave the board. An admin can restore it."

## Hard-coded English bypassing i18n

16. `src/portal/routes.tsx:234` title "This page does not exist" (en.json already has `shell.notFoundTitle` with the same text; reuse), `:281` aria-label="Sidebar" (`shell.rail` exists), `:286` aria-label="Dashboard", `:310` aria-label="Close the menu" (`nav.closeMenu` exists). `src/portal/screens/billing.tsx:86-123` and `users.tsx:260-315`, `activity.tsx:166`: all titles, descriptions, empty states are literals. These are the owner dashboard (English-only by AGENTS.md), so low severity, but the four duplicates of existing keys in routes.tsx should use `t()` if the shell is shared with `/app`. `src/app/cards/attachments.tsx:69` placeholder="https://example.com/page" is an example URL: acceptable. No other literal JSX text, aria-label, title or placeholder was found in `src/app` by grep (strong, but only a pattern grep; a lint rule is better).

## Minor (not blocking)

- Oxford comma: none found in the audited copy; the style is consistently no-serial-comma ("Phone, tablet or computer", "Pick an image, PDF or document", "boards, cards and chat"). Keep; document it in `visual-identity.md`.
- `common.retry` "Try again" vs `common.reload` "Reload": fine.
- Blog `why-we-built-lanefold.md` "teams of up to about a hundred people" matches Team plan (100). "Keyboard first" in blog and shortcuts: backed. "turn a message into a card" and "share a card into a conversation": `chat.cardList`, `chat.attachedCards` exist; verify "message to card" exists in code (not confirmed by grep).
- `blog/moving-from-trello` "Trello has years of features and integrations we do not have" is honest and on-tone.

## Code re-check 2026-11-03
Confirmed fixed in code: 1 to 4 and 6 (no Trello claims left in `src/content/site.ts`); 7 and 8 (`src/i18n/messages/en.json` onboarding keys, placeholders "Acme Design", "Launch"); 9 (`shortcuts.description`, `shortcuts.new`); 10 (`lane.count` removed); 12 (`nav.workspaceSettings`, `errors.workspace_read_only`); 13 (`errors.not_found`, `too_long`, `too_short`, `invalid`, `out_of_range`); 14 (`E_FILE_TOO_LARGE`, `E_STORAGE_NEEDS_PACK`); 15 `boards.archiveTitle` names the board.
Left: 15 message and comment delete titles name no object (acceptable); 16 owner dashboard literals in `src/portal/routes.tsx` (English-only by AGENTS.md, outside `src/app`).

## Update 2026-11-04
- Trello import now exists (`/app/settings/import-export`, JSON export only; export to JSON and CSV from a board). Blog post `moving-from-trello-to-lanefold.md` rewritten to say so, with the steps and its limits. Marketing copy (`site.ts`) still makes no Trello claim, which is fine; it could mention import later.
- Item "message to card" in the minor list: not built (only attaching a card to a message with #). `why-we-built-lanefold.md` reworded to match.
- Re-checked home, about and pricing copy: no timeline, custom fields, real-time, or email notification claims. Blog front matter matches `src/content.config.ts` (title, description under 200 characters, publishedAt, tags; no cover).
- Still open and outside `src/content`: item 15 message and comment delete titles (acceptable) and item 16 owner dashboard literals in `src/portal/routes.tsx` (English-only).
