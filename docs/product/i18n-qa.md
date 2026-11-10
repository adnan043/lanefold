
## 2026-11-04 Catalog translation pass

- The 183-key count was stale: the earlier batch is already translated. Remaining English strings were the new `importExport.*` block (68 keys incl. `nav.importExport`) and, added during this pass by another agent, `views.timeline`, `views.tl.*` (16) and `notifEmail.*` (9). All 93 keys are now translated in all 19 catalogs (placeholders `{name}`, `{count}`, `{limit}`, `{done}`, `{total}`, `{message}`, `{title}`, `{range}` checked for parity by script).
- Every key in `en.json` (1229 at the time) exists in every catalog. Only gaps: `_one` plural keys (5) absent in id, ja, ko, th, vi, zh, which is correct (those languages only use `_other`).
- What still equals English is deliberate: `shell.searchHint` (Ctrl K), `onboarding.namePlaceholder` (Acme Design), `members.emailPlaceholder`, `account.capped`, `chat.namePlaceholder` and loanwords or brand terms that are normal in that language (Chat, Admin, Workspace, Board, Sprint, Backlog, Pro, Team, Indigo and similar in de/fr/it/es/pt/id).
- Not reviewed by a native speaker. New keys added to `en.json` after this pass will show English until translated.
- 2026-11-04 follow-up: the "183 English keys" figure was stale; a re-scan found only `nav.collapseSidebar` and `nav.expandSidebar` untranslated, now translated in all 19 catalogs. These (and the rest of this pass) are machine-translated, pending native review.
