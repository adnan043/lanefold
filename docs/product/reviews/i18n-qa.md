# i18n QA report: 19 machine-translated catalogs

Read-only review. Catalogs in `src/i18n/messages/*.json` were not changed. Reference: `en.json` (903 keys). Script: scratchpad `qa.py` / `gen.py` (not in repo).

## 1. Headline findings

1. **183 keys are still English in all 19 catalogs** by the latest count (the 2026-11-03 re-check at the end of this file; full list there). The first pass, described in the rest of this section and in section 4, found 83 of them (identical to `en.json`, not technical): the whole `chat.*` composer/menu block (32), `members.*` table/roles/status (24), `tpl.*` template lane names (10), `shortcuts.*` (6), `onboarding.*` (6), `notif.*` (4), `nav.members`, and others. Counts by prefix: chat 30, members 24, tpl 10, shortcuts 6, onboarding 6, notif 4, shell 1, nav 1, setup 1. This looks like a batch the translator skipped, not intentional brand terms. Highest-impact fix: re-run the translation for those keys (list in section 4).
2. **Placeholders are intact everywhere**: 0 altered/missing `{n}`, `{name}`, `{count}`, `{date}`, `{title}`. 0 broken markup (the catalogs contain no HTML/markdown). 0 empty/whitespace-padded strings.
3. **Plural forms**: ar has zero/one/two/few/many/other (correct CLDR). ru has one/few/many/other (correct). es has an extra `_many` (correct for es CLDR). ja/zh/ko/id/th/vi have no `_one` (correct: only `other`). The "missing 3 / extra 3-12" counts below are therefore expected, not bugs. Verify the app resolves plural keys with `Intl.PluralRules` and falls back to `_other`.
4. **"My Day" (core term) is left in English** in the nav label in hi, id, ru, sw, th, tr (6 of 6 strings) and in the body strings in ar, bn, de, it, ja, ko, ur, vi, zh (2 of 6, e.g. `myDay.emptyBody`, `shell.notFoundAction`) while `nav.myDay` is translated. Same concept, two names in one screen.
5. **Lane vocabulary is inconsistent within a language**: `lane.add` says one word, `inbox.noLanes` another. es carril vs listas; pt raia vs listas; ar مسار vs قوائم; ja レーン vs リスト; ko 레인 vs 목록; zh 泳道 vs 列表; tr Şerit vs liste; sw njia vs safu; id lane vs lajur; it lane vs colonne. de uses "To do" in `boards.defaultLanes` but "Zu erledigen" in `boards.lane.todo`.
6. **Wrong term**: ko `nav.inbox`/`inbox.title` = "받은 알림" (received notifications); use 받은편지함 or 수신함. bn `card.overdue` = মেয়াদোত্তীর্ণ means "expired".
7. **Layout risk** (button/label strings > 1.8x English): `nav.join`/`join.accept` (es 2.0, fr 2.1), `members.maxUses` fr 2.4, `appearance.reset` es 2.1, `card.moveUndone` de 2.6 / bn 2.3, `notif.markAll` de/bn 2.0. Most long ratios come from "workspace" compounds (es, fr), so check sidebar/switcher width in es and fr first.
8. **RTL (ar, fa, ur)**: English Latin words remain inside RTL sentences in 17 / 15 / 18 strings. Most are legitimate (Enter, Shift, Ctrl, Escape, JSON, PDF, https, name@example.com, #general, Lanefold) but they need bidi isolation (`<bdi>`/`dir=auto` or LRM) so "Ctrl+C" and `name@example.com` do not scramble. Not legitimate: `My Day` (ar), `Storage` (`errors.E_STORAGE_*`, ar), see ar packet.
9. **Trailing punctuation**: thai drops the final full stop in 289 strings (normal in Thai, ignore). Others: ru `common.on/off` abbreviations "Вкл."/"Выкл." (trailing dot added, OK), `members.days` "дн."; ja/ko `onboarding.tipPrefix/tipSearch` drop the colon/comma (fragments assembled in UI; check word order since Japanese/Korean put the verb last and these fragments are concatenated around key caps); ar/zh `onboarding.tipAdd` comma changed to ، / ， (fine). fr `billing.changePlan`, `billing.grace`, `errors.member_limit_reached`, `errors.invalid_job` use a straight apostrophe `'` while the rest of fr uses `’`: typographic inconsistency.
10. **Register**: es/pt/de/hi/zh/bn mostly use informal address (tú/você/du/आप/你/আপনি) consistently; fr uses vous. ar uses masculine singular imperative (acceptable default). No tú/usted mixing found in the 60 strings read.

## 2. Mechanical checks, counts per language

| lang | missing | extra | placeholder | markup | identical-to-EN | RTL English words | len ratio>1.8 | punct diff | mixed script |
|---|---|---|---|---|---|---|---|---|---|
| ar | 0 | 12 | 0 | 0 | 83 | 17 | 0 | 1 | 0 |
| bn | 0 | 0 | 0 | 0 | 83 | 0 | 7 | 0 | 0 |
| de | 0 | 0 | 0 | 0 | 115 | 0 | 6 | 0 | 0 |
| es | 0 | 3 | 0 | 0 | 90 | 0 | 15 | 0 | 0 |
| fa | 0 | 0 | 0 | 0 | 83 | 15 | 7 | 1 | 0 |
| fr | 0 | 3 | 0 | 0 | 95 | 0 | 28 | 0 | 0 |
| hi | 0 | 0 | 0 | 0 | 87 | 0 | 2 | 0 | 0 |
| id | 3 | 0 | 0 | 0 | 104 | 0 | 3 | 0 | 0 |
| it | 0 | 3 | 0 | 0 | 102 | 0 | 4 | 0 | 0 |
| ja | 3 | 0 | 0 | 0 | 85 | 0 | 0 | 2 | 0 |
| ko | 3 | 0 | 0 | 0 | 85 | 0 | 0 | 2 | 0 |
| pt | 0 | 3 | 0 | 0 | 93 | 0 | 3 | 0 | 0 |
| ru | 0 | 6 | 0 | 0 | 91 | 0 | 14 | 3 | 0 |
| sw | 0 | 0 | 0 | 0 | 91 | 0 | 20 | 0 | 0 |
| th | 3 | 0 | 0 | 0 | 91 | 0 | 4 | 289 | 0 |
| tr | 0 | 0 | 0 | 0 | 93 | 0 | 6 | 0 | 0 |
| ur | 0 | 0 | 0 | 0 | 84 | 18 | 6 | 1 | 0 |
| vi | 3 | 0 | 0 | 0 | 85 | 0 | 5 | 0 | 0 |
| zh | 3 | 0 | 0 | 0 | 84 | 0 | 0 | 1 | 0 |

`missing`/`extra` are plural categories (see finding 3), not defects. `identical` (first-pass counts) includes the 83 shared untranslated keys plus a few legit cognates (Color, Plan, Chat, Actions, Description, Mode, Position).

## 3. Core term table per language

Columns: Workspace (`nav.workspace`), Board (`nav.board`) / Boards (`nav.boards`), Card (`nav.card`), My Day (`nav.myDay`), Inbox (`nav.inbox`), Chat (`nav.chat`), Lane (`lane.add` | `inbox.noLanes`). "Flag" lists inconsistencies found.

| lang | Workspace | Board / Boards | Card | My Day | Inbox | Chat | Lane (add \| noLanes) | Flag |
|---|---|---|---|---|---|---|---|---|
| ar | مساحة العمل | اللوحة / اللوحات | البطاقة | يومي | الوارد | الدردشة | إضافة مسار \| لا تحتوي هذه اللوحة على قوائم بعد. | My Day English in 2 strings; lane مسار vs قوائم; Board/Card carry article ال in nav labels |
| bn | ওয়ার্কস্পেস | বোর্ড / বোর্ড | কার্ড | আমার দিন | ইনবক্স | চ্যাট | লেন যোগ করুন \| এই বোর্ডে এখনও কোনো লেন নেই। | My Day English in 2 strings; Board = বোর্ড for singular and plural |
| de | Workspace | Board / Boards | Karte | Mein Tag | Posteingang | Chat | Lane hinzufügen \| Dieses Board hat noch keine Lanes. | My Day English in 2 strings; defaultLanes "To do" vs "Zu erledigen"; Workspace/Board/Lane/Chat are English loanwords (consistent) |
| es | Espacio de trabajo | Tablero / Tableros | Tarjeta | Mi día | Bandeja de entrada | Chat | Añadir un carril \| Este tablero aún no tiene listas. | lane: carril vs listas |
| fa | فضای کار | بورد / بوردها | کارت | روز من | صندوق ورودی | گفتگو | افزودن لِین \| این برد هنوز ستونی ندارد. | lane لِین vs ستون |
| fr | Espace de travail | Tableau / Tableaux | Carte | Ma journée | Boîte de réception | Chat | Ajouter une colonne \| Ce tableau n’a pas encore de colonnes. | consistent (colonne) |
| hi | वर्कस्पेस | बोर्ड / बोर्ड | कार्ड | My Day | इनबॉक्स | चैट | लेन जोड़ें \| इस बोर्ड में अभी कोई लेन नहीं है। | My Day English everywhere; lane = transliterated लेन (unnatural) |
| id | Workspace | Board / Board | Kartu | My Day | Kotak masuk | Obrolan | Tambah lane \| Papan ini belum punya lajur. | My Day English; lane vs lajur; Board = Board |
| it | Workspace | Board / Board | Card | La mia giornata | Posta in arrivo | Chat | Aggiungi una lane \| Questa bacheca non ha ancora colonne. | Card left English (Card) while others Italian; lane vs colonne |
| ja | ワークスペース | ボード / ボード | カード | 今日の予定 | 受信箱 | チャット | レーンを追加 \| このボードにはまだリストがありません。 | レーン vs リスト; My Day mixed |
| ko | 워크스페이스 | 보드 / 보드 | 카드 | 나의 하루 | 받은 알림 | 채팅 | 레인 추가 \| 이 보드에는 아직 목록이 없습니다. | Inbox wrong (받은 알림); 레인 vs 목록 |
| pt | Workspace | Quadro / Quadros | Cartão | Meu Dia | Caixa de entrada | Chat | Adicionar uma raia \| Este quadro ainda não tem listas. | lane: raia vs listas; Workspace kept English (OK, but es-style "espaço de trabalho" absent) |
| ru | Рабочее пространство | Доска / Доски | Карточка | My Day | Входящие | Чат | Добавить колонку \| На этой доске пока нет колонок. | My Day English; Workspace flagged inconsistent by script (check manually); Доска/Доски |
| sw | Nafasi ya kazi | Bodi / Bodi | Kadi | My Day | Kikasha | Gumzo | Ongeza njia \| Ubao huu hauna safu bado. | My Day English; njia vs safu |
| th | เวิร์กสเปซ | บอร์ด / บอร์ด | การ์ด | My Day | กล่องข้อความ | แชต | เพิ่มเลน \| บอร์ดนี้ยังไม่มีเลน | My Day English; ok |
| tr | Çalışma alanı | Pano / Panolar | Kart | My Day | Gelen kutusu | Sohbet | Şerit ekle \| Bu panoda henüz liste yok. | My Day English; Şerit vs liste |
| ur | ورک اسپیس | بورڈ / بورڈز | کارڈ | میرا دن | ان باکس | چیٹ | لین شامل کریں \| اس بورڈ میں ابھی کوئی لین نہیں۔ | My Day 2 English; lane لین |
| vi | Không gian làm việc | Bảng / Bảng | Thẻ | Ngày của tôi | Hộp thư | Trò chuyện | Thêm cột \| Bảng này chưa có cột nào. | My Day 2 English; cột consistent |
| zh | 工作区 | 看板 / 看板 | 卡片 | 我的一天 | 收件箱 | 聊天 | 添加泳道 \| 此看板还没有列表。 | My Day English in 2 strings; lane 泳道 vs 列表; Board and Boards identical 看板 |

## 4. Keys still in English in every language (83 in the first pass; 183 after the 2026-11-03 re-check, list at the end)

Translate these first (all languages). Grouped:

- **chat** (30): `chat.boardChatTab`, `chat.boardChats`, `chat.channels`, `chat.composerLabel`, `chat.conversations`, `chat.delete`, `chat.discard`, `chat.edit`, `chat.kind.channel`, `chat.kind.group`, `chat.messages`, `chat.mute`, `chat.nameLabel`, `chat.person`, `chat.searchPeople`, `chat.noMatches`, `chat.pinned`, `chat.unpin`, `chat.pinnedToast`, `chat.unpinnedToast`, `chat.pinnedMessages`, `chat.pinnedHide`, `chat.pinnedCount`, `chat.reactions`, `chat.replyLabel`, `chat.retry`, `chat.send`, `chat.thread`, `chat.unmute`, `chat.untitled`
- **members** (24): `members.col.actions`, `members.col.expires`, `members.col.joined`, `members.col.name`, `members.col.role`, `members.col.status`, `members.col.uses`, `members.copied`, `members.done`, `members.emailPlaceholder`, `members.invitesTitle`, `members.kind.invite`, `members.listTitle`, `members.revoke`, `members.role`, `members.role.owner`, `members.role.admin`, `members.role.member`, `members.role.viewer`, `members.status.active`, `members.status.expired`, `members.status.revoked`, `members.status.used`, `members.title`
- **tpl** (10): `tpl.sprint`, `tpl.personal`, `tpl.lane.backlog`, `tpl.lane.review`, `tpl.lane.done`, `tpl.lane.ideas`, `tpl.lane.drafting`, `tpl.lane.scheduled`, `tpl.lane.published`, `tpl.lane.doing`
- **shortcuts** (6): `shortcuts.general`, `shortcuts.create`, `shortcuts.search`, `shortcuts.goBoards`, `shortcuts.goInbox`, `shortcuts.goChat`
- **onboarding** (6): `onboarding.step.intent`, `onboarding.step.name`, `onboarding.step.invite`, `onboarding.skip`, `onboarding.next`, `onboarding.done`
- **notif** (4): `notif.bell`, `notif.someone`, `notif.title`, `notif.unread`
- **shell** (1): `shell.searchHint`
- **nav** (1): `nav.members`
- **setup** (1): `setup.dismiss`

Legit to keep: `shell.searchHint` (Ctrl K), `members.emailPlaceholder`, `appearance.accent.*` brand colours in some languages.

## 5. Fluency and register review, 8 main languages (60 most visible strings each)

Suspected issues, with key, current text, proposed fix. "Sev" H = confuses/mislabels, M = awkward, L = polish.

### es

Overall: fluent, neutral Latin-American/Spain mix ("Añadir"/"Intro"/"Mayús" are Spain; "Pulsa" tú form); minor term inconsistency.

| key | current | proposed fix | sev |
|---|---|---|---|
| `inbox.noLanes` | Este tablero aún no tiene listas. | Este tablero aún no tiene carriles. | H |
| `errors.invalid_job` | Revisa los datos del empleo... | Revisa los datos del trabajo/oferta... (confirm what "job" means in the product; if background job, "tarea") | M |
| `billing.goToCheckout` | Ir al pago | Ir a pagar (acceptable); keep "pago" consistent with `billing.upgradeBody` "El pago llegará" | L |
| `boards.starRemove` | Quitar destacado | Quitar de destacados | L |
| `nav.workspace` | Espacio de trabajo | OK but long (2.1x) in narrow sidebar; consider "Espacio" | L |

### fr

Overall: fluent, vous register, natural; typographic apostrophe inconsistency only.

| key | current | proposed fix | sev |
|---|---|---|---|
| `billing.changePlan, billing.grace, errors.member_limit_reached, errors.invalid_job` | straight apostrophes d' | typographic ’ like the rest | L |
| `billing.goToCheckout` | Passer à la caisse | Passer au paiement (caisse is retail wording) | M |
| `billing.* "offre"` | offre | Consistent use of "offre"; "forfait" or "abonnement" are more common for SaaS plans, owner decision | L |
| `errors.invalid_job` | détails de l'offre d'emploi | OK if job board; else "tâche" | M |

### pt

Overall: fluent pt-BR, informal você; keeps "Workspace" in English by design; one weak term (Cobrança).

| key | current | proposed fix | sev |
|---|---|---|---|
| `nav.billing` | Cobrança | Faturamento (cobrança reads as "debt collection") | M |
| `inbox.noLanes` | listas | raias | H |
| `errors.unknown` | Tente de novo | Tente novamente (more formal, matches product tone) | L |

### de

Overall: fluent, informal du consistently; mixes English loanwords and German ("To do"/"Zu erledigen").

| key | current | proposed fix | sev |
|---|---|---|---|
| `boards.defaultLanes` | Lanes „To do“, „In Arbeit“ und „Erledigt“ | Use "Zu erledigen" to match `boards.lane.todo` | H |
| `myDay.emptyBody` | zu My Day hinzufügst | zu „Mein Tag“ hinzufügst | H |
| `errors.member_limit_reached` | Bitte einen Admin, den Tarif zu upgraden. | Bitte einen Admin, den Tarif zu erweitern. | M |
| `billing.goToCheckout` | Zur Kasse | OK (Zum Bezahlen) | L |

### hi

Overall: understandable but the most anglicised set; "My Day" untranslated; unnatural lane term.

| key | current | proposed fix | sev |
|---|---|---|---|
| `nav.myDay (+ 5 more)` | My Day | मेरा दिन | H |
| `boards.lane.todo / boards.defaultLanes` | करने को | करना है / करने के लिए | M |
| `lane.add` | लेन जोड़ें | सूची जोड़ें or कॉलम जोड़ें (लेन is an unnatural transliteration; pick one) | M |
| `boards.backToBoards` | बोर्ड पर वापस जाएँ | बोर्ड पर वापस जाएँ is fine; plural unmarked | L |
| `boards.archive` | बोर्ड संग्रहित करें | बोर्ड संग्रहीत करें / आर्काइव करें | L |
| `errors.invalid_job` | नौकरी का विवरण | OK for jobs board; if background job use "कार्य" | M |
| `errors.E_FILE_TYPE` | चित्र | फ़ोटो/इमेज | L |

### bn

Overall: mostly fluent; 3 awkward calques.

| key | current | proposed fix | sev |
|---|---|---|---|
| `myDay.emptyBody + 1` | My Day-তে | আমার দিন-এ | H |
| `card.overdue` | মেয়াদোত্তীর্ণ | সময়সীমা পেরিয়েছে / বিলম্বিত | H |
| `shell.paletteGroupActions` | কাজ | অ্যাকশন | M |
| `shell.notFoundTitle` | এই পেজটি নেই | এই পেজটি খুঁজে পাওয়া যায়নি | M |
| `errors.workspace_read_only` | শুধু পড়া যাবে | শুধু দেখা যাবে / শুধুমাত্র পঠনযোগ্য | M |
| `errors.validation` | কিছু ঘর ঠিক করতে হবে | কিছু ফিল্ড ঠিক করতে হবে | L |

### ar

Overall: fluent MSA, masculine imperative; term and bidi issues.

| key | current | proposed fix | sev |
|---|---|---|---|
| `inbox.noLanes` | قوائم | مسارات | H |
| `myDay.emptyBody, shell.notFoundAction` | My Day | يومي | H |
| `errors.E_STORAGE_NEEDS_PACK, E_STORAGE_OFF` | تبويب Storage | تبويب التخزين (if the UI tab is localized, else keep) | M |
| `nav.board / nav.card` | اللوحة / البطاقة | Remove definite article when used as labels: لوحة / بطاقة | L |
| `card.addHint` | يضيف Enter البطاقة. | Wrap Enter/Shift in <kbd>/bdi for bidi | M |
| `chat.suggestionsHint` | Enter | same bidi isolation | L |

### zh

Overall: fluent, concise, 你 register; "My Day" left in 2 body strings.

| key | current | proposed fix | sev |
|---|---|---|---|
| `myDay.emptyBody` | My Day | 我的一天 | H |
| `inbox.noLanes` | 列表 | 泳道 | H |
| `nav.billing` | 账单 | OK; "计费" if it means billing settings | L |
| `billing.goToCheckout` | 前往结账 | 前往付款 (结账 is retail-ish, acceptable) | L |

## 6. Review packets: top 30 strings a native speaker should check first

Order: term-inconsistent strings, layout-risk labels, RTL/punctuation flags, then the most visible nav/board/card/chat/billing/error strings. The 83 shared untranslated keys are listed once in section 4, not repeated here.

### ar (30)

| # | key | EN | ar | why |
|---|---|---|---|---|
| 1 | `shell.notFoundAction` | Go to My Day | الانتقال إلى My Day | My Day left in English |
| 2 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | البطاقات التي تضيفها إلى My Day والبطاقات المستحقة اليوم تظهر هنا. | My Day left in English |
| 3 | `inbox.noLanes` | This board has no lanes yet. | لا تحتوي هذه اللوحة على قوائم بعد. | lane term differs from lane.add |
| 4 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | ابدأ بمسارات: للإنجاز، قيد التنفيذ، مكتمل | lane term vs lane.* labels |
| 5 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | يضيف Enter البطاقة. يبدأ Shift+Enter سطرًا جديدًا. عدة أسطر تضيف عدة بطاقات. | Latin words inside RTL: Enter,Shift,Enter |
| 6 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | اضغط على المسافة للالتقاط، وعلى مفاتيح الأسهم للتحريك، وعلى المسافة للإفلات، وعلى Escape للإلغاء. | Latin words inside RTL: Escape |
| 7 | `appearance.transfer.export` | Export as JSON | تصدير بصيغة JSON | Latin words inside RTL: JSON |
| 8 | `appearance.transfer.import` | Import from JSON | استيراد من JSON | Latin words inside RTL: JSON |
| 9 | `chat.creatingGeneral` | Creating #general… | جارٍ إنشاء #general… | Latin words inside RTL: general |
| 10 | `join.description` | You were invited to a Lanefold workspace. Joining adds it to your account. | تمت دعوتك إلى مساحة عمل في Lanefold. الانضمام يضيفها إلى حسابك. | Latin words inside RTL: Lanefold |
| 11 | `members.copyFailed` | Copying was blocked. The link is selected: press Ctrl+C. | تم حظر النسخ. الرابط محدد: اضغط Ctrl+C. | Latin words inside RTL: Ctrl |
| 12 | `members.emailInvalid` | Enter a valid email address, like name@example.com, or leave it empty. | أدخل بريدًا إلكترونيًا صالحًا مثل name@example.com، أو اتركه فارغًا. | Latin words inside RTL: name,example,com |
| 13 | `onboarding.intentLegend` | What will you use Lanefold for? | فيمَ ستستخدم Lanefold؟ | Latin words inside RTL: Lanefold |
| 14 | `cd.linkInvalid` | Enter a web address starting with https://. | أدخل عنوان ويب يبدأ بـ https://. | Latin words inside RTL: https |
| 15 | `cd.commentPlaceholder` | Write a comment. Ctrl+Enter posts it. | اكتب تعليقًا. اضغط Ctrl+Enter لنشره. | Latin words inside RTL: Ctrl,Enter |
| 16 | `errors.E_STORAGE_NEEDS_PACK` | File uploads are not switched on yet. Ask the site owner to add a storage pack in the Storage tab of the app dashboard. | رفع الملفات غير مفعّل بعد. اطلب من مالك الموقع إضافة حزمة تخزين في تبويب Storage بلوحة تحكم التطبيق. | Latin words inside RTL: Storage |
| 17 | `errors.E_STORAGE_OFF` | File storage is turned off for this site. Ask the site owner to turn it on in the Storage tab. | تخزين الملفات متوقف لهذا الموقع. اطلب من مالك الموقع تشغيله في تبويب Storage. | Latin words inside RTL: Storage |
| 18 | `errors.E_FILE_TYPE` | That kind of file cannot be attached. Pick an image, PDF or document. | لا يمكن إرفاق هذا النوع من الملفات. اختر صورة أو ملف PDF أو مستندًا. | Latin words inside RTL: PDF |
| 19 | `chat.suggestionsHint` | Suggestions available: {n}. Use the up and down arrows, then Enter to choose. | الاقتراحات المتاحة: {n}. استخدم السهمين لأعلى ولأسفل ثم Enter للاختيار. | Latin words inside RTL: Enter |
| 20 | `onboarding.tipAdd` | to add a card, | لإضافة بطاقة، | ending punctuation differs |
| 21 | `nav.workspace` | Workspace | مساحة العمل | high visibility |
| 22 | `nav.myDay` | My Day | يومي | high visibility |
| 23 | `nav.inbox` | Inbox | الوارد | high visibility |
| 24 | `nav.boards` | Boards | اللوحات | high visibility |
| 25 | `nav.board` | Board | اللوحة | high visibility |
| 26 | `nav.card` | Card | البطاقة | high visibility |
| 27 | `nav.billing` | Billing | الفوترة | high visibility |
| 28 | `nav.onboarding` | Create your workspace | أنشئ مساحة عملك | high visibility |
| 29 | `boards.lane.todo` | To do | للإنجاز | high visibility |
| 30 | `boards.lane.doing` | In progress | قيد التنفيذ | high visibility |

### bn (30)

| # | key | EN | bn | why |
|---|---|---|---|---|
| 1 | `shell.notFoundAction` | Go to My Day | My Day-তে যান | My Day left in English |
| 2 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | My Day-তে যোগ করা কার্ড এবং আজ যেগুলোর সময়সীমা, সেগুলো এখানে দেখা যাবে। | My Day left in English |
| 3 | `inbox.noLanes` | This board has no lanes yet. | এই বোর্ডে এখনও কোনো লেন নেই। | lane term differs from lane.add |
| 4 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | করণীয়, চলমান ও সম্পন্ন লেন দিয়ে শুরু করুন | lane term vs lane.* labels |
| 5 | `card.moveUndone` | Move undone. | সরানো ফিরিয়ে নেওয়া হয়েছে। | long x2.3 |
| 6 | `myDay.done` | Card marked done. | কার্ড সম্পন্ন হিসেবে চিহ্নিত হয়েছে। | long x2.1 |
| 7 | `notif.markAll` | Mark all read | সব পঠিত হিসেবে চিহ্নিত করুন | long x2.1 |
| 8 | `myDay.markDone` | Mark “{title}” done | “{title}” সম্পন্ন হিসেবে চিহ্নিত করুন | long x1.9 |
| 9 | `inbox.markDone` | Mark “{title}” done | “{title}” সম্পন্ন হিসেবে চিহ্নিত করুন | long x1.9 |
| 10 | `boards.saved` | Board saved. | বোর্ড সংরক্ষিত হয়েছে। | long x1.8 |
| 11 | `workspaceSettings.renamed` | Workspace renamed. | ওয়ার্কস্পেসের নাম বদলানো হয়েছে। | long x1.8 |
| 12 | `card.overdue` | Overdue | মেয়াদোত্তীর্ণ | means expired |
| 13 | `nav.workspace` | Workspace | ওয়ার্কস্পেস | high visibility |
| 14 | `nav.myDay` | My Day | আমার দিন | high visibility |
| 15 | `nav.inbox` | Inbox | ইনবক্স | high visibility |
| 16 | `nav.boards` | Boards | বোর্ড | high visibility |
| 17 | `nav.board` | Board | বোর্ড | high visibility |
| 18 | `nav.card` | Card | কার্ড | high visibility |
| 19 | `nav.billing` | Billing | বিলিং | high visibility |
| 20 | `nav.onboarding` | Create your workspace | আপনার ওয়ার্কস্পেস তৈরি করুন | high visibility |
| 21 | `boards.lane.todo` | To do | করণীয় | high visibility |
| 22 | `boards.lane.doing` | In progress | চলমান | high visibility |
| 23 | `boards.lane.done` | Done | সম্পন্ন | high visibility |
| 24 | `lane.add` | Add a lane | লেন যোগ করুন | high visibility |
| 25 | `lane.nameRequired` | Enter a name for the lane. | লেনের একটি নাম লিখুন। | high visibility |
| 26 | `shell.notFoundTitle` | This page does not exist | এই পেজটি নেই | high visibility |
| 27 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter চাপলে যোগ হবে। Shift+Enter নতুন লাইন শুরু করে। কয়েক লাইনে কয়েকটি কার্ড যোগ হবে। | high visibility |
| 28 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | তুলতে স্পেস, সরাতে অ্যারো কী, রাখতে স্পেস এবং বাতিল করতে Escape চাপুন। | high visibility |
| 29 | `card.tooMany` | Add up to 20 cards at once. | একসঙ্গে সর্বোচ্চ ২০টি কার্ড যোগ করা যায়। | high visibility |
| 30 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | আরও সদস্য, বড় ফাইল ও বেশি স্টোরেজ। চেকআউট বিলিং টুলের সঙ্গে আসবে। | high visibility |

### de (30)

| # | key | EN | de | why |
|---|---|---|---|---|
| 1 | `shell.notFoundAction` | Go to My Day | Zu My Day | My Day left in English |
| 2 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | Karten, die du zu My Day hinzufügst, und heute fällige Karten erscheinen hier. | My Day left in English |
| 3 | `inbox.noLanes` | This board has no lanes yet. | Dieses Board hat noch keine Lanes. | lane term differs from lane.add |
| 4 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | Mit den Lanes „To do“, „In Arbeit“ und „Erledigt“ starten | lane term vs lane.* labels |
| 5 | `card.moveUndone` | Move undone. | Verschieben rückgängig gemacht. | long x2.6 |
| 6 | `chat.unmuted` | Conversation unmuted. | Stummschaltung der Unterhaltung aufgehoben. | long x2.0 |
| 7 | `notif.markAll` | Mark all read | Alle als gelesen markieren | long x2.0 |
| 8 | `tpl.content.desc` | Ideas to Published. | Von der Idee bis zur Veröffentlichung. | long x2.0 |
| 9 | `onboarding.tipAdd` | to add a card, | um eine Karte hinzuzufügen, | long x1.9 |
| 10 | `cd.commentDeleteBody` | This cannot be undone. | Das kann nicht rückgängig gemacht werden. | long x1.9 |
| 11 | `nav.workspace` | Workspace | Workspace | high visibility |
| 12 | `nav.myDay` | My Day | Mein Tag | high visibility |
| 13 | `nav.inbox` | Inbox | Posteingang | high visibility |
| 14 | `nav.boards` | Boards | Boards | high visibility |
| 15 | `nav.board` | Board | Board | high visibility |
| 16 | `nav.card` | Card | Karte | high visibility |
| 17 | `nav.billing` | Billing | Abrechnung | high visibility |
| 18 | `nav.onboarding` | Create your workspace | Workspace erstellen | high visibility |
| 19 | `boards.lane.todo` | To do | Zu erledigen | high visibility |
| 20 | `boards.lane.doing` | In progress | In Arbeit | high visibility |
| 21 | `boards.lane.done` | Done | Erledigt | high visibility |
| 22 | `lane.add` | Add a lane | Lane hinzufügen | high visibility |
| 23 | `lane.nameRequired` | Enter a name for the lane. | Gib einen Namen für die Lane ein. | high visibility |
| 24 | `shell.notFoundTitle` | This page does not exist | Diese Seite gibt es nicht | high visibility |
| 25 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter fügt hinzu. Umschalt+Enter beginnt eine neue Zeile. Mehrere Zeilen ergeben mehrere Karten. | high visibility |
| 26 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | Mit der Leertaste aufnehmen, mit den Pfeiltasten bewegen, mit der Leertaste ablegen, mit Escape abbrechen. | high visibility |
| 27 | `card.overdue` | Overdue | Überfällig | high visibility |
| 28 | `card.tooMany` | Add up to 20 cards at once. | Füge bis zu 20 Karten auf einmal hinzu. | high visibility |
| 29 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | Mehr Mitglieder, größere Dateien und mehr Speicherplatz. Der Checkout kommt mit den Abrechnungswerkzeugen. | high visibility |
| 30 | `billing.grace` | Over the plan limits. Everything keeps working until {date}. | Tariflimits überschritten. Alles funktioniert weiter bis {date}. | high visibility |

### es (30)

| # | key | EN | es | why |
|---|---|---|---|---|
| 1 | `inbox.noLanes` | This board has no lanes yet. | Este tablero aún no tiene listas. | lane term differs from lane.add |
| 2 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | Empezar con los carriles Por hacer, En curso y Hecho | lane term vs lane.* labels |
| 3 | `onboarding.nameLabel` | Workspace name | Nombre del espacio de trabajo | long x2.1 |
| 4 | `appearance.reset` | Reset to defaults | Restablecer valores predeterminados | long x2.1 |
| 5 | `nav.join` | Join workspace | Unirse al espacio de trabajo | long x2.0 |
| 6 | `join.accept` | Join workspace | Unirse al espacio de trabajo | long x2.0 |
| 7 | `cd.resize` | Resize the card panel | Cambiar el tamaño del panel de la tarjeta | long x2.0 |
| 8 | `members.leave` | Leave workspace | Salir del espacio de trabajo | long x1.9 |
| 9 | `cd.checklistTitle` | Checklist title | Título de la lista de tareas | long x1.9 |
| 10 | `workspace.switcherLabel` | Switch workspace | Cambiar de espacio de trabajo | long x1.8 |
| 11 | `workspace.new` | New workspace | Nuevo espacio de trabajo | long x1.8 |
| 12 | `workspace.none` | No workspace | Sin espacio de trabajo | long x1.8 |
| 13 | `nav.workspace` | Workspace | Espacio de trabajo | high visibility |
| 14 | `nav.myDay` | My Day | Mi día | high visibility |
| 15 | `nav.inbox` | Inbox | Bandeja de entrada | high visibility |
| 16 | `nav.boards` | Boards | Tableros | high visibility |
| 17 | `nav.board` | Board | Tablero | high visibility |
| 18 | `nav.card` | Card | Tarjeta | high visibility |
| 19 | `nav.billing` | Billing | Facturación | high visibility |
| 20 | `nav.onboarding` | Create your workspace | Crea tu espacio de trabajo | high visibility |
| 21 | `boards.lane.todo` | To do | Por hacer | high visibility |
| 22 | `boards.lane.doing` | In progress | En curso | high visibility |
| 23 | `boards.lane.done` | Done | Hecho | high visibility |
| 24 | `lane.add` | Add a lane | Añadir un carril | high visibility |
| 25 | `lane.nameRequired` | Enter a name for the lane. | Escribe un nombre para el carril. | high visibility |
| 26 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | Aquí aparecen las tarjetas que añades a Mi día y las que vencen hoy. | high visibility |
| 27 | `shell.notFoundTitle` | This page does not exist | Esta página no existe | high visibility |
| 28 | `shell.notFoundAction` | Go to My Day | Ir a Mi día | high visibility |
| 29 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Intro añade. Mayús+Intro inicia una línea nueva. Varias líneas añaden varias tarjetas. | high visibility |
| 30 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | Pulsa la barra espaciadora para recoger, las flechas para mover, espacio para soltar y Escape para cancelar. | high visibility |

### fa (30)

| # | key | EN | fa | why |
|---|---|---|---|---|
| 1 | `inbox.noLanes` | This board has no lanes yet. | این برد هنوز ستونی ندارد. | lane term differs from lane.add |
| 2 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | شروع با لِین‌های انجام‌نشده، در حال انجام و انجام‌شده | lane term vs lane.* labels |
| 3 | `notif.markAll` | Mark all read | علامت‌گذاری همه به‌عنوان خوانده‌شده | long x2.7 |
| 4 | `myDay.markDone` | Mark “{title}” done | علامت‌گذاری «{title}» به‌عنوان انجام‌شده | long x2.1 |
| 5 | `myDay.done` | Card marked done. | کارت به‌عنوان انجام‌شده علامت خورد. | long x2.1 |
| 6 | `inbox.markDone` | Mark “{title}” done | علامت‌گذاری «{title}» به‌عنوان انجام‌شده | long x2.1 |
| 7 | `tpl.personal.desc` | To do, Doing, Done. | انجام‌نشده، در حال انجام، انجام‌شده. | long x1.9 |
| 8 | `appearance.contrast.adjust` | Use {hex} instead | به‌جای آن از {hex} استفاده کنید | long x1.8 |
| 9 | `errors.too_long` | That is too long. | این مقدار بیش از حد طولانی است. | long x1.8 |
| 10 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter کارت را اضافه می‌کند. Shift+Enter خط جدید می‌سازد. چند خط، چند کارت اضافه می‌کند. | Latin words inside RTL: Enter,Shift,Enter |
| 11 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | برای برداشتن فاصله، برای جابه‌جایی کلیدهای جهت‌دار، برای رها کردن فاصله و برای لغو Escape را بزنید. | Latin words inside RTL: Escape |
| 12 | `appearance.transfer.export` | Export as JSON | برون‌بری به‌صورت JSON | Latin words inside RTL: JSON |
| 13 | `appearance.transfer.import` | Import from JSON | درون‌ریزی از JSON | Latin words inside RTL: JSON |
| 14 | `chat.creatingGeneral` | Creating #general… | در حال ساخت #general… | Latin words inside RTL: general |
| 15 | `join.description` | You were invited to a Lanefold workspace. Joining adds it to your account. | شما به یک فضای کار در Lanefold دعوت شده‌اید. با پیوستن، به حساب شما اضافه می‌شود. | Latin words inside RTL: Lanefold |
| 16 | `members.copyFailed` | Copying was blocked. The link is selected: press Ctrl+C. | کپی مسدود شد. پیوند انتخاب شده است: Ctrl+C را بزنید. | Latin words inside RTL: Ctrl |
| 17 | `members.emailInvalid` | Enter a valid email address, like name@example.com, or leave it empty. | یک نشانی ایمیل معتبر مثل name@example.com وارد کنید، یا خالی بگذارید. | Latin words inside RTL: name,example,com |
| 18 | `onboarding.intentLegend` | What will you use Lanefold for? | از Lanefold برای چه استفاده می‌کنید؟ | Latin words inside RTL: Lanefold |
| 19 | `cd.linkInvalid` | Enter a web address starting with https://. | نشانی وبی وارد کنید که با https:// شروع شود. | Latin words inside RTL: https |
| 20 | `cd.commentPlaceholder` | Write a comment. Ctrl+Enter posts it. | نظری بنویسید. Ctrl+Enter آن را ارسال می‌کند. | Latin words inside RTL: Ctrl,Enter |
| 21 | `errors.E_STORAGE_NEEDS_PACK` | File uploads are not switched on yet. Ask the site owner to add a storage pack in the Storage tab of the app dashboard. | بارگذاری فایل هنوز روشن نشده است. از مالک سایت بخواهید در زبانهٔ Storage داشبورد برنامه یک بستهٔ ذخیره‌سازی اضافه کند. | Latin words inside RTL: Storage |
| 22 | `errors.E_STORAGE_OFF` | File storage is turned off for this site. Ask the site owner to turn it on in the Storage tab. | ذخیره‌سازی فایل برای این سایت خاموش است. از مالک سایت بخواهید آن را در زبانهٔ Storage روشن کند. | Latin words inside RTL: Storage |
| 23 | `errors.E_FILE_TYPE` | That kind of file cannot be attached. Pick an image, PDF or document. | این نوع فایل را نمی‌توان پیوست کرد. یک تصویر، PDF یا سند انتخاب کنید. | Latin words inside RTL: PDF |
| 24 | `chat.suggestionsHint` | Suggestions available: {n}. Use the up and down arrows, then Enter to choose. | پیشنهادها: {n}. با کلیدهای بالا و پایین حرکت کنید و با Enter انتخاب کنید. | Latin words inside RTL: Enter |
| 25 | `onboarding.tipAdd` | to add a card, | برای افزودن کارت، | ending punctuation differs |
| 26 | `nav.workspace` | Workspace | فضای کار | high visibility |
| 27 | `nav.myDay` | My Day | روز من | high visibility |
| 28 | `nav.inbox` | Inbox | صندوق ورودی | high visibility |
| 29 | `nav.boards` | Boards | بوردها | high visibility |
| 30 | `nav.board` | Board | بورد | high visibility |

### fr (30)

| # | key | EN | fr | why |
|---|---|---|---|---|
| 1 | `inbox.noLanes` | This board has no lanes yet. | Ce tableau n’a pas encore de colonnes. | lane term differs from lane.add |
| 2 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | Commencer avec les colonnes À faire, En cours et Terminé | lane term vs lane.* labels |
| 3 | `workspaceSettings.emptyTitle` | No workspace yet | Aucun espace de travail pour l’instant | long x2.4 |
| 4 | `billing.emptyTitle` | No workspace yet | Aucun espace de travail pour l’instant | long x2.4 |
| 5 | `members.maxUses` | Maximum uses | Nombre maximal d'utilisations | long x2.4 |
| 6 | `boards.emptyTitle` | No boards yet | Aucun tableau pour l’instant | long x2.2 |
| 7 | `lane.empty` | No cards yet | Aucune carte pour l’instant | long x2.2 |
| 8 | `nav.join` | Join workspace | Rejoindre l'espace de travail | long x2.1 |
| 9 | `chat.noRepliesTitle` | No replies yet | Aucune réponse pour l'instant | long x2.1 |
| 10 | `join.accept` | Join workspace | Rejoindre l'espace de travail | long x2.1 |
| 11 | `appearance.mode.darkDescription` | Dim surfaces for low light. | Surfaces tamisées pour les environnements peu éclairés. | long x2.0 |
| 12 | `chat.unmuted` | Conversation unmuted. | Sourdine désactivée pour la conversation. | long x2.0 |
| 13 | `nav.workspace` | Workspace | Espace de travail | high visibility |
| 14 | `nav.myDay` | My Day | Ma journée | high visibility |
| 15 | `nav.inbox` | Inbox | Boîte de réception | high visibility |
| 16 | `nav.boards` | Boards | Tableaux | high visibility |
| 17 | `nav.board` | Board | Tableau | high visibility |
| 18 | `nav.card` | Card | Carte | high visibility |
| 19 | `nav.billing` | Billing | Facturation | high visibility |
| 20 | `nav.onboarding` | Create your workspace | Créez votre espace de travail | high visibility |
| 21 | `boards.lane.todo` | To do | À faire | high visibility |
| 22 | `boards.lane.doing` | In progress | En cours | high visibility |
| 23 | `boards.lane.done` | Done | Terminé | high visibility |
| 24 | `lane.add` | Add a lane | Ajouter une colonne | high visibility |
| 25 | `lane.nameRequired` | Enter a name for the lane. | Saisissez un nom pour la colonne. | high visibility |
| 26 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | Les cartes que vous ajoutez à Ma journée et celles à échéance aujourd’hui apparaissent ici. | high visibility |
| 27 | `shell.notFoundTitle` | This page does not exist | Cette page n’existe pas | high visibility |
| 28 | `shell.notFoundAction` | Go to My Day | Aller à Ma journée | high visibility |
| 29 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Entrée ajoute. Maj+Entrée crée une nouvelle ligne. Plusieurs lignes ajoutent plusieurs cartes. | high visibility |
| 30 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | Appuyez sur Espace pour saisir, sur les flèches pour déplacer, sur Espace pour déposer et sur Échap pour annuler. | high visibility |

### hi (30)

| # | key | EN | hi | why |
|---|---|---|---|---|
| 1 | `nav.myDay` | My Day | My Day | My Day left in English |
| 2 | `shell.notFoundAction` | Go to My Day | My Day पर जाएँ | My Day left in English |
| 3 | `dock.myDay` | My Day | My Day | My Day left in English |
| 4 | `myDay.title` | My Day | My Day | My Day left in English |
| 5 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | जो कार्ड आप My Day में जोड़ते हैं और जिनकी समय-सीमा आज है, वे यहाँ दिखेंगे। | My Day left in English |
| 6 | `shortcuts.goMyDay` | My Day | My Day | My Day left in English |
| 7 | `inbox.noLanes` | This board has no lanes yet. | इस बोर्ड में अभी कोई लेन नहीं है। | lane term differs from lane.add |
| 8 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | करने को, जारी और पूरा लेन के साथ शुरू करें | lane term vs lane.* labels |
| 9 | `appearance.transfer.export` | Export as JSON | JSON के रूप में एक्सपोर्ट करें | long x2.1 |
| 10 | `shell.signingIn` | Signing you in… | आपको साइन इन किया जा रहा है… | long x1.9 |
| 11 | `nav.workspace` | Workspace | वर्कस्पेस | high visibility |
| 12 | `nav.inbox` | Inbox | इनबॉक्स | high visibility |
| 13 | `nav.boards` | Boards | बोर्ड | high visibility |
| 14 | `nav.board` | Board | बोर्ड | high visibility |
| 15 | `nav.card` | Card | कार्ड | high visibility |
| 16 | `nav.billing` | Billing | बिलिंग | high visibility |
| 17 | `nav.onboarding` | Create your workspace | अपना वर्कस्पेस बनाएँ | high visibility |
| 18 | `boards.lane.todo` | To do | करने को | high visibility |
| 19 | `boards.lane.doing` | In progress | जारी | high visibility |
| 20 | `boards.lane.done` | Done | पूरा | high visibility |
| 21 | `lane.add` | Add a lane | लेन जोड़ें | high visibility |
| 22 | `lane.nameRequired` | Enter a name for the lane. | लेन के लिए एक नाम लिखें। | high visibility |
| 23 | `shell.notFoundTitle` | This page does not exist | यह पेज मौजूद नहीं है | high visibility |
| 24 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter दबाने पर जुड़ता है। Shift+Enter नई पंक्ति शुरू करता है। कई पंक्तियों से कई कार्ड जुड़ते हैं। | high visibility |
| 25 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | उठाने के लिए स्पेस, हिलाने के लिए तीर कुंजियाँ, रखने के लिए स्पेस और रद्द करने के लिए Escape दबाएँ। | high visibility |
| 26 | `card.overdue` | Overdue | समय-सीमा बीत चुकी | high visibility |
| 27 | `card.tooMany` | Add up to 20 cards at once. | एक बार में अधिकतम 20 कार्ड जोड़ें। | high visibility |
| 28 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | ज़्यादा सदस्य, बड़ी फ़ाइलें और ज़्यादा स्टोरेज। चेकआउट बिलिंग टूल के साथ आएगा। | high visibility |
| 29 | `billing.grace` | Over the plan limits. Everything keeps working until {date}. | प्लान की सीमा पार हो गई है। {date} तक सब कुछ चलता रहेगा। | high visibility |
| 30 | `billing.goToCheckout` | Go to checkout | चेकआउट पर जाएँ | high visibility |

### id (30)

| # | key | EN | id | why |
|---|---|---|---|---|
| 1 | `nav.myDay` | My Day | My Day | My Day left in English |
| 2 | `shell.notFoundAction` | Go to My Day | Buka My Day | My Day left in English |
| 3 | `dock.myDay` | My Day | My Day | My Day left in English |
| 4 | `myDay.title` | My Day | My Day | My Day left in English |
| 5 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | Kartu yang Anda tambahkan ke My Day dan kartu yang jatuh tempo hari ini muncul di sini. | My Day left in English |
| 6 | `shortcuts.goMyDay` | My Day | My Day | My Day left in English |
| 7 | `inbox.noLanes` | This board has no lanes yet. | Papan ini belum punya lajur. | lane term differs from lane.add |
| 8 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | Mulai dengan lane To do, In progress, dan Done | lane term vs lane.* labels |
| 9 | `tpl.personal.desc` | To do, Doing, Done. | Akan dikerjakan, Dikerjakan, Selesai. | long x1.9 |
| 10 | `cd.peopleEmpty` | No one found. | Tidak ada yang ditemukan. | long x1.9 |
| 11 | `card.moveUndone` | Move undone. | Pemindahan diurungkan. | long x1.8 |
| 12 | `nav.workspace` | Workspace | Workspace | high visibility |
| 13 | `nav.inbox` | Inbox | Kotak masuk | high visibility |
| 14 | `nav.boards` | Boards | Board | high visibility |
| 15 | `nav.board` | Board | Board | high visibility |
| 16 | `nav.card` | Card | Kartu | high visibility |
| 17 | `nav.billing` | Billing | Tagihan | high visibility |
| 18 | `nav.onboarding` | Create your workspace | Buat workspace Anda | high visibility |
| 19 | `boards.lane.todo` | To do | To do | high visibility |
| 20 | `boards.lane.doing` | In progress | In progress | high visibility |
| 21 | `boards.lane.done` | Done | Done | high visibility |
| 22 | `lane.add` | Add a lane | Tambah lane | high visibility |
| 23 | `lane.nameRequired` | Enter a name for the lane. | Masukkan nama untuk lane. | high visibility |
| 24 | `shell.notFoundTitle` | This page does not exist | Halaman ini tidak ada | high visibility |
| 25 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter menambahkan. Shift+Enter membuat baris baru. Beberapa baris menambahkan beberapa kartu. | high visibility |
| 26 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | Tekan spasi untuk mengangkat, tombol panah untuk memindahkan, spasi untuk melepas, Escape untuk membatalkan. | high visibility |
| 27 | `card.overdue` | Overdue | Terlambat | high visibility |
| 28 | `card.tooMany` | Add up to 20 cards at once. | Tambahkan hingga 20 kartu sekaligus. | high visibility |
| 29 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | Lebih banyak anggota, file lebih besar, dan penyimpanan lebih luas. Pembayaran hadir bersama alat tagihan. | high visibility |
| 30 | `billing.grace` | Over the plan limits. Everything keeps working until {date}. | Melebihi batas paket. Semua tetap berfungsi sampai {date}. | high visibility |

### it (30)

| # | key | EN | it | why |
|---|---|---|---|---|
| 1 | `shell.notFoundAction` | Go to My Day | Vai a My Day | My Day left in English |
| 2 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | Le card che aggiungi a My Day e quelle in scadenza oggi compaiono qui. | My Day left in English |
| 3 | `inbox.noLanes` | This board has no lanes yet. | Questa bacheca non ha ancora colonne. | lane term differs from lane.add |
| 4 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | Inizia con le lane Da fare, In corso e Fatto | lane term vs lane.* labels |
| 5 | `states.loadError` | We could not load this. | Non siamo riusciti a caricare questo contenuto. | long x2.0 |
| 6 | `card.moveUndone` | Move undone. | Spostamento annullato. | long x1.8 |
| 7 | `appearance.reset` | Reset to defaults | Ripristina i valori predefiniti | long x1.8 |
| 8 | `myDay.done` | Card marked done. | Scheda segnata come completata. | long x1.8 |
| 9 | `nav.workspace` | Workspace | Workspace | high visibility |
| 10 | `nav.myDay` | My Day | La mia giornata | high visibility |
| 11 | `nav.inbox` | Inbox | Posta in arrivo | high visibility |
| 12 | `nav.boards` | Boards | Board | high visibility |
| 13 | `nav.board` | Board | Board | high visibility |
| 14 | `nav.card` | Card | Card | high visibility |
| 15 | `nav.billing` | Billing | Fatturazione | high visibility |
| 16 | `nav.onboarding` | Create your workspace | Crea il tuo workspace | high visibility |
| 17 | `boards.lane.todo` | To do | Da fare | high visibility |
| 18 | `boards.lane.doing` | In progress | In corso | high visibility |
| 19 | `boards.lane.done` | Done | Fatto | high visibility |
| 20 | `lane.add` | Add a lane | Aggiungi una lane | high visibility |
| 21 | `lane.nameRequired` | Enter a name for the lane. | Inserisci un nome per la lane. | high visibility |
| 22 | `shell.notFoundTitle` | This page does not exist | Questa pagina non esiste | high visibility |
| 23 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Invio aggiunge. Maiusc+Invio va a capo. Più righe creano più card. | high visibility |
| 24 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | Premi Spazio per prendere, i tasti freccia per spostare, Spazio per rilasciare, Esc per annullare. | high visibility |
| 25 | `card.overdue` | Overdue | In ritardo | high visibility |
| 26 | `card.tooMany` | Add up to 20 cards at once. | Aggiungi fino a 20 card alla volta. | high visibility |
| 27 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | Più membri, file più grandi e più spazio. Il pagamento arriverà con gli strumenti di fatturazione. | high visibility |
| 28 | `billing.grace` | Over the plan limits. Everything keeps working until {date}. | Oltre i limiti del piano. Tutto continua a funzionare fino al {date}. | high visibility |
| 29 | `billing.goToCheckout` | Go to checkout | Vai al pagamento | high visibility |
| 30 | `billing.changePlan` | Change plan | Cambia piano | high visibility |

### ja (30)

| # | key | EN | ja | why |
|---|---|---|---|---|
| 1 | `shell.notFoundAction` | Go to My Day | My Day へ移動 | My Day left in English |
| 2 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | My Day に追加したカードと、今日が期限のカードがここに表示されます。 | My Day left in English |
| 3 | `inbox.noLanes` | This board has no lanes yet. | このボードにはまだリストがありません。 | lane term differs from lane.add |
| 4 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | 「To do」「In progress」「Done」のレーンで始める | lane term vs lane.* labels |
| 5 | `onboarding.tipPrefix` | Tip: press | ヒント: | ending punctuation differs |
| 6 | `onboarding.tipSearch` | to search and | で検索、 | ending punctuation differs |
| 7 | `nav.workspace` | Workspace | ワークスペース | high visibility |
| 8 | `nav.myDay` | My Day | 今日の予定 | high visibility |
| 9 | `nav.inbox` | Inbox | 受信箱 | high visibility |
| 10 | `nav.boards` | Boards | ボード | high visibility |
| 11 | `nav.board` | Board | ボード | high visibility |
| 12 | `nav.card` | Card | カード | high visibility |
| 13 | `nav.billing` | Billing | 支払い | high visibility |
| 14 | `nav.onboarding` | Create your workspace | ワークスペースを作成 | high visibility |
| 15 | `boards.lane.todo` | To do | 未着手 | high visibility |
| 16 | `boards.lane.doing` | In progress | 進行中 | high visibility |
| 17 | `boards.lane.done` | Done | Done | high visibility |
| 18 | `lane.add` | Add a lane | レーンを追加 | high visibility |
| 19 | `lane.nameRequired` | Enter a name for the lane. | レーン名を入力してください。 | high visibility |
| 20 | `shell.notFoundTitle` | This page does not exist | このページは存在しません | high visibility |
| 21 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter で追加、Shift+Enter で改行します。複数行を入力すると複数のカードを追加できます。 | high visibility |
| 22 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | スペースキーで持ち上げ、矢印キーで移動、スペースキーで置き、Escape でキャンセルします。 | high visibility |
| 23 | `card.overdue` | Overdue | 期限切れ | high visibility |
| 24 | `card.tooMany` | Add up to 20 cards at once. | 一度に追加できるカードは 20 枚までです。 | high visibility |
| 25 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | より多くのメンバー、大きなファイル、広いストレージ。購入手続きは支払いツールと一緒に追加されます。 | high visibility |
| 26 | `billing.grace` | Over the plan limits. Everything keeps working until {date}. | プランの上限を超えています。{date}までは通常どおり使えます。 | high visibility |
| 27 | `billing.goToCheckout` | Go to checkout | チェックアウトへ | high visibility |
| 28 | `billing.changePlan` | Change plan | プランを変更 | high visibility |
| 29 | `errors.unknown` | Something went wrong. Please try again. | 問題が発生しました。もう一度お試しください。 | high visibility |
| 30 | `errors.validation` | Some fields need fixing. | 修正が必要な項目があります。 | high visibility |

### ko (30)

| # | key | EN | ko | why |
|---|---|---|---|---|
| 1 | `shell.notFoundAction` | Go to My Day | My Day로 이동 | My Day left in English |
| 2 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | My Day에 추가한 카드와 오늘 마감인 카드가 여기에 표시됩니다. | My Day left in English |
| 3 | `inbox.noLanes` | This board has no lanes yet. | 이 보드에는 아직 목록이 없습니다. | lane term differs from lane.add |
| 4 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | To do, In progress, Done 레인으로 시작 | lane term vs lane.* labels |
| 5 | `onboarding.tipPrefix` | Tip: press | 팁: | ending punctuation differs |
| 6 | `onboarding.tipSearch` | to search and | 검색, | ending punctuation differs |
| 7 | `nav.inbox` | Inbox | 받은 알림 | wrong term (알림) |
| 8 | `nav.workspace` | Workspace | 워크스페이스 | high visibility |
| 9 | `nav.myDay` | My Day | 나의 하루 | high visibility |
| 10 | `nav.boards` | Boards | 보드 | high visibility |
| 11 | `nav.board` | Board | 보드 | high visibility |
| 12 | `nav.card` | Card | 카드 | high visibility |
| 13 | `nav.billing` | Billing | 결제 | high visibility |
| 14 | `nav.onboarding` | Create your workspace | 워크스페이스 만들기 | high visibility |
| 15 | `boards.lane.todo` | To do | 할 일 | high visibility |
| 16 | `boards.lane.doing` | In progress | 진행 중 | high visibility |
| 17 | `boards.lane.done` | Done | Done | high visibility |
| 18 | `lane.add` | Add a lane | 레인 추가 | high visibility |
| 19 | `lane.nameRequired` | Enter a name for the lane. | 레인 이름을 입력하세요. | high visibility |
| 20 | `shell.notFoundTitle` | This page does not exist | 이 페이지는 존재하지 않습니다 | high visibility |
| 21 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter로 추가하고, Shift+Enter로 줄을 바꿉니다. 여러 줄을 입력하면 카드가 여러 장 추가됩니다. | high visibility |
| 22 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | 스페이스 키로 집고, 방향키로 이동하고, 스페이스 키로 놓고, Escape로 취소합니다. | high visibility |
| 23 | `card.overdue` | Overdue | 기한 초과 | high visibility |
| 24 | `card.tooMany` | Add up to 20 cards at once. | 한 번에 카드를 최대 20장까지 추가할 수 있습니다. | high visibility |
| 25 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | 더 많은 멤버, 더 큰 파일, 더 많은 저장 공간. 결제는 결제 도구와 함께 제공됩니다. | high visibility |
| 26 | `billing.grace` | Over the plan limits. Everything keeps working until {date}. | 요금제 한도를 넘었습니다. {date}까지는 모두 정상 작동합니다. | high visibility |
| 27 | `billing.goToCheckout` | Go to checkout | 결제로 이동 | high visibility |
| 28 | `billing.changePlan` | Change plan | 요금제 변경 | high visibility |
| 29 | `errors.unknown` | Something went wrong. Please try again. | 문제가 발생했습니다. 다시 시도해 주세요. | high visibility |
| 30 | `errors.validation` | Some fields need fixing. | 수정이 필요한 항목이 있습니다. | high visibility |

### pt (30)

| # | key | EN | pt | why |
|---|---|---|---|---|
| 1 | `inbox.noLanes` | This board has no lanes yet. | Este quadro ainda não tem listas. | lane term differs from lane.add |
| 2 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | Começar com as raias A fazer, Em andamento e Concluído | lane term vs lane.* labels |
| 3 | `cd.checklistAdd` | Add a checklist | Adicionar uma lista de verificação | long x2.3 |
| 4 | `cd.checklistTitle` | Checklist title | Título da lista de verificação | long x2.0 |
| 5 | `cd.checklistRename` | Rename checklist | Renomear lista de verificação | long x1.8 |
| 6 | `nav.billing` | Billing | Cobrança | Cobrança vs Faturamento |
| 7 | `nav.workspace` | Workspace | Workspace | high visibility |
| 8 | `nav.myDay` | My Day | Meu Dia | high visibility |
| 9 | `nav.inbox` | Inbox | Caixa de entrada | high visibility |
| 10 | `nav.boards` | Boards | Quadros | high visibility |
| 11 | `nav.board` | Board | Quadro | high visibility |
| 12 | `nav.card` | Card | Cartão | high visibility |
| 13 | `nav.onboarding` | Create your workspace | Crie seu workspace | high visibility |
| 14 | `boards.lane.todo` | To do | A fazer | high visibility |
| 15 | `boards.lane.doing` | In progress | Em andamento | high visibility |
| 16 | `boards.lane.done` | Done | Concluído | high visibility |
| 17 | `lane.add` | Add a lane | Adicionar uma raia | high visibility |
| 18 | `lane.nameRequired` | Enter a name for the lane. | Digite um nome para a raia. | high visibility |
| 19 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | Os cartões que você adicionar ao Meu Dia e os que vencem hoje aparecem aqui. | high visibility |
| 20 | `shell.notFoundTitle` | This page does not exist | Esta página não existe | high visibility |
| 21 | `shell.notFoundAction` | Go to My Day | Ir para Meu Dia | high visibility |
| 22 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter adiciona. Shift+Enter inicia uma nova linha. Várias linhas adicionam vários cartões. | high visibility |
| 23 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | Pressione espaço para pegar, as setas para mover, espaço para soltar e Escape para cancelar. | high visibility |
| 24 | `card.overdue` | Overdue | Atrasado | high visibility |
| 25 | `card.tooMany` | Add up to 20 cards at once. | Adicione até 20 cartões de uma vez. | high visibility |
| 26 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | Mais membros, arquivos maiores e mais armazenamento. O pagamento chega com as ferramentas de cobrança. | high visibility |
| 27 | `billing.grace` | Over the plan limits. Everything keeps working until {date}. | Acima dos limites do plano. Tudo continua funcionando até {date}. | high visibility |
| 28 | `billing.goToCheckout` | Go to checkout | Ir para o pagamento | high visibility |
| 29 | `billing.changePlan` | Change plan | Mudar de plano | high visibility |
| 30 | `errors.unknown` | Something went wrong. Please try again. | Algo deu errado. Tente de novo. | high visibility |

### ru (30)

| # | key | EN | ru | why |
|---|---|---|---|---|
| 1 | `nav.myDay` | My Day | My Day | My Day left in English |
| 2 | `shell.notFoundAction` | Go to My Day | Перейти в My Day | My Day left in English |
| 3 | `dock.myDay` | My Day | My Day | My Day left in English |
| 4 | `myDay.title` | My Day | My Day | My Day left in English |
| 5 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | Здесь появятся карточки, которые вы добавите в My Day, и карточки со сроком на сегодня. | My Day left in English |
| 6 | `shortcuts.goMyDay` | My Day | My Day | My Day left in English |
| 7 | `inbox.noLanes` | This board has no lanes yet. | На этой доске пока нет колонок. | lane term differs from lane.add |
| 8 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | Начать с колонок «К выполнению», «В работе» и «Готово» | lane term vs lane.* labels |
| 9 | `workspace.none` | No workspace | Нет рабочего пространства | long x2.1 |
| 10 | `onboarding.nameLabel` | Workspace name | Название рабочего пространства | long x2.1 |
| 11 | `nav.join` | Join workspace | Присоединиться к пространству | long x2.1 |
| 12 | `join.accept` | Join workspace | Присоединиться к пространству | long x2.1 |
| 13 | `common.on` | On | Вкл. | ending punctuation differs |
| 14 | `common.off` | Off | Выкл. | ending punctuation differs |
| 15 | `members.days` | {n} days | {n} дн. | ending punctuation differs |
| 16 | `nav.workspace` | Workspace | Рабочее пространство | high visibility |
| 17 | `nav.inbox` | Inbox | Входящие | high visibility |
| 18 | `nav.boards` | Boards | Доски | high visibility |
| 19 | `nav.board` | Board | Доска | high visibility |
| 20 | `nav.card` | Card | Карточка | high visibility |
| 21 | `nav.billing` | Billing | Оплата | high visibility |
| 22 | `nav.onboarding` | Create your workspace | Создайте рабочее пространство | high visibility |
| 23 | `boards.lane.todo` | To do | К выполнению | high visibility |
| 24 | `boards.lane.doing` | In progress | В работе | high visibility |
| 25 | `boards.lane.done` | Done | Готово | high visibility |
| 26 | `lane.add` | Add a lane | Добавить колонку | high visibility |
| 27 | `lane.nameRequired` | Enter a name for the lane. | Введите название колонки. | high visibility |
| 28 | `shell.notFoundTitle` | This page does not exist | Такой страницы нет | high visibility |
| 29 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter добавляет. Shift+Enter начинает новую строку. Несколько строк создадут несколько карточек. | high visibility |
| 30 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | Нажмите пробел, чтобы взять, стрелки, чтобы переместить, пробел, чтобы отпустить, Escape, чтобы отменить. | high visibility |

### sw (30)

| # | key | EN | sw | why |
|---|---|---|---|---|
| 1 | `nav.myDay` | My Day | My Day | My Day left in English |
| 2 | `shell.notFoundAction` | Go to My Day | Nenda kwa My Day | My Day left in English |
| 3 | `dock.myDay` | My Day | My Day | My Day left in English |
| 4 | `myDay.title` | My Day | My Day | My Day left in English |
| 5 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | Kadi unazoongeza kwenye My Day, na kadi zinazostahili leo, huonekana hapa. | My Day left in English |
| 6 | `shortcuts.goMyDay` | My Day | My Day | My Day left in English |
| 7 | `inbox.noLanes` | This board has no lanes yet. | Ubao huu hauna safu bado. | lane term differs from lane.add |
| 8 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | Anza na njia za Cha kufanya, Inaendelea na Imekamilika | lane term vs lane.* labels |
| 9 | `appearance.accent.presets` | Accent presets | Rangi za msisitizo zilizowekwa tayari | long x2.6 |
| 10 | `inbox.archived` | Card archived. | Kadi imehifadhiwa kwenye kumbukumbu. | long x2.6 |
| 11 | `lane.archived` | Lane archived. | Njia imewekwa kwenye kumbukumbu. | long x2.3 |
| 12 | `card.archivedToast` | Card archived. | Kadi imewekwa kwenye kumbukumbu. | long x2.3 |
| 13 | `nav.workspace` | Workspace | Nafasi ya kazi | high visibility |
| 14 | `nav.inbox` | Inbox | Kikasha | high visibility |
| 15 | `nav.boards` | Boards | Bodi | high visibility |
| 16 | `nav.board` | Board | Bodi | high visibility |
| 17 | `nav.card` | Card | Kadi | high visibility |
| 18 | `nav.billing` | Billing | Malipo | high visibility |
| 19 | `nav.onboarding` | Create your workspace | Unda nafasi yako ya kazi | high visibility |
| 20 | `boards.lane.todo` | To do | Cha kufanya | high visibility |
| 21 | `boards.lane.doing` | In progress | Inaendelea | high visibility |
| 22 | `boards.lane.done` | Done | Imekamilika | high visibility |
| 23 | `lane.add` | Add a lane | Ongeza njia | high visibility |
| 24 | `lane.nameRequired` | Enter a name for the lane. | Weka jina la njia. | high visibility |
| 25 | `shell.notFoundTitle` | This page does not exist | Ukurasa huu haupo | high visibility |
| 26 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter huongeza. Shift+Enter huanzisha mstari mpya. Mistari kadhaa huongeza kadi kadhaa. | high visibility |
| 27 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | Bonyeza nafasi kuinua, vishale kuhamisha, nafasi kuacha, Escape kughairi. | high visibility |
| 28 | `card.overdue` | Overdue | Imechelewa | high visibility |
| 29 | `card.tooMany` | Add up to 20 cards at once. | Ongeza hadi kadi 20 kwa wakati mmoja. | high visibility |
| 30 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | Wanachama zaidi, faili kubwa zaidi na hifadhi zaidi. Malipo yanakuja na zana za malipo. | high visibility |

### th (30)

| # | key | EN | th | why |
|---|---|---|---|---|
| 1 | `nav.myDay` | My Day | My Day | My Day left in English |
| 2 | `shell.notFoundAction` | Go to My Day | ไปที่ My Day | My Day left in English |
| 3 | `dock.myDay` | My Day | My Day | My Day left in English |
| 4 | `myDay.title` | My Day | My Day | My Day left in English |
| 5 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | การ์ดที่คุณเพิ่มใน My Day และการ์ดที่ครบกำหนดวันนี้จะแสดงที่นี่ | My Day left in English |
| 6 | `shortcuts.goMyDay` | My Day | My Day | My Day left in English |
| 7 | `inbox.noLanes` | This board has no lanes yet. | บอร์ดนี้ยังไม่มีเลน | lane term differs from lane.add |
| 8 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | เริ่มด้วยเลน To do, In progress และ Done | lane term vs lane.* labels |
| 9 | `members.maxUses` | Maximum uses | จำนวนครั้งที่ใช้ได้สูงสุด | long x2.1 |
| 10 | `notif.markAll` | Mark all read | ทำเครื่องหมายว่าอ่านทั้งหมด | long x2.1 |
| 11 | `myDay.markDone` | Mark “{title}” done | ทำเครื่องหมาย “{title}” ว่าเสร็จแล้ว | long x1.9 |
| 12 | `inbox.markDone` | Mark “{title}” done | ทำเครื่องหมาย “{title}” ว่าเสร็จแล้ว | long x1.9 |
| 13 | `nav.workspace` | Workspace | เวิร์กสเปซ | high visibility |
| 14 | `nav.inbox` | Inbox | กล่องข้อความ | high visibility |
| 15 | `nav.boards` | Boards | บอร์ด | high visibility |
| 16 | `nav.board` | Board | บอร์ด | high visibility |
| 17 | `nav.card` | Card | การ์ด | high visibility |
| 18 | `nav.billing` | Billing | การเรียกเก็บเงิน | high visibility |
| 19 | `nav.onboarding` | Create your workspace | สร้างเวิร์กสเปซของคุณ | high visibility |
| 20 | `boards.lane.todo` | To do | ต้องทำ | high visibility |
| 21 | `boards.lane.doing` | In progress | กำลังทำ | high visibility |
| 22 | `boards.lane.done` | Done | Done | high visibility |
| 23 | `lane.add` | Add a lane | เพิ่มเลน | high visibility |
| 24 | `lane.nameRequired` | Enter a name for the lane. | กรุณาใส่ชื่อเลน | high visibility |
| 25 | `shell.notFoundTitle` | This page does not exist | ไม่พบหน้านี้ | high visibility |
| 26 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | กด Enter เพื่อเพิ่ม กด Shift+Enter เพื่อขึ้นบรรทัดใหม่ หลายบรรทัดจะเพิ่มหลายการ์ด | high visibility |
| 27 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | กดสเปซบาร์เพื่อหยิบ ใช้ปุ่มลูกศรเพื่อย้าย กดสเปซบาร์เพื่อวาง กด Escape เพื่อยกเลิก | high visibility |
| 28 | `card.overdue` | Overdue | เกินกำหนด | high visibility |
| 29 | `card.tooMany` | Add up to 20 cards at once. | เพิ่มได้สูงสุด 20 การ์ดต่อครั้ง | high visibility |
| 30 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | สมาชิกมากขึ้น ไฟล์ใหญ่ขึ้น และพื้นที่เก็บข้อมูลมากขึ้น การชำระเงินจะมาพร้อมเครื่องมือเรียกเก็บเงิน | high visibility |

### tr (30)

| # | key | EN | tr | why |
|---|---|---|---|---|
| 1 | `nav.myDay` | My Day | My Day | My Day left in English |
| 2 | `shell.notFoundAction` | Go to My Day | My Day'e git | My Day left in English |
| 3 | `dock.myDay` | My Day | My Day | My Day left in English |
| 4 | `myDay.title` | My Day | My Day | My Day left in English |
| 5 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | My Day'e eklediğin kartlar ve bugün son günü olan kartlar burada görünür. | My Day left in English |
| 6 | `shortcuts.goMyDay` | My Day | My Day | My Day left in English |
| 7 | `inbox.noLanes` | This board has no lanes yet. | Bu panoda henüz liste yok. | lane term differs from lane.add |
| 8 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | Yapılacak, Devam ediyor ve Bitti şeritleriyle başla | lane term vs lane.* labels |
| 9 | `members.leaveTitle` | Leave {name}? | {name} alanından ayrılınsın mı? | long x2.4 |
| 10 | `myDay.markDone` | Mark “{title}” done | “{title}” kartını tamamlandı olarak işaretle | long x2.3 |
| 11 | `inbox.markDone` | Mark “{title}” done | “{title}” kartını tamamlandı olarak işaretle | long x2.3 |
| 12 | `myDay.done` | Card marked done. | Kart tamamlandı olarak işaretlendi. | long x2.1 |
| 13 | `nav.workspace` | Workspace | Çalışma alanı | high visibility |
| 14 | `nav.inbox` | Inbox | Gelen kutusu | high visibility |
| 15 | `nav.boards` | Boards | Panolar | high visibility |
| 16 | `nav.board` | Board | Pano | high visibility |
| 17 | `nav.card` | Card | Kart | high visibility |
| 18 | `nav.billing` | Billing | Faturalandırma | high visibility |
| 19 | `nav.onboarding` | Create your workspace | Çalışma alanını oluştur | high visibility |
| 20 | `boards.lane.todo` | To do | Yapılacak | high visibility |
| 21 | `boards.lane.doing` | In progress | Devam ediyor | high visibility |
| 22 | `boards.lane.done` | Done | Bitti | high visibility |
| 23 | `lane.add` | Add a lane | Şerit ekle | high visibility |
| 24 | `lane.nameRequired` | Enter a name for the lane. | Şerit için bir ad gir. | high visibility |
| 25 | `shell.notFoundTitle` | This page does not exist | Bu sayfa yok | high visibility |
| 26 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter ekler. Shift+Enter yeni satır açar. Birden fazla satır birden fazla kart ekler. | high visibility |
| 27 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | Almak için boşluk tuşuna, taşımak için ok tuşlarına, bırakmak için boşluk tuşuna, iptal için Escape'e bas. | high visibility |
| 28 | `card.overdue` | Overdue | Gecikmiş | high visibility |
| 29 | `card.tooMany` | Add up to 20 cards at once. | Tek seferde en fazla 20 kart ekle. | high visibility |
| 30 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | Daha fazla üye, daha büyük dosyalar ve daha fazla depolama. Ödeme, faturalandırma araçlarıyla birlikte gelecek. | high visibility |

### ur (30)

| # | key | EN | ur | why |
|---|---|---|---|---|
| 1 | `shell.notFoundAction` | Go to My Day | My Day پر جائیں | My Day left in English |
| 2 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | جو کارڈز آپ My Day میں شامل کرتے ہیں اور جن کی آخری تاریخ آج ہے، وہ یہاں نظر آئیں گے۔ | My Day left in English |
| 3 | `inbox.noLanes` | This board has no lanes yet. | اس بورڈ میں ابھی کوئی لین نہیں۔ | lane term differs from lane.add |
| 4 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | کرنے کے کام، جاری اور مکمل لینز کے ساتھ شروع کریں | lane term vs lane.* labels |
| 5 | `notif.markAll` | Mark all read | سب کو پڑھا ہوا نشان زد کریں | long x2.1 |
| 6 | `appearance.transfer.export` | Export as JSON | JSON کے طور پر ایکسپورٹ کریں | long x2.0 |
| 7 | `shell.signingIn` | Signing you in… | آپ کو سائن اِن کیا جا رہا ہے… | long x1.9 |
| 8 | `card.moveUndone` | Move undone. | منتقلی واپس کر دی گئی۔ | long x1.8 |
| 9 | `members.maxUses` | Maximum uses | زیادہ سے زیادہ استعمال | long x1.8 |
| 10 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter دبانے سے شامل ہوتا ہے۔ Shift+Enter نئی سطر شروع کرتا ہے۔ کئی سطروں سے کئی کارڈز شامل ہوتے ہیں۔ | Latin words inside RTL: Enter,Shift,Enter |
| 11 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | اٹھانے کے لیے اسپیس، حرکت دینے کے لیے تیر والی کیز، رکھنے کے لیے اسپیس اور منسوخ کرنے کے لیے Escape دبائیں۔ | Latin words inside RTL: Escape |
| 12 | `appearance.transfer.import` | Import from JSON | JSON سے امپورٹ کریں | Latin words inside RTL: JSON |
| 13 | `chat.creatingGeneral` | Creating #general… | #general بنایا جا رہا ہے… | Latin words inside RTL: general |
| 14 | `join.description` | You were invited to a Lanefold workspace. Joining adds it to your account. | آپ کو Lanefold ورک اسپیس میں مدعو کیا گیا ہے۔ شامل ہونے پر یہ آپ کے اکاؤنٹ میں شامل ہو جائے گا۔ | Latin words inside RTL: Lanefold |
| 15 | `members.copyFailed` | Copying was blocked. The link is selected: press Ctrl+C. | کاپی کرنا روک دیا گیا۔ لنک منتخب ہے: Ctrl+C دبائیں۔ | Latin words inside RTL: Ctrl |
| 16 | `members.emailInvalid` | Enter a valid email address, like name@example.com, or leave it empty. | درست ای میل پتا درج کریں، جیسے name@example.com، یا خالی چھوڑ دیں۔ | Latin words inside RTL: name,example,com |
| 17 | `setup.chat` | Say hi in General | General میں سلام کریں | Latin words inside RTL: General |
| 18 | `onboarding.intentLegend` | What will you use Lanefold for? | آپ Lanefold کس لیے استعمال کریں گے؟ | Latin words inside RTL: Lanefold |
| 19 | `cd.linkInvalid` | Enter a web address starting with https://. | https:// سے شروع ہونے والا ویب ایڈریس درج کریں۔ | Latin words inside RTL: https |
| 20 | `cd.commentPlaceholder` | Write a comment. Ctrl+Enter posts it. | تبصرہ لکھیں۔ Ctrl+Enter اسے پوسٹ کرتا ہے۔ | Latin words inside RTL: Ctrl,Enter |
| 21 | `errors.E_STORAGE_NEEDS_PACK` | File uploads are not switched on yet. Ask the site owner to add a storage pack in the Storage tab of the app dashboard. | فائل اپ لوڈ ابھی آن نہیں ہے۔ سائٹ کے مالک سے کہیں کہ ایپ ڈیش بورڈ کے Storage ٹیب میں اسٹوریج پیک شامل کرے۔ | Latin words inside RTL: Storage |
| 22 | `errors.E_STORAGE_OFF` | File storage is turned off for this site. Ask the site owner to turn it on in the Storage tab. | اس سائٹ کے لیے فائل اسٹوریج بند ہے۔ سائٹ کے مالک سے کہیں کہ اسے Storage ٹیب میں آن کرے۔ | Latin words inside RTL: Storage |
| 23 | `errors.E_FILE_TYPE` | That kind of file cannot be attached. Pick an image, PDF or document. | اس قسم کی فائل منسلک نہیں کی جا سکتی۔ تصویر، PDF یا دستاویز منتخب کریں۔ | Latin words inside RTL: PDF |
| 24 | `chat.suggestionsHint` | Suggestions available: {n}. Use the up and down arrows, then Enter to choose. | تجاویز دستیاب ہیں: {n}۔ اوپر اور نیچے تیر استعمال کریں، پھر منتخب کرنے کے لیے Enter دبائیں۔ | Latin words inside RTL: Enter |
| 25 | `onboarding.tipAdd` | to add a card, | کارڈ شامل کرنے کے لیے، | ending punctuation differs |
| 26 | `nav.workspace` | Workspace | ورک اسپیس | high visibility |
| 27 | `nav.myDay` | My Day | میرا دن | high visibility |
| 28 | `nav.inbox` | Inbox | ان باکس | high visibility |
| 29 | `nav.boards` | Boards | بورڈز | high visibility |
| 30 | `nav.board` | Board | بورڈ | high visibility |

### vi (30)

| # | key | EN | vi | why |
|---|---|---|---|---|
| 1 | `shell.notFoundAction` | Go to My Day | Đi tới My Day | My Day left in English |
| 2 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | Các thẻ bạn thêm vào My Day và các thẻ đến hạn hôm nay sẽ hiện ở đây. | My Day left in English |
| 3 | `inbox.noLanes` | This board has no lanes yet. | Bảng này chưa có cột nào. | lane term differs from lane.add |
| 4 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | Bắt đầu với các cột Cần làm, Đang làm và Xong | lane term vs lane.* labels |
| 5 | `workspace.none` | No workspace | Không có không gian làm việc | long x2.3 |
| 6 | `nav.join` | Join workspace | Tham gia không gian làm việc | long x2.0 |
| 7 | `join.accept` | Join workspace | Tham gia không gian làm việc | long x2.0 |
| 8 | `members.noLinksTitle` | No join links | Chưa có liên kết tham gia | long x1.9 |
| 9 | `card.moveUndone` | Move undone. | Đã hoàn tác di chuyển. | long x1.8 |
| 10 | `nav.workspace` | Workspace | Không gian làm việc | high visibility |
| 11 | `nav.myDay` | My Day | Ngày của tôi | high visibility |
| 12 | `nav.inbox` | Inbox | Hộp thư | high visibility |
| 13 | `nav.boards` | Boards | Bảng | high visibility |
| 14 | `nav.board` | Board | Bảng | high visibility |
| 15 | `nav.card` | Card | Thẻ | high visibility |
| 16 | `nav.billing` | Billing | Thanh toán | high visibility |
| 17 | `nav.onboarding` | Create your workspace | Tạo không gian làm việc của bạn | high visibility |
| 18 | `boards.lane.todo` | To do | Cần làm | high visibility |
| 19 | `boards.lane.doing` | In progress | Đang làm | high visibility |
| 20 | `boards.lane.done` | Done | Xong | high visibility |
| 21 | `lane.add` | Add a lane | Thêm cột | high visibility |
| 22 | `lane.nameRequired` | Enter a name for the lane. | Hãy nhập tên cho cột. | high visibility |
| 23 | `shell.notFoundTitle` | This page does not exist | Trang này không tồn tại | high visibility |
| 24 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | Enter để thêm. Shift+Enter để xuống dòng. Nhiều dòng sẽ thêm nhiều thẻ. | high visibility |
| 25 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | Nhấn phím cách để nhấc, phím mũi tên để di chuyển, phím cách để thả, Escape để hủy. | high visibility |
| 26 | `card.overdue` | Overdue | Quá hạn | high visibility |
| 27 | `card.tooMany` | Add up to 20 cards at once. | Thêm tối đa 20 thẻ cùng lúc. | high visibility |
| 28 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | Nhiều thành viên hơn, tệp lớn hơn và nhiều dung lượng hơn. Thanh toán sẽ có cùng các công cụ thanh toán. | high visibility |
| 29 | `billing.grace` | Over the plan limits. Everything keeps working until {date}. | Vượt giới hạn gói. Mọi thứ vẫn hoạt động đến {date}. | high visibility |
| 30 | `billing.goToCheckout` | Go to checkout | Đến thanh toán | high visibility |

### zh (30)

| # | key | EN | zh | why |
|---|---|---|---|---|
| 1 | `shell.notFoundAction` | Go to My Day | 前往 My Day | My Day left in English |
| 2 | `myDay.emptyBody` | Cards you add to My Day, and cards due today, show up here. | 你添加到 My Day 的卡片和今日到期的卡片会显示在这里。 | My Day left in English |
| 3 | `inbox.noLanes` | This board has no lanes yet. | 此看板还没有列表。 | lane term differs from lane.add |
| 4 | `boards.defaultLanes` | Start with To do, In progress and Done lanes | 以“待办”“进行中”“已完成”泳道开始 | lane term vs lane.* labels |
| 5 | `onboarding.tipAdd` | to add a card, | 添加卡片， | ending punctuation differs |
| 6 | `nav.workspace` | Workspace | 工作区 | high visibility |
| 7 | `nav.myDay` | My Day | 我的一天 | high visibility |
| 8 | `nav.inbox` | Inbox | 收件箱 | high visibility |
| 9 | `nav.boards` | Boards | 看板 | high visibility |
| 10 | `nav.board` | Board | 看板 | high visibility |
| 11 | `nav.card` | Card | 卡片 | high visibility |
| 12 | `nav.billing` | Billing | 账单 | high visibility |
| 13 | `nav.onboarding` | Create your workspace | 创建你的工作区 | high visibility |
| 14 | `boards.lane.todo` | To do | 待办 | high visibility |
| 15 | `boards.lane.doing` | In progress | 进行中 | high visibility |
| 16 | `boards.lane.done` | Done | 已完成 | high visibility |
| 17 | `lane.add` | Add a lane | 添加泳道 | high visibility |
| 18 | `lane.nameRequired` | Enter a name for the lane. | 请输入泳道名称。 | high visibility |
| 19 | `shell.notFoundTitle` | This page does not exist | 此页面不存在 | high visibility |
| 20 | `card.addHint` | Enter adds. Shift+Enter starts a new line. Several lines add several cards. | 按 Enter 添加。按 Shift+Enter 换行。多行会添加多张卡片。 | high visibility |
| 21 | `dnd.instructions` | Press space to pick up, arrow keys to move, space to drop, Escape to cancel. | 按空格键拿起，按方向键移动，按空格键放下，按 Esc 取消。 | high visibility |
| 22 | `card.overdue` | Overdue | 已逾期 | high visibility |
| 23 | `card.tooMany` | Add up to 20 cards at once. | 一次最多添加 20 张卡片。 | high visibility |
| 24 | `billing.upgradeBody` | More members, bigger files and more storage. Checkout arrives with the billing tools. | 更多成员、更大文件和更多存储空间。结账功能将随账单工具一起推出。 | high visibility |
| 25 | `billing.grace` | Over the plan limits. Everything keeps working until {date}. | 已超出套餐限额。{date} 前一切照常使用。 | high visibility |
| 26 | `billing.goToCheckout` | Go to checkout | 前往结账 | high visibility |
| 27 | `billing.changePlan` | Change plan | 更换套餐 | high visibility |
| 28 | `errors.unknown` | Something went wrong. Please try again. | 出了点问题，请重试。 | high visibility |
| 29 | `errors.validation` | Some fields need fixing. | 部分字段需要修改。 | high visibility |
| 30 | `errors.workspace_read_only` | This workspace is read-only until its plan limits are fixed. | 在套餐限制得到解决之前，此工作区为只读。 | high visibility |

## 2026-11-03 re-check: import/export merge and mechanical scan

- Import/export keys (68) were identical in `en.json` and the pending file and present in all 19 catalogs; `src/i18n/pending/import-export.json` and `useIT` (`src/app/import-export/use-ie-t.ts`) were removed, callers use `useT`.
- Script over all 19 catalogs vs `en.json`: placeholder parity 0 problems, plural categories complete per `Intl.PluralRules` for every plural base (4), no missing or extra bases, no leading/trailing/double whitespace. Nothing needed fixing.
- Untranslated = value identical to English, with a 3+ letter word (cognates/brand terms such as Chat, Plan, Lanefold are included, review by hand). 183 keys are English in all 19 catalogs; the rest are per language below.

### English in all 19 catalogs (183)

`filters.clear`, `filters.due`, `filters.due.none`, `filters.due.overdue`, `filters.due.today`, `filters.due.week`, `filters.dueAny`, `filters.label`, `filters.labels`, `filters.members`, `filters.noOptions`, `filters.priority`, `filters.priority.high`, `filters.priority.low`, `filters.priority.medium`, `filters.priority.none`, `filters.priority.urgent`, `filters.priorityAny`, `filters.result`, `filters.searchLabel`, `filters.searchPlaceholder`, `filters.toggle`, `importExport.button.choose`, `importExport.button.import`, `importExport.button.importing`, `importExport.button.retry`, `importExport.card.description`, `importExport.card.title`, `importExport.comments.note`, `importExport.description`, `importExport.done.body`, `importExport.done.open`, `importExport.done.title`, `importExport.done.toast`, `importExport.export.csv`, `importExport.export.done`, `importExport.export.failed`, `importExport.export.json`, `importExport.export.label`, `importExport.export.menu`, `importExport.export.working`, `importExport.failed`, `importExport.file.checking`, `importExport.file.empty`, `importExport.file.hint`, `importExport.file.label`, `importExport.file.notJson`, `importExport.file.notTrello`, `importExport.file.tooBig`, `importExport.file.unreadable`, `importExport.noWorkspace`, `importExport.preview.board`, `importExport.preview.caption`, `importExport.preview.cards`, `importExport.preview.checklistItems`, `importExport.preview.checklists`, `importExport.preview.comments`, `importExport.preview.count`, `importExport.preview.item`, `importExport.preview.labels`, `importExport.preview.lanes`, `importExport.preview.links`, `importExport.preview.title`, `importExport.problem.board_rate_limited`, `importExport.problem.empty`, `importExport.problem.lane_full`, `importExport.problem.read_only`, `importExport.problem.too_many_cards`, `importExport.problem.too_many_labels`, `importExport.problem.too_many_lanes`, `importExport.progress.label`, `importExport.progress.starting`, `importExport.progress.text`, `importExport.title`, `importExport.viewerOnly`, `importExport.warn.archived_cards`, `importExport.warn.archived_lists`, `importExport.warn.cards_over_limit`, `importExport.warn.checklists_dropped`, `importExport.warn.comments_dropped`, `importExport.warn.items_dropped`, `importExport.warn.labels_over_limit`, `importExport.warn.lanes_over_limit`, `importExport.warn.links_dropped`, `importExport.warn.members_not_imported`, `importExport.warn.orphan_cards`, `importExport.warn.text_shortened`, `importExport.warn.uploads_not_copied`, `importExport.warnings.title`, `invite.emailAlso`, `invite.emailAlsoHint`, `invite.emailFailed`, `invite.emailNotSetUp`, `invite.emailPreviewBody`, `invite.emailPreviewSubject`, `invite.emailPreviewTitle`, `invite.emailPreviewTitleTest`, `invite.emailQueued`, `invite.resend`, `invite.resendDescription`, `invite.resendEmail`, `invite.resendFailed`, `invite.resendLinkTitle`, `invite.resendNotSent`, `invite.resendQueued`, `invite.resendTitle`, `invite.resending`, `invite.status.failed`, `invite.status.not_configured`, `invite.status.queued`, `invite.status.sent`, `members.emailPlaceholder`, `nav.importExport`, `onboarding.namePlaceholder`, `polish.errorBody`, `polish.fatalBody`, `polish.fatalTitle`, `sf.delete`, `sf.deleteBody`, `sf.deleteNamed`, `sf.deleteTitle`, `sf.deleted`, `sf.full`, `sf.loading`, `sf.manage`, `sf.manageTitle`, `sf.menu`, `sf.nameLabel`, `sf.namePlaceholder`, `sf.nameRequired`, `sf.nameTooLong`, `sf.none`, `sf.noneBody`, `sf.rename`, `sf.renameNamed`, `sf.renameTitle`, `sf.renamed`, `sf.retry`, `sf.save`, `sf.saveCurrent`, `sf.saveTitle`, `sf.saved`, `sf.saving`, `shell.searchHint`, `views.board`, `views.cal.agendaEmpty`, `views.cal.archivedReadOnly`, `views.cal.dayCards`, `views.cal.dragHint`, `views.cal.dragKeyboard`, `views.cal.dropOn`, `views.cal.dueMoved`, `views.cal.label`, `views.cal.lessCards`, `views.cal.moreCards`, `views.cal.next`, `views.cal.noDate`, `views.cal.noDateEmpty`, `views.cal.prev`, `views.cal.readOnly`, `views.cal.today`, `views.cal.today.sr`, `views.calendar`, `views.loadFailed`, `views.loadMore`, `views.loadingCards`, `views.partial`, `views.switcher`, `views.table`, `views.table.assignees`, `views.table.caption`, `views.table.due`, `views.table.empty`, `views.table.emptyBody`, `views.table.labels`, `views.table.lane`, `views.table.noDue`, `views.table.openCard`, `views.table.priority`, `views.table.sortBy`, `views.table.sortedAsc`, `views.table.sortedDesc`, `views.table.title`

### ar: 183 untranslated (0 beyond the shared list)

none beyond the shared list

### bn: 183 untranslated (0 beyond the shared list)

none beyond the shared list

### de: 235 untranslated (52 beyond the shared list)

`appearance.accent.indigo`, `appearance.accent.orange`, `appearance.accent.pink`, `appearance.preview.label`, `billing.plan.free`, `billing.plan.pro`, `billing.plan.team`, `boards.boardTitle`, `boards.canvas`, `boards.title`, `boards.visibility.workspace`, `card.labelsList`, `card.moveLane`, `card.movePosition`, `cd.attachmentName`, `cd.fmtCode`, `cd.fmtLink`, `cd.insEmoji`, `cd.labels`, `cd.linkName`, `chat.boardChatTab`, `chat.boardChats`, `chat.cardBoard`, `chat.groupPlaceholder`, `chat.nameLabel`, `chat.namePlaceholder`, `chat.person`, `chat.thread`, `chat.title`, `common.optional`, `dock.boards`, `dock.chat`, `inbox.board`, `inbox.lane`, `members.col.status`, `members.role.admin`, `members.role.owner`, `nav.board`, `nav.boards`, `nav.chat`, `nav.workspace`, `onboarding.step.name`, `palette.groupBoards`, `shortcuts.goBoards`, `shortcuts.goChat`, `tpl.lane.backlog`, `tpl.lane.review`, `tpl.sprint`, `workspace.role.admin`, `workspace.switcher`, `workspaceSettings.name`, `workspaceSettings.title`

### es: 198 untranslated (15 beyond the shared list)

`billing.plan.pro`, `billing.planLegend`, `cd.insEmoji`, `cd.labelColor`, `chat.boardChatTab`, `chat.title`, `dock.chat`, `lane.color`, `nav.chat`, `shortcuts.general`, `shortcuts.goChat`, `tpl.lane.ideas`, `tpl.personal`, `tpl.sprint`, `workspaceSettings.plan`

### fa: 183 untranslated (0 beyond the shared list)

none beyond the shared list

### fr: 208 untranslated (25 beyond the shared list)

`appearance.accent.indigo`, `appearance.accent.orange`, `appearance.mode.title`, `appearance.preview.label`, `billing.plan.pro`, `bx.grad.graphite`, `card.movePosition`, `cd.description`, `cd.fmtCode`, `cd.insImage`, `chat.boardChatTab`, `chat.composerLabel`, `chat.conversations`, `chat.messages`, `chat.namePlaceholder`, `chat.title`, `dock.chat`, `members.col.actions`, `nav.chat`, `notif.bell`, `notif.title`, `shell.paletteGroupActions`, `shortcuts.goChat`, `tpl.lane.backlog`, `tpl.sprint`

### hi: 183 untranslated (0 beyond the shared list)

none beyond the shared list

### id: 206 untranslated (23 beyond the shared list)

`appearance.accent.indigo`, `appearance.accent.teal`, `appearance.mode.title`, `billing.plan.pro`, `boards.boardTitle`, `boards.canvas`, `boards.visibility.workspace`, `card.moveLane`, `cd.edit`, `cd.insEmoji`, `cd.itemEdit`, `cd.labelEdit`, `inbox.lane`, `members.col.status`, `members.role.admin`, `nav.board`, `nav.workspace`, `tpl.lane.backlog`, `tpl.lane.review`, `tpl.sprint`, `workspace.role.admin`, `workspace.switcher`, `workspaceSettings.title`

### it: 212 untranslated (29 beyond the shared list)

`account.title`, `appearance.accent.lime`, `appearance.preview.label`, `billing.plan.free`, `billing.plan.pro`, `billing.plan.team`, `boards.boardTitle`, `boards.canvas`, `boards.visibility.workspace`, `cd.checklistDefault`, `cd.fmtLink`, `cd.insEmoji`, `chat.boardChatTab`, `chat.cardChip`, `chat.namePlaceholder`, `chat.thread`, `chat.title`, `dock.chat`, `inbox.lane`, `nav.account`, `nav.card`, `nav.chat`, `nav.workspace`, `shortcuts.goChat`, `tpl.lane.backlog`, `tpl.sprint`, `workspace.role.admin`, `workspace.switcher`, `workspaceSettings.title`

### ja: 185 untranslated (2 beyond the shared list)

`billing.plan.pro`, `chat.namePlaceholder`

### ko: 185 untranslated (2 beyond the shared list)

`billing.plan.pro`, `chat.namePlaceholder`

### pt: 200 untranslated (17 beyond the shared list)

`appearance.preview.label`, `billing.plan.pro`, `boards.visibility.workspace`, `cd.fmtLink`, `cd.insEmoji`, `chat.boardChatTab`, `chat.namePlaceholder`, `chat.title`, `dock.chat`, `members.col.status`, `nav.chat`, `nav.workspace`, `shortcuts.goChat`, `tpl.lane.backlog`, `tpl.sprint`, `workspace.switcher`, `workspaceSettings.title`

### ru: 187 untranslated (4 beyond the shared list)

`billing.plan.free`, `billing.plan.pro`, `billing.plan.team`, `chat.namePlaceholder`

### sw: 188 untranslated (5 beyond the shared list)

`appearance.accent.indigo`, `billing.plan.pro`, `billing.plan.team`, `cd.insEmoji`, `chat.namePlaceholder`

### th: 187 untranslated (4 beyond the shared list)

`billing.plan.pro`, `billing.plan.team`, `chat.namePlaceholder`, `tpl.lane.backlog`

### tr: 191 untranslated (8 beyond the shared list)

`billing.plan.free`, `billing.plan.pro`, `billing.plan.team`, `billing.planLegend`, `cd.insEmoji`, `chat.namePlaceholder`, `tpl.sprint`, `workspaceSettings.plan`

### ur: 184 untranslated (1 beyond the shared list)

`chat.namePlaceholder`

### vi: 188 untranslated (5 beyond the shared list)

`billing.plan.pro`, `billing.plan.team`, `cd.insEmoji`, `chat.namePlaceholder`, `tpl.sprint`

### zh: 184 untranslated (1 beyond the shared list)

`chat.namePlaceholder`

## 2026-11-03 Typography CSS pass (`src/styles/i18n.css`, CSS only)

Selectors use `:lang()`; `applyDocumentLocale()` and `App.astro` set `<html lang="<code>" dir class="lang-<code>">` with bare codes, so `html:lang(ar)` etc. match. Latin locales match none of the new rules (output unchanged).

- `--font-display` re-resolved on `html[class*='lang-']`, so titles use the language's Noto stack (rtl-audit Gap 1).
- `letter-spacing: 0 !important` for ar, ur, fa, th, hi, bn (joining, clusters) and zh, ja, ko (rtl-audit item 5).
- `text-transform: none !important` for all non-Latin locales (labels, `.eyebrow`, chat section label).
- Nastaliq (ur) line-height 1.9 on text elements and named card/lane/button classes (item 6); th/hi/bn 1.6 on compact UI text.
- th/zh/ja: `line-break: strict`, `overflow-wrap: break-word`; ko: `word-break: keep-all` plus `overflow-wrap: break-word`.
- Urdu fallback chain now has 'LF Noto Arabic' before 'Noto Sans Arabic' (Gap 2).

Not done: 12 px CJK minimum, `lang` on the shell subtree (TSX). Needs a browser check in ur, th, ko: no clipped Nastaliq titles, no overflow in narrow cards.

Update 2026-11-03: the 12 px CJK minimum is now in `src/styles/i18n-cjk.css` (`html:lang(zh|ja|ko)`, small-text classes). `lang` on the shell subtree is not needed (`html lang` is set by `applyDocumentLocale`).
