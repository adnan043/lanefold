/**
 * LOCAL-ONLY demo data: gives an EXISTING user a "Demo Studio" workspace (plan team) with 3 boards,
 * ~25 cards, a #general channel and a couple of notifications, so the app can be seen populated.
 *
 *   npm run seed:demo -- you@example.com            (or DEMO_USER_EMAIL=you@example.com npm run seed:demo)
 *   npm run seed:demo -- you@example.com --dry-run  (prints the plan, touches no database)
 *
 * Never creates or changes a user (no admin, no password). Refuses unless the database is localhost/127.0.0.1/::1, named *_test or *_demo, or SITE_PREVIEW=1 (scripts/seed-guard.ts). --dry is the same as --dry-run.
 * Refuses when the demo workspace of that user already exists. Run by Node's built-in TypeScript support.
 */
import {PrismaPg} from '@prisma/adapter-pg';
import {generateKeyBetween} from 'fractional-indexing';
import {checkSeedTarget} from './seed-guard.ts';
import {PrismaClient} from '../src/generated/prisma-node/client.ts';

const NAME = 'Demo Studio';
const DAY = 86_400_000;

type CardSpec = {t: string; lane: number; prio?: string; due?: number; done?: boolean; labels?: number[]; assign?: boolean; est?: number; desc?: string; check?: [string, boolean][]; comments?: string[]};
type BoardSpec = {name: string; bg: [string, string]; lanes: string[]; labels: [string, string][]; cards: CardSpec[]};

const BOARDS: BoardSpec[] = [
  {
    name: 'Sprint', bg: ['#E0E7FF', '#C7D2FE'], lanes: ['Backlog', 'In progress', 'Review', 'Done'],
    labels: [['Bug', '#DC2626'], ['Feature', '#2563EB'], ['Chore', '#71717A']],
    cards: [
      {t: 'Fix login redirect loop', lane: 1, prio: 'high', due: 1, labels: [0], assign: true, est: 90, desc: 'Users land back on the sign-in page after a successful login on Safari.', check: [['Reproduce on Safari', true], ['Patch the redirect', false], ['Add a regression test', false]], comments: ['Reproduced it: the cookie is dropped on the redirect.', 'Patch is up, needs a second pair of eyes.']},
      {t: 'Drag and drop between lanes', lane: 2, prio: 'medium', due: 3, labels: [1], assign: true, check: [['Pointer support', true], ['Keyboard support', true], ['Touch support', false]]},
      {t: 'Onboarding checklist copy', lane: 0, prio: 'low', due: 8, labels: [2]},
      {t: 'Card detail drawer polish', lane: 1, prio: 'medium', due: -1, labels: [1], assign: true},
      {t: 'Upgrade dependencies', lane: 0, labels: [2], est: 120},
      {t: 'Export board to CSV', lane: 0, prio: 'low', due: 14, labels: [1]},
      {t: 'Search across boards', lane: 3, prio: 'medium', done: true, labels: [1], assign: true, comments: ['Shipped. Ctrl+K opens it.']},
      {t: 'Set up error tracking', lane: 3, done: true, labels: [2]},
      {t: 'Notification bell empty state', lane: 2, prio: 'low', due: 2, labels: [1], assign: true},
    ],
  },
  {
    name: 'Content calendar', bg: ['#FEF3C7', '#FDE68A'], lanes: ['Ideas', 'Drafting', 'Scheduled', 'Published'],
    labels: [['Blog', '#7C3AED'], ['Social', '#DB2777'], ['Newsletter', '#059669']],
    cards: [
      {t: 'Launch announcement post', lane: 1, prio: 'high', due: 2, labels: [0], assign: true, check: [['Outline', true], ['First draft', true], ['Screenshots', false], ['Proofread', false]], comments: ['Headline options are in the doc.']},
      {t: 'Behind the scenes thread', lane: 0, labels: [1]},
      {t: 'Monthly newsletter', lane: 2, prio: 'medium', due: 5, labels: [2], assign: true},
      {t: 'Customer story: Acme', lane: 0, prio: 'low', labels: [0]},
      {t: 'Keyboard shortcuts cheat sheet', lane: 1, due: 9, labels: [0, 1], assign: true},
      {t: 'Holiday sale teaser', lane: 2, prio: 'medium', due: 12, labels: [1]},
      {t: 'Welcome email series', lane: 3, done: true, labels: [2], assign: true},
      {t: 'Product tour video script', lane: 0, prio: 'low', labels: [0]},
    ],
  },
  {
    name: 'Personal', bg: ['#DCFCE7', '#BBF7D0'], lanes: ['To do', 'Doing', 'Done'],
    labels: [['Home', '#EA580C'], ['Health', '#0891B2']],
    cards: [
      {t: 'Book dentist appointment', lane: 0, prio: 'medium', due: 4, labels: [1], assign: true},
      {t: 'Plan the weekend trip', lane: 1, labels: [0], assign: true, check: [['Pick dates', true], ['Book a place', false]]},
      {t: 'Renew passport', lane: 0, prio: 'high', due: 20, assign: true},
      {t: 'Morning run routine', lane: 2, done: true, labels: [1], assign: true},
      {t: 'Clean the garage', lane: 0, prio: 'low', labels: [0]},
    ],
  },
];

const MESSAGES = [
  'Welcome to Demo Studio! This is #general.',
  'Sprint board is set up, take a look when you have a minute.',
  'I moved the login bug to In progress.',
  'Reminder: content calendar review on Thursday.',
  'The launch post draft is almost ready.',
  'Does anyone know where the brand assets live?',
  'Found them, I will pin the folder link here.',
  'Drag and drop is in review now.',
  'Nice work on search, it is really fast.',
  'Let us wrap up the sprint on Friday.',
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('--dry');
const email = (args.find(a => !a.startsWith('--')) ?? process.env.DEMO_USER_EMAIL ?? '').trim().toLowerCase();
const nCards = BOARDS.reduce((n, b) => n + b.cards.length, 0);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!email || !email.includes('@')) fail('Usage: npm run seed:demo -- <email of an existing user> [--dry-run]   (or set DEMO_USER_EMAIL)');

if (dryRun) {
  console.log(`[dry run] no database is touched. For the existing user ${email.replace(/^(.).*(@.*)$/, '$1***$2')} it would create:`);
  console.log(`  - workspace "${NAME}" (plan team, the user as owner, the only member)`);
  for (const b of BOARDS) console.log(`  - board "${b.name}": lanes ${b.lanes.join(', ')}; ${b.labels.length} labels; ${b.cards.length} cards`);
  console.log(`  - ${nCards} cards in total, checklists, comments, due dates, the user as the only assignee`);
  console.log(`  - #general channel with ${MESSAGES.length} messages from the user, 2 notifications`);
  console.log('It refuses unless the database is local, *_test/*_demo or SITE_PREVIEW=1, and when the demo workspace already exists.');
  process.exit(0);
}

const guard = checkSeedTarget(process.env.DATABASE_URL, process.env);
if (!guard.ok) fail(guard.reason);

const db = new PrismaClient({adapter: new PrismaPg({connectionString: process.env.DATABASE_URL})});

try {
  const user = await db.user.findUnique({where: {email}, select: {id: true, name: true}});
  if (!user) fail('No user with that email exists. Sign up in the app first; this script never creates users.');

  const slug = `demo-studio-${user.id}`;
  const existing = await db.workspace.findUnique({where: {slug}, select: {id: true}});
  if (existing) {
    console.log(`The demo workspace already exists (workspace id ${existing.id}). Nothing was changed.`);
    process.exit(0);
  }

  const limit = await db.planLimit.findUnique({where: {plan: 'team'}, select: {maxMembers: true}});
  const today = Date.parse(new Date().toISOString().slice(0, 10)); // UTC midnight, for @db.Date
  const date = (offset: number) => new Date(today + offset * DAY);

  await db.$transaction(async tx => {
    const ws = await tx.workspace.create({
      data: {name: NAME, slug, plan: 'team', memberLimit: limit?.maxMembers ?? 50, memberCount: 1, createdBy: user.id},
      select: {id: true},
    });
    await tx.workspaceMember.create({data: {workspaceId: ws.id, userId: user.id, role: 'owner'}});

    let firstCardId = 0;
    let firstBoardId = 0;
    const commentCards: number[] = [];
    for (const b of BOARDS) {
      const board = await tx.board.create({
        data: {workspaceId: ws.id, name: b.name, visibility: 'workspace', bgKind: 'gradient', bgColor1: b.bg[0], bgColor2: b.bg[1], rev: 1, createdBy: user.id},
        select: {id: true},
      });
      if (!firstBoardId) firstBoardId = board.id;
      let prevLane: string | null = null;
      const laneIds: number[] = [];
      const counts = b.lanes.map(() => 0);
      for (const name of b.lanes) {
        prevLane = generateKeyBetween(prevLane, null);
        const lane = await tx.lane.create({data: {boardId: board.id, workspaceId: ws.id, name, position: prevLane, updatedRev: 1}, select: {id: true}});
        laneIds.push(lane.id);
      }
      const labelIds: number[] = [];
      for (const [name, colorHex] of b.labels) {
        const l = await tx.label.create({data: {boardId: board.id, workspaceId: ws.id, name, colorHex}, select: {id: true}});
        labelIds.push(l.id);
      }
      const lastInLane: (string | null)[] = b.lanes.map(() => null);
      let nextNumber = 1;
      for (const c of b.cards) {
        const position = (lastInLane[c.lane] = generateKeyBetween(lastInLane[c.lane], null));
        counts[c.lane]++;
        const check = c.check ?? [];
        const card = await tx.card.create({
          data: {
            number: nextNumber++, boardId: board.id, laneId: laneIds[c.lane], workspaceId: ws.id, title: c.t, descriptionMd: c.desc ?? '', position,
            priority: c.prio ?? 'none', estimateMinutes: c.est ?? null, dueDate: c.due === undefined ? null : date(c.due),
            completedAt: c.done ? new Date() : null, checklistTotal: check.length, checklistDone: check.filter(x => x[1]).length,
            commentCount: c.comments?.length ?? 0, updatedRev: 1, createdBy: user.id,
          },
          select: {id: true},
        });
        if (!firstCardId) firstCardId = card.id;
        if (c.labels?.length) await tx.cardLabel.createMany({data: c.labels.map(i => ({cardId: card.id, labelId: labelIds[i]}))});
        if (c.assign) await tx.cardMember.create({data: {cardId: card.id, userId: user.id, workspaceId: ws.id}});
        if (check.length) {
          const cl = await tx.checklist.create({data: {cardId: card.id, workspaceId: ws.id, title: 'Checklist', position: generateKeyBetween(null, null)}, select: {id: true}});
          let prev: string | null = null;
          await tx.checklistItem.createMany({
            data: check.map(([text, done]) => ({checklistId: cl.id, workspaceId: ws.id, text, position: (prev = generateKeyBetween(prev, null)), doneAt: done ? new Date() : null})),
          });
        }
        if (c.comments?.length) {
          await tx.comment.createMany({data: c.comments.map(bodyMd => ({cardId: card.id, workspaceId: ws.id, authorId: user.id, bodyMd}))});
          commentCards.push(card.id);
        }
        await tx.activity.create({data: {workspaceId: ws.id, boardId: board.id, cardId: card.id, actorId: user.id, kind: 'card.created', meta: {title: c.t}}});
      }
      for (let i = 0; i < laneIds.length; i++) await tx.lane.update({where: {id: laneIds[i]}, data: {cardCount: counts[i]}});
      await tx.board.update({where: {id: board.id}, data: {nextCardNumber: nextNumber}});
    }

    const conv = await tx.conversation.create({data: {workspaceId: ws.id, kind: 'channel', name: 'general', createdBy: user.id, lastSeq: MESSAGES.length}, select: {id: true}});
    await tx.conversationMember.create({data: {conversationId: conv.id, userId: user.id, workspaceId: ws.id, lastReadSeq: MESSAGES.length}});
    const base = Date.now() - MESSAGES.length * 3_600_000;
    await tx.message.createMany({
      data: MESSAGES.map((bodyMd, i) => ({
        conversationId: conv.id, workspaceId: ws.id, seq: i + 1, senderId: user.id, bodyMd,
        clientId: `demo-${ws.id}-${i + 1}`, createdAt: new Date(base + i * 3_600_000),
      })),
    });

    await tx.notification.createMany({
      data: [
        {userId: user.id, workspaceId: ws.id, kind: 'assigned', actorId: null, boardId: firstBoardId, cardId: firstCardId},
        {userId: user.id, workspaceId: ws.id, kind: 'comment', actorId: null, boardId: firstBoardId, cardId: commentCards[0] ?? firstCardId},
      ],
    });
  }, {timeout: 60_000, maxWait: 10_000});

  console.log(`Done: "${NAME}" created for the existing user (${nCards} cards on ${BOARDS.length} boards, #general with ${MESSAGES.length} messages). Reload the app.`);
} finally {
  await db.$disconnect();
}
