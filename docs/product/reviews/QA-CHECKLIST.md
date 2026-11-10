# Lanefold manual QA checklist

A click-through script for the owner, in the browser at http://localhost:4321 (dev server). Nobody has viewed the app in a browser yet, so expect some breakage: work in order, tick each box, and file every "Bug if" with the template at the end.

How to read each step: **Do** what to click, **See** what should happen, **Bug if** what counts as broken. Texts in quotes come from `src/i18n/messages/en.json` (English). Keep the browser devtools console open (F12) the whole time: any red error is worth a report.

Plan limits (seed, editable later in /dashboard Plan limits):

| Plan | Members | Largest file | Storage | Audit log | Price key |
|---|---|---|---|---|---|
| Free | 10 | 10 MB | 1 GB | no | none |
| Pro | 50 | 100 MB | 20 GB | no | pro-monthly |
| Team | 100 | 100 MB | 100 GB | yes | team-monthly |

Product URLs: `/app` (host), `/app/boards`, `/app/b/<boardId>` (board), `/app/b/<boardId>/c/<cardId>` (card modal, a child of the board), `/app/my-day`, `/app/inbox`, `/app/chat`, `/app/members`, `/app/join/<token>`, `/app/onboarding`, `/app/settings` (+ appearance, workspace, billing, language). Admin: `/dashboard`.

---

## 0. Prerequisites

- [ ] **Database up.** Terminal: `docker ps` shows container `lanefold-pg` on port 5480. If stopped: `docker start lanefold-pg`. Then `npx prisma migrate deploy` (applies the schema to the `lanefold` database).
- [ ] **`.env` has** `SITE_URL=http://localhost:4321`, `DATABASE_URL` (port 5480, database `lanefold`), `JWT_SECRET`, and `SITE_OWNER_EMAILS=<your email>` (names only here, never paste values in reports). Without `SITE_OWNER_EMAILS` locally, the first account to confirm its email becomes owner.
- [ ] **Start** `npm run dev` (once; in the editor the Preview already runs it, do not start a second). Open http://localhost:4321. **See** the home page. **Bug if** a 500 page or a blank page; copy the terminal error.
- [ ] **Sign in with the emailed code.** Go to http://localhost:4321/account/login/, enter your owner email, request the code, type the 6 digits (valid 10 minutes, one use, 5 wrong tries spend it, a new code ends the older one). The email is relayed by the platform with `SITE_KEY`.
  - **No email arrives?** (1) Check spam and wait 1 minute, then request a new one (only the newest works). (2) Watch the `npm run dev` terminal for a warning about the email relay or a missing site key. (3) In the editor Preview, use the shield button in the Preview's bar: it signs the owner in with one click (no email). (4) Otherwise use "Forgot password" on the login page, or sign up with a password at `/account/register/` and confirm via the emailed link; if mail never leaves your machine, the relay (`SITE_KEY`) is not configured: stop and tell the developer, do not try to work around it.
- [ ] **Two browsers.** Prepare a second browser profile (or a private window in another browser) and a second email address you can receive mail on (for section 6).
- [ ] **Optional demo data.** After you have an account: `npm run seed:demo -- you@example.com` creates a "Demo Studio" workspace (plan Team) with boards Sprint, Content calendar, Personal, about 25 cards and a #general channel. Dry run: add `--dry-run`. It refuses if the demo already exists. For a "first run" test (sections 2 to 4) use a second, fresh account instead so you see the empty states.

---

## 1. Public site

- [ ] **1.1 Home `/`.** **See** hero, nav, footer, no layout shift on load. **Bug if** broken images, overlapping text, console errors.
- [ ] **1.2 Pricing `/pricing/`.** **See** three plans (Free, Pro, Team) with the limits table above, one "popular" badge, comparison table with yes/no marks. Buttons go to `/account/register/?plan=...` when signed out; "Open your boards" when signed in. **Bug if** limits differ from the table, button shows both versions, link 404s.
- [ ] **1.3 Blog `/blog/`.** **See** posts (kanban-and-chat, keyboard shortcuts, Moving from Trello to Lanefold...), open one, headings and cover render. `/rss.xml` and `/sitemap.xml` load. **Bug if** empty list, broken cover, post 404.
- [ ] **1.4 About `/about/`.** **See** content. **Bug if** placeholder template text left over (the old "welcome" / "how to add a post" posts must be gone).
- [ ] **1.5 404.** Visit `/nope/`. **See** the friendly not-found page with the site header; then `/app/nope`. **See** "This page does not exist" with "Go to My Day". **Bug if** a raw server error or blank page.
- [ ] **1.6 Sign-up validation `/account/register/`.** Submit empty: **See** errors under each field, focus on the first wrong field, nothing sent, no browser bubbles. Type a bad email, then a password of 9 characters: error says how to fix it (minimum is 10, maximum 128). Errors show on blur, then update live while typing. **Bug if** browser-native popups, errors without words, form clears on error.
- [ ] **1.7 Show/hide password.** On register, login: the eye button toggles the field, hidden by default, has an accessible name. **Bug if** password visible by default or the button does nothing.
- [ ] **1.8 Error timing and pending.** Submit a valid sign-up: button shows a spinner and "...ing" label, disabled (click twice fast: only one request in the Network tab). Wrong login: error appears next to the form, button usable again, never stuck pending. Many wrong tries: "Too many tries. Please wait a moment and try again." **Bug if** stuck spinner or double submit.
- [ ] **1.8b Copy and removed pages.** `/jobs/` and `/jobs/<slug>/` must answer the not-found page (the template job board is removed) and `/sitemap.xml` must not list them. Trello import now exists in the app (`/app/settings/import-export`, step 8.9), but the blog post "Moving from Trello to Lanefold" still says import is on the roadmap and not available: note it as a copy mismatch for the developer, it is not a product bug. **Bug if** `/jobs/` still renders a job list.
- [ ] **1.9 Navigation.** Links between public pages are instant (no full reload flash). Header shows "sign in" when signed out and a way into the app when signed in.

---

## 2. Onboarding (3 steps) — use a fresh account with no workspace

- [ ] **2.1 Entry.** Signed in with no workspace, open `/app`. **See** redirect to `/app/onboarding` ("Create your workspace"). **Bug if** a blank screen or a loop.
- [ ] **2.2 Step 1 of 3: Purpose.** Header "Step 1 of 3: Purpose", choices "My team" (Sprint board), "Just me" (To do, Doing, Done), "School or a project" (empty board). Pick one, "Next". **Bug if** Next works with nothing chosen without a clear message, or step numbers are wrong.
- [ ] **2.3 Step 2: Name.** Submit empty: "Enter a name for your workspace." 81 characters: "Use at most 80 characters." Valid name then "Create workspace": toast "Workspace created." Cancel is disabled while pending.
- [ ] **2.4 Step 3: Invite.** "Invite your team": "Create invite link" shows a link ("Valid for 7 days, up to 10 people"). Copy works. Also try "Skip". The tip line mentions n, Ctrl K and ?. **Bug if** the workspace was not created, link missing, or you land on a blank page after "Done".
- [ ] **2.5 After.** You land on the new board (team/personal) or boards list. A "Get started" checklist (Create a board, Add a few cards, Invite a teammate, Say hi in General) shows progress "x of 4 done" and can be dismissed. Do the items and watch them tick. **Bug if** items never tick or Dismiss returns after reload.

---

## 3. Boards

- [ ] **3.1 Boards list `/app/boards`.** Empty state "No boards yet" with a create action; else cards. Star a board ("Star board"): it appears under "Starred"; remove star works.
- [ ] **3.2 Create a board.** "New board": try with and without the "default lanes" checkbox (checked gives 3 lanes: To do, Doing, Done; unchecked gives an empty board). Templates (Sprint, Content, Personal) are not in this modal: try them from the empty-state strip on the boards page and in onboarding. Empty name: "Enter a name for the board." Over 80 chars: "Use at most 80 characters." Visibility Workspace / Private (no public link). **See** toast "Board created." and you land on the board with the right lanes. **Bug if** wrong lanes, double board, no toast.
- [ ] **3.3 Lanes.** "Add a lane": empty name gives "Enter a name for the lane."; add one. Lane menu: Edit (name, color), Collapse/Expand, Archive (confirm "Archive “<name>”?", toast "Lane archived."; the lane and its cards leave the board). Drag a lane by its grip to reorder. A board holds up to 50 lanes ("A board holds up to 50 lanes.").
- [ ] **3.4 WIP limit.** Edit a lane, "Card limit" = 2; 0 or 1000 gives "Use a whole number from 1 to 999." Add a third card: lane header shows "3 of 2 cards" and "over limit" highlight. Empty the field: no limit. **Bug if** over-limit has no visual or non-visual cue. Note: a server "This lane is full. Move some cards to another lane first." may apply at its hard cap.
- [ ] **3.5 Add cards.** In a lane click "Add a card": placeholder "What needs doing?". Enter adds; Shift+Enter new line; several lines add several cards (up to 20: "Add up to 20 cards at once."). Empty: "Enter a title."; over 200: "Use at most 200 characters for each card." Escape closes the composer. Pressing `n` on a board opens the first add-card composer. **Bug if** card appears twice or the composer loses typed text on error.
- [ ] **3.6 Drag with the mouse.** Drag a card to another lane and within a lane; drop indicator appears; card stays after reload. Drag onto an empty lane ("Drop cards here"). **Bug if** a card snaps back, duplicates, or the board jumps.
- [ ] **3.7 Keyboard drag.** Tab to a card's grip ("Drag card <title>"). Space lifts ("Picked up card X."), arrows move ("Card X is now in Lane, position 2 of 5."), Space drops ("Dropped card X in ..."), Escape cancels ("Move cancelled."). Same for lanes. **Bug if** no announcement, focus lost after drop, or arrows scroll the page instead.
- [ ] **3.8 "Move to..." menu.** Card menu ("Actions for card <title>") then "Move to...": dialog "Move card" with Lane and Position, "Move" button. Lane and Position default to the current ones; Position is clamped to the lane's length. Moves; the board shows an Undo bar ("Move undone." after clicking). **Bug if** Undo does nothing or the bar vanishes instantly.
  - **Failed action (needs devtools):** in Network pick "Offline" (or block the request URL), then move or archive a card. **See** the card jumps back or the change reverts, and a red alert bar with the error in words, a "Try again" button and a close button (Esc also closes it). The Undo bar for that failed action must disappear (Undo never applies something that was never saved). Go back online, press "Try again": the action runs once. Undo after a failed archive must do nothing. **Bug if** Undo "restores" a card that was never archived, the error stays forever, or "Try again" duplicates the action.
- [ ] **3.9 Archive and restore.** Card menu "Archive card": toast "Card archived." with Undo. Restore: open the board's "Archived cards" button (drawer "Archived cards", "In <lane>", "Archived <when>") and press "Restore": toast "Restored." Archive a board from Board settings: confirm "Archive this board?", toast "Board archived.", it leaves the list. On `/app/boards` open "Archived boards" and press Restore: toast "Board restored."; empty state "No archived boards". An archived board shows "This board is archived."
- [ ] **3.10 Board settings drawer.** Open "Board settings": rename, visibility, background in three groups ("Solid colors", "Gradients": Dusk, Ocean, Forest, Sunset, Graphite, and "Custom color" with an invalid hex giving "Use a color like #5b5bd6."); toast "Board saved." Background changes immediately and survives reload; text on every gradient stays readable.
  - **Card limit per lane** section lists every lane ("This board has no lanes yet." if none): set a limit, save, the lane header shows "<n> of <limit> cards" and "over limit" when exceeded; invalid value "Use a whole number from 1 to 999."
  - **Duplicate board** button ("Duplicating..."): toast "Board duplicated."; a new board named "<name> (copy)" with the same lanes and background appears; check whether cards are copied and note it in your report.
  - **Archived lanes:** after archiving a lane (3.3), open "Archived cards": section "Archived lanes" shows it with "Cards: <n>"; Restore: toast "Lane restored.", it returns at the END of the board with its cards. A card archived inside an archived lane shows "Its lane is archived, so the card stays hidden until the lane is back." Empty: "No archived lanes". Only board admins see Restore. Esc closes and focus returns to the opening button.
- [ ] **3.11 Sync.** Open the same board in two tabs; add a card in one: it appears in the other within a few seconds (polling). If both edit at once you may see "This board changed elsewhere. Showing the latest." Go offline in devtools: "Offline. Changes will sync when you are back." Come back: it syncs. **Bug if** edits are lost silently.
- [ ] **3.12 Viewer role.** (After section 6) a Viewer sees "You can view this board but not change it." and no add/drag controls.

---

## 4. Card modal `/app/b/<boardId>/c/<cardId>` (centered modal over a dimmed board)

- [ ] **4.1 Open.** Click a card: a centered modal (max 56rem wide, 90% of the screen height, body scrolls inside it) opens over the dimmed board, URL becomes `/app/b/<boardId>/c/<cardId>`. Header: done checkbox, title, X. Body: description, checklists, attachments, comments and activity on the left, the properties rail (priority, dates, estimate, labels, members, cover) on the right; at 720 px or narrower one column. Reload: the modal still opens over the board. Back button closes it. The page behind does not scroll (wheel over the dim area, keyboard). **Bug if** the board disappears (not just dimmed), the URL does not change, or the background scrolls.
- [ ] **4.2 Title and fields.** Edit title (empty gives "Enter a title."), Priority (None/Low/Medium/High/Urgent), Completed toggle, Due date ("No due date"; a past date shows "Overdue" on the board). Toast "Card saved." **Bug if** change not on the board card after closing.
- [ ] **4.3 Description + Markdown preview.** Type `**bold**`, a `- list`, a `[link](https://example.com)`; switch to Preview: renders formatted. Try `<script>alert(1)</script>`: must show as plain text, never run. **Bug if** an alert fires (security) or preview differs wildly.
- [ ] **4.4 Labels.** Create a label (name + color), attach and detach it; it shows on the board card ("Labels: ..."). Edit and delete a label.
- [ ] **4.5 Assignees.** Assign yourself: card appears in My Day (section 7); "Assigned to <names>" label.
- [ ] **4.6 Checklist.** Add a checklist and 3 items, tick two: board card shows "Checklist 2 of 3"; progress bar updates. Delete an item. **Bug if** counts disagree between panel and board.
- [ ] **4.7 Comment with @mention and notification.** (Needs a second member, section 6.) Type `@` and a name: suggestion list appears (arrows + Enter choose). Post the comment. In the second browser the bell shows an unread count; opening it shows "<name> mentioned you in a comment"; clicking it opens the card; "Mark all read" clears the badge. Edit and delete own comment. **Bug if** mention list is empty for real members, or no notification arrives.
- [ ] **4.8 Attachments.** Add a link attachment: shows in the list, rename works. Upload a file: **Expect** (until the owner turns on Storage and a Storage pack) "File uploads are not switched on yet. Ask the site owner to add a storage pack in the Storage tab of the app dashboard." That message is correct, not a bug. **Bug if** the page crashes, a generic "Something went wrong", or the upload spinner never ends. After the owner enables Storage: upload a small image (shows), a 11 MB file on Free gives "That file is over your plan's file size limit.", an .exe gives "That kind of file cannot be attached. Pick an image, PDF or document."
- [ ] **4.9 Activity.** The modal lists what you just did, in order, with names (never email addresses).
- [ ] **4.10 Close and focus return.** Close with the X, with Esc, and with the back button: the modal closes and keyboard focus returns to the card you opened. Clicking the dim area closes it too, but NOT when you select text inside the modal and release the mouse on the dim area. Esc with a menu, date or label picker open closes only that; Esc in the description or comment editor cancels the edit only. **Bug if** focus lands on the page top. Opening the modal moves focus inside it; Tab stays inside the modal and never reaches the board.
- [ ] **4.10b Layers inside the modal.** With the modal open: open Labels, Members, a date picker and the "More" menus (all appear ABOVE the modal and work); change a field and see the toast; delete an attachment (the confirmation stacks above, Esc closes only it); open an image attachment (lightbox above, Esc closes only it); trigger a failed save (failure bar with Retry visible and clickable in the modal); press Ctrl+K (ignored, no palette over the modal) and `?` (ignored). Close the modal: Ctrl+K works again. **Bug if** any of these is hidden behind the modal or cannot be clicked.
- [ ] **4.11 Archive from the modal,** and open a card id that does not exist (`/app/b/<boardId>/c/999999`): friendly "We could not find that." not a crash.

---

## 5. Chat `/app/chat`

- [ ] **5.1 First visit.** "Creating #general..." then a #general channel exists. List groups: Channels, Direct messages, Boards. Empty: "No conversations yet / Start one with the New button."
- [ ] **5.2 Send.** In #general type a message, Enter sends (button "Sending..."). Empty: "Write a message first." Very long: "That message is N characters too long. Shorten it to send." Failed send shows Retry. Edit ("(edited)"), delete (confirm "Delete this message?", then "This message was deleted.").
- [ ] **5.3 New channel and DM.** "New": kind Channel (name required "Enter a name.", max 80), Direct message ("Choose a person"), Group (1 to 20 people). Alone in the workspace: "There is nobody else in this workspace yet." **Bug if** duplicate DM with the same person.
- [ ] **5.4 Thread.** "Reply in thread": thread panel opens ("No replies yet / Be the first to reply."), post a reply, parent shows "Replies: 1". "Close thread" returns focus to the message.
- [ ] **5.5 Reaction.** "Add reaction": pick an emoji; chip shows count; click again to remove; second browser sees it.
- [ ] **5.6 Pin.** Message actions: Pin: toast "Message pinned."; "1 pinned" strip with "Show less"; Unpin: "Message unpinned."
- [ ] **5.7 #card chip.** In the composer type `#` (or "Attach a card"): suggestions of cards; choose one: chip shows under the message; click opens the card. A card you cannot access shows "You do not have access to this card".
- [ ] **5.7b Create a card from a message.** Hover a message and open its "More actions" menu, choose "Create card": dialog "Create a card from this message" ("The message text becomes the card's description, with a note of where it came from.") with fields Board, Lane, "Card title". Errors: title over the limit "Use at most <n> characters."; read-only board "You can only view this board. Choose another one."; no boards "There are no boards to add a card to yet."; nothing chosen "Choose a board and lane you can add cards to." Submit: toast "Card created." with an "Open card" action that opens the card panel. The message now shows a card chip (click opens the card; a card you cannot access shows "You do not have access to this card"). Not offered on deleted or system messages, or when the message already has 10 cards. Check the new card's description and activity on the board. **Bug if** the card lands in the wrong lane, appears twice on double click, or the chip is missing.
- [ ] **5.8 Unread.** With the second browser, post a message while you are on another screen: unread count and "New messages: n" divider appear on your side; opening marks read. The sidebar Chat item shows a count badge ("<n> unread", "99+" at most) and on phone the dock Chat icon shows a dot; both update by themselves within a few seconds (polling) when the other browser posts, and clear after you open the conversation. A mention notifies even if muted ("Conversation muted. Mentions still notify you."). Mute/Unmute work.
- [ ] **5.9 Board chat.** On a board open the "Chat" tab / board chat panel; messages sent there appear under "Boards" in /app/chat. "Close board chat" returns focus.
- [ ] **5.10 Live updates.** New messages from the other browser show without reload (polling) and are announced politely to screen readers.

---

## 6. Members `/app/members`

- [ ] **6.1 List.** You are "Owner" with a "You" tag; columns Member, Role, Joined, Actions.
- [ ] **6.2 Invite link.** "Invite people": choose Invite (one use, optional email) or Join link (many people, "Maximum uses" 1 to 100: "Use a whole number from 1 to 100."). Bad email: "Enter a valid email address, like name@example.com, or leave it empty." "Create": "Your link is ready", "Copy it now. For safety it is shown only once and cannot be recovered." Copy button says "Copied". A link or an invite without an email address emails nothing.
- [ ] **6.2b Invite by email (Phase 11).** In "Invite people" choose Invite and type an email address: a checkbox "Also send by email" appears (on by default). Create. If the owner secrets `RESEND_API_KEY` and `MAIL_FROM` are NOT added (or you are in the editor Preview): **See** "Email is not set up, so nothing was sent. Share the link yourself." and an "Email preview (not sent: email is not set up)" with Subject and Message; the invite row in the list shows "Email not set up" and a "Resend email" action. If they ARE added: **See** "The email is on its way.", the row goes "Email queued" then "Email sent" (give it a minute), and the mail arrives with a working link. Uncheck the box: nothing is queued. "Resend email" asks you to type the address again (the server never stores it), shows a new link, and the old link stops working. Limits: 10 invite emails per hour per person, 30 per workspace, 5 sends per invite ("Too many invite emails. Try again in an hour, or share the link yourself."). **Bug if** the address appears anywhere in the page after creating, in the Jobs tab of the platform, or the status stays "Email queued" forever with secrets added.
- [ ] **6.3 Second profile joins.** In the second browser profile sign up/sign in with another account, paste the link (`/app/join/<token>`): "Join this workspace?" then "Join workspace": toast "You joined the workspace." Reuse the same one-use link: "This invite link is not valid any more." Already a member: "You are already in this workspace".
- [ ] **6.4 Role change.** As owner pick the new member's role (Admin / Member / Viewer; no way to choose Owner): toast "Role changed." Your own role: "You cannot change your own role." Verify as Viewer: can read, cannot edit (3.12), chat shows "You can read this conversation but not write in it."
- [ ] **6.5 Remove / leave.** Remove member: confirm "Remove <name>?", toast "Member removed." Member leaves: "Leave <name>?" then "You left the workspace." The only owner leaving: "You are the only owner. Make someone else an owner or delete the workspace first."
- [ ] **6.6 Revoke link.** Revoke: confirm, "Revoked."; status shows Revoked/Used/Expired; opening it gives the invalid page.
- [ ] **6.6b Rejoin after removal.** Remove the second account, then open the OLD invite or join link it used (or a link created before it left): **See** "This invite link is not valid any more." A link created after it left works.
- [ ] **6.7 Transfer ownership.** Settings, Workspace: "Transfer ownership..." requires typing the workspace name ("That does not match the workspace name."); toast "<name> is now the owner."
- [ ] **6.8 Member cap on Free.** Fastest: in `/dashboard` Plan limits set Free members to 2, then try a 3rd join (restore 10 afterwards). Otherwise, on a Free workspace: create a join link (max uses 100) and add accounts until 10 members. Faster: the 11th join fails with "This workspace has reached its member limit. Ask an admin to upgrade the plan." and an upgrade prompt ("Your plan does not allow that. See plans to upgrade." with "See plans") that leads to Billing. **Bug if** the 11th joins, or the error is generic.

---

## 7. Search, Cmd+K, My Day, Inbox

- [ ] **7.0 Lazy palette.** Hard reload `/app`, press Ctrl+K immediately (before the page settles): **See** the dialog open (a brief loading state is fine), typing works. Hovering or focusing the top search button preloads it. Offline: after the app has loaded once, devtools Network "Offline", then open the palette: it opens if already loaded; if never loaded (set Offline BEFORE the first reload via throttling "Offline" after load, then try) expect a graceful message or the "Try again" path, never a blank screen or frozen page. Back online: palette works after retry. Search while offline: "Search is not available right now." **Bug if** the shortcut does nothing forever or the console shows an unhandled chunk-load error with no UI feedback.
- [ ] **7.1 Palette.** Press Ctrl+K (Cmd+K on Mac) or `/`, or click the top search ("Search or run a command"). **See** dialog "Command palette", "Go to" and "Actions" groups. Type a card title: group "Cards"; a board name: "Boards"; a person: "People". Arrows + Enter open it; Esc closes and focus returns. No match: "No results." Type a new name: "Create board "<name>"". **Bug if** results stay "Searching..." forever or "Search is not available right now." appears with the server up.
- [ ] **7.2 Shortcuts (`?`).** Press `?`: list opens. Check: `g` then `b` Boards, `g` then `m` My Day, `g` then `i` Inbox, `g` then `c` Chat (second key within 1.5 s), `n` adds a card on a board / a board on the list, `/` palette. None of them fire while typing in a field, with a dialog open, or with Ctrl/Alt held. `?` again closes. **Bug if** shortcuts fire while typing.
  - **Switch off:** Settings, Appearance, switch "Keyboard shortcuts" ("Single-key shortcuts such as /, n, ? and g then a letter. Shortcuts with Ctrl or Cmd, like Ctrl+K, always stay on."). Turn it off: `n`, `?`, `/`, `g b` do nothing; **Ctrl/Cmd+K still opens the palette**; Esc still closes dialogs. Reload: the setting persists. Turn it on: all work again. Pressing `g` once shows a hint "Go to: b for Boards, m for My Day, i for Inbox, c for Chat".
- [ ] **7.3 My Day `/app/my-day`.** Groups Overdue, Today, Next 7 days, Later, No due date for cards assigned to you. Mark done via the "Mark "<title>" done" checkbox: toast "Card marked done." and the row leaves. Empty: "A clear day / Browse boards".
- [ ] **7.4 Inbox `/app/inbox`.** Quick capture: empty submit "Write a title."; over 200 "Use at most 200 characters."; add "Call the printer": toast "Added to your Inbox." Row actions: "Move to a board" (pick board and lane): "Moved to <board>."; "Archive": "Card archived."; mark done. No boards yet: "Create a board first, then you can move cards into it." **Bug if** a captured card never appears or lands in a shared board unasked.
- [ ] **7.5 Notification bell.** Header bell shows unread count; opens list "Notifications"; empty "You are all caught up".

---

## 8. Settings `/app/settings`

- [ ] **8.1 Workspace.** Shows name, address name, plan, your role, members count. Rename (admin/owner): empty "Enter a name for the workspace.", 81 chars "Use 80 characters or fewer."; success "Workspace renamed." As a Member: "Only admins and owners can rename this workspace."
- [ ] **8.1b Archive a workspace.** Settings, Workspace (owner only): archive with the typed workspace name; the workspace becomes closed to everyone (nobody can open its boards or chat) and nothing is deleted. Restore it from the archived list. A non-owner cannot archive.
- [ ] **8.2 Theme/mode.** Appearance: Light, Dark, Same as this device, High contrast ("Stronger borders and text for easier reading."). In High contrast check borders on cards, inputs and lanes are clearly stronger and focus rings are visible, on boards, card panel and chat. Applies at once, no flash on reload, persists, and follows you to a second browser (synced). Check every screen in Dark for unreadable text.
- [ ] **8.3 Accent.** Click each of the 12 presets (Indigo, Blue, Teal, Green, Lime, Amber, Orange, Red, Rose, Pink, Purple, Slate): buttons/links recolor in light AND dark; "Contrast is <n> to 1. Good." shows. In a workspace with its own brand color: "Your workspace uses its own brand color, so the accent cannot be changed here." Custom color: a very light color shows "This color is hard to see" with "Use <hex> instead"; invalid hex "Use a color like #5b5bd6."
- [ ] **8.4 Font size.** Default / Large / Larger / Largest (100 / 112 / 125 / 150 %): whole app scales, no clipped buttons or overlapping text at Largest.
- [ ] **8.5 Density, corners, motion.** Compact / Comfortable / Spacious change spacing; Sharp/Soft/Round change corners; "Reduce motion" ("Turns off sliding and fading animations.") stops slide, fade and toast animations; also test with the OS setting "reduce motion" on (devtools Rendering, Emulate CSS media feature prefers-reduced-motion). Preview card updates live.
- [ ] **8.5b Forced colors (Windows High Contrast).** Chrome devtools: Cmd/Ctrl+Shift+P, "Show Rendering", scroll to "Emulate CSS media feature forced-colors", choose "forced-colors: active". **See** (on Boards, a board, card panel, chat, Settings) text readable, buttons and inputs have visible borders, focus ring is a clear system-colour outline (Highlight), selected states (chosen accent, mode, checked switch, selected lane/card, active nav item) are still distinguishable by border or outline, not by background alone. Set back to "No emulation". **Bug if** a control disappears, selection cannot be told, or focus is invisible.
- [ ] **8.6 Reset and export.** "Reset to defaults" asks "Reset your appearance?" then resets. Export JSON downloads; Import a good file: "Appearance imported."; a junk file: "That file is not a valid appearance export."
- [ ] **8.7 Language.** `/app/settings/language`: switch to Spanish or German: UI changes at once, toast "Language saved." Non-English shows a "machine draft" notice. **RTL:** choose Arabic, Persian or Urdu: page direction flips (sidebar on the right, text right-aligned, arrows and drawers mirrored), "Reads right to left" shown. Open a board, a card panel, chat and the palette in RTL: **Bug if** text overlaps, icons point the wrong way, drag handles break, or any raw message key (like `chat.send`) shows. Switch back to English.

- [ ] **8.9 Import and export `/app/settings/import-export`.** Pick a Trello export JSON file: a dry run shows counts and whether it can be imported before anything is written; start the import: a new board with its lanes and labels appears and cards arrive in chunks (checklists, comments, links; attachments are links only, comments are written under YOUR name with the original author named in the text). Run the same import twice: no duplicates. On a board, the export menu downloads JSON and CSV (board admins and workspace admins only). **Bug if** a failed chunk leaves a half board with no message, or the CSV opens a formula in a spreadsheet.
- [ ] **8.10 Delete-account preflight `/app/settings/account`.** **See** what stops deletion and what it affects. As the only owner of a workspace that has other members: a blocker (transfer ownership first). As the only member of a paid workspace: a blocker (move it to Free). As the only member of a Free workspace with boards, cards, files or chat beyond #general: a blocker (empty it). An archived workspace blocks too (restore it first). With no blockers the page shows what goes (memberships, your Inbox, empty solo workspaces) and what stays as "Deleted user" (comments, messages, cards you created); counts cap at 1000. Counts and names are only yours; no other person's email shows. Do NOT finish the deletion on your real account. **Bug if** a blocker names another person's email, or the page says you can delete while the platform's delete still fails.

---

## 9. Billing `/app/settings/billing`

- [ ] **9.0 Owner action first.** Sandbox prices must exist (the developer cannot do this): `npm run platform -- prices add --key pro-monthly ...` and `--key team-monthly ...` (see `docs/agent/payments.md`). Until both exist, the screen shows "Payments are not set up yet. Try again later." and checkout answers 404: that is expected, report it only if prices DO exist.
- [ ] **9.1 Overview.** "Current plan" Free; usage "Members n of 10", "Storage", "Largest file", "Audit log". A "Test mode" badge (TestModeBadge, "Payments are in test mode: no real money moves.") must appear wherever checkout appears.
- [ ] **9.2 Change plan.** "Change plan" (or Upgrade): drawer "Choose plan" (Plan, "Pay with", "Go to checkout"; "You pay on the next screen. In test mode no real money moves."). Choose Pro: button "Opening checkout...", then sandbox checkout. Complete with the sandbox test card. **See** return to the app and plan now Pro with limits 50 members / 100 MB / 20 GB. **Bug if** plan not updated after returning (wait a few seconds and reload once; report if still Free), or pending never ends. Team: audit log "Yes". Try picking a lower plan: "Choose a plan bigger than your current one." / "There is no bigger plan to move to." on Team.
- [ ] **9.3 Non-admins.** A Member sees "Only owners and admins of this workspace can change its plan."
- [ ] **9.4 Read-only/grace.** (Optional, after downgrade tests) over-limit shows "Over the plan limits. Everything keeps working until <date>." then read-only "This workspace is read-only until it is within its plan limits."

---

## 10. Dashboard admin `/dashboard` (platform owner only)

- [ ] **10.1 Sign-in.** Go to `/dashboard`: sign in by emailed code or the one-click shield. A non-owner account must NOT see admin screens (try the second browser: expect no access / hidden nav).
- [ ] **10.2 Overview and nav.** Stat tiles, sidebar items incl. Billing, Plan limits, Workspaces, Users, Roles, Activity (there is no Jobs screen any more). "Back to the website" works.
- [ ] **10.3 Billing.** Mode (billing on/off; off shows "Every feature is unlocked for now" in the app), grace days, maintenance message. Save shows a toast; after saving, `/app` reflects it.
- [ ] **10.4 Plan limits.** Table shows Free 10 / 10 MB / 1 GB, Pro 50 / 100 MB / 20 GB, Team 100 / 100 MB / 100 GB (audit log on for Team). Edit Free members to 3: drawer validates (Largest file up to 100 MB), toast on save; then check an app workspace on Free respects 3 (join fails above it). **Restore to 10 afterwards.**
- [ ] **10.4b Card cap and notification cap.** A lane holds up to 500 cards (error "This lane is full. Move some cards to another lane first."): too slow by hand, so either use the seed script (`npm run seed:demo`, which creates about 25 cards only; it cannot reach 500) or ask the developer to run a script that inserts 500 cards into one lane, then add the 501st: expect that message, no card created, lane still usable. The same lane check applies to "Create card" from chat and to Inbox move: expect the same message. Notifications: one person can send you at most 20 notifications per hour and you receive at most 200 per hour in total; further ones are silently dropped (no error for the sender). Test: have the second account @mention you 21 times in comments within an hour: the bell shows 20, not 21; the bell count itself shows at most "99" with a "more" indicator. **Bug if** the sender gets an error, or the app slows down.
- [ ] **10.5 Workspaces.** Lists all workspaces with plan and member counts, paging "load more". Viewing another owner's workspace data is audited; names shown, no member emails in lists.
- [ ] **10.6 Drawer and menu behavior.** Edit drawers close on Esc and return focus; row menus work; buttons show pending states.

---

## 11. Mobile (devtools, 375 px wide)

Open devtools, toggle the device toolbar, pick iPhone SE or width 375. Reload at that size.

- [ ] **11.1 Dock.** Bottom quick-navigation dock ("Quick navigation") with Boards, My Day, Inbox, Chat (and more); the desktop sidebar is hidden; the menu button ("Open the menu") opens a drawer; tap targets at least 44 px. **Bug if** dock covers content or composers, or horizontal page scroll appears.
- [ ] **11.2 Card sheet (phone width).** At 375 px tap a card: the modal opens as a full-screen sheet (clear of the notch and home bar), scrolls inside, closes with the X, Esc and back button, and the board stays behind it. Check title, description, checklist, comment box, attachments and activity all fit with no sideways scroll. On a real phone or devtools device mode with a virtual keyboard, the comment field stays visible when focused. **Bug if** content is cut off at the right, the close button is out of reach, or the board scrolls behind the sheet.
- [ ] **11.3 Lane scroll.** Board scrolls horizontally through lanes with a swipe (lane snap) while the page itself does not scroll sideways; "Add a lane" reachable.
- [ ] **11.4 Touch drag.** In devtools touch mode press and hold a card grip, drag to another lane; it moves and persists; a normal swipe still scrolls and does not drag. If dragging is difficult, "Move to..." must still work.
- [ ] **11.5 Chat on mobile.** List and conversation are separate screens with "Back to conversations"; composer sits above the dock.
- [ ] **11.5b Tables stack at 375 px.** Members (`/app/members`), the invite list and Billing tables, and in `/dashboard` Workspaces, Plan limits, Users: below 560 px width each row becomes a stacked block with the column name shown before each value (taken from the translated header), no sideways scroll, long values wrap. At 561 px and wider they are normal tables. **Bug if** a column header label is missing, values overlap, or a horizontal scrollbar appears.
- [ ] **11.5c Safe area (iPhone).** Real iPhone with notch or home bar is best. Emulation: Chrome devtools device toolbar, pick "iPhone 14 Pro" (or any iPhone), reload; devtools cannot draw the inset, so check by eye that the bottom dock, toasts and the board's floating buttons sit above the bottom area (they add `env(safe-area-inset-bottom)`). In Safari: Develop, Responsive Design Mode, iPhone preset shows the real insets. Also rotate to landscape: content not under the notch. **Bug if** the dock is covered by the home bar or the last row of a list is hidden behind the dock.
- [ ] **11.6 Other screens** at 375 px: boards list, members table, settings, billing drawer, palette, onboarding: nothing cut off, no overlapping text. Landscape too (667 px wide).

---

## 12. Keyboard-only and screen-reader smoke test

Put the mouse away (or unplug it).

- [ ] **12.1 Skip link and landmarks.** First Tab shows "Skip to content" and it works. Landmarks: "Main navigation", main content.
- [ ] **12.2 Focus visible.** Every Tab stop on boards, card panel, chat, members, settings shows a clear focus ring. **Bug if** focus is invisible or gets trapped on the board (a trap with no Esc).
- [ ] **12.3 Full flow without a mouse.** Create a board, add a card (`n`), open it (Enter), edit the title, add a comment, close (Esc, focus returns), move it with keyboard drag, send a chat message, open the palette (Ctrl+K), switch theme.
- [ ] **12.4 Dialogs.** Every dialog/drawer/menu: focus moves in, Tab cycles inside, Esc closes, focus returns to the trigger.
- [ ] **12.5 Screen reader** (NVDA/Orca/VoiceOver, 10 minutes). Page title changes on navigation and focus moves to the screen heading; toasts and drag moves are announced; icon-only buttons have names (e.g. "Open the menu", "Close the card"); form errors are read with the field; chat new messages announced ("New message in <where>"). **Bug if** a button is read as just "button" or an error is not announced.

---

## What NOT to expect yet (known gaps, not bugs)

Source: `docs/product/STATUS.md` and `review-*.md`. Do not file these; they are listed for the developer.

- **Delete account** is blocked in three cases until you fix them (the preflight at `/app/settings/account` lists them); the platform's own delete-account button on `/dashboard` account does not show that list and a blocked attempt there may show a generic error.
- **Search** uses plain matching (`ILIKE`) plus trigram indexes that exist only if the live database allowed `pg_trgm`; without them search on very large workspaces can be slow, and it is not typo-tolerant.
- **Languages:** 19 non-English catalogs are machine drafts; native-speaker review is pending (a "machine draft" notice shows). RTL (ar, fa, ur) has not been browser checked. The invite email strings may still be English-only until their catalog files are merged.
- **File uploads** need the Storage pack added by the owner; until then the "File uploads are not switched on yet" message is correct.
- **Checkout** needs sandbox prices `pro-monthly` and `team-monthly` created by the owner; until then "Payments are not set up yet."
- **Invite emails** need the owner secrets `RESEND_API_KEY` and `MAIL_FROM`; until then the preview and "Email not set up" are correct. Notification emails do not exist at all.
- **Not built:** flows, PWA, custom fields, recurring cards, a public board page (`/b/<token>/`), workspace hard delete (archive and restore exist). Table and calendar board views exist in code; a timeline view does not.
- A board-specific viewer override no longer beats a workspace viewer (decided: viewer always wins).
- **Nothing has been browser tested yet,** including drag (mouse, touch, keyboard) and RTL; migrations may still need running (`npx prisma migrate deploy`).

---

## Bug-report template

Copy one per bug. One bug per report.

```
Title: <short: where and what>
URL: http://localhost:4321/...
Checklist step: <e.g. 3.8>
Account / role / plan: <owner | admin | member | viewer> on <Free | Pro | Team>
Browser + size: <Chrome 1xx, 1280x800 | 375 px>
Language / theme: <en, light>

Steps:
1.
2.
3.

Expected:
Actual:

Screenshot or screen recording: <attach>
Console errors (red, F12 Console; copy text): 
Network failure (F12 Network, request, status, response body): 
Terminal output from `npm run dev` at that moment: 
Happens every time? <yes / sometimes / once>
Severity: <blocks use | wrong data | looks wrong | minor>
```

Never paste passwords, sign-in codes, tokens, or `.env` values into a report.
