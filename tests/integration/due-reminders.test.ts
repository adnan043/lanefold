import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {forgetEntitlements} from '../../src/server/entitlements';
import {runDueReminders, runTimedReminder} from '../../src/server/jobs/due-reminders';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

const day = (n: number) => new Date(`${new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`);

/** The hourly due-reminders job (real Postgres). */
describe.skipIf(!DATABASE_URL)('due reminders (integration, real Postgres)', () => {
  let ann: Browser;
  let bob: Browser;
  let ws: number;
  let board: number;
  let card: number;
  let annId: number;
  let bobId: number;
  let cat: number; // member of Ann's workspace, assigned
  let outsider: number; // another workspace's user

  const due = (on: Date | null, id = card) => db.card.update({where: {id}, data: {dueDate: on}});
  const run = () => runDueReminders(db);
  const bells = (userIdValue: number) => db.notification.findMany({where: {userId: userIdValue, kind: 'due_soon'}, select: {cardId: true, actorId: true, boardId: true, workspaceId: true}});

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.61');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.62');
    await signedIn(app, 'cat@example.test', undefined, '203.0.113.63');
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    annId = await userId('ann@example.test');
    bobId = await userId('bob@example.test');
    cat = await userId('cat@example.test');
    outsider = bobId;
    await db.workspaceMember.create({data: {workspaceId: ws, userId: cat, role: 'member'}});
    board = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Ops', lanes: ['To do']})).json.board.id;
    const lane = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].id;
    card = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'Ship it'})).json.items[0].id;
    await db.cardMember.create({data: {cardId: card, userId: cat, workspaceId: ws}});
    await db.notification.deleteMany();
    await db.cardWatcher.deleteMany();
  });

  it('reminds an assignee once for a card due tomorrow, and a second run sends nothing', async () => {
    await due(day(1));
    expect((await run()).sent).toBe(1);
    expect(await bells(cat)).toEqual([{cardId: card, actorId: null, boardId: board, workspaceId: ws}]);
    expect((await run()).sent).toBe(0);
    expect(await bells(cat)).toHaveLength(1);
  });

  it('reminds on the due day too, once per due date (not again when tomorrow becomes today)', async () => {
    await due(day(1));
    await run();
    await due(day(0)); // a NEW due date: the key differs, one more reminder is allowed
    expect((await run()).sent).toBe(1);
    expect((await run()).sent).toBe(0);
    expect(await bells(cat)).toHaveLength(2);
  });

  it('also reminds followers, once even when they are assigned and follow', async () => {
    await due(day(0));
    await db.cardWatcher.createMany({data: [{cardId: card, userId: annId}, {cardId: card, userId: cat}]});
    expect((await run()).sent).toBe(2);
    expect(await bells(annId)).toHaveLength(1);
    expect(await bells(cat)).toHaveLength(1);
  });

  it('ignores cards due later, overdue, undated, completed and archived', async () => {
    await due(day(2));
    expect((await run()).sent).toBe(0);
    await due(day(-1));
    expect((await run()).sent).toBe(0);
    await due(null);
    expect((await run()).sent).toBe(0);
    await due(day(1));
    await db.card.update({where: {id: card}, data: {completedAt: new Date()}});
    expect((await run()).sent).toBe(0);
    await db.card.update({where: {id: card}, data: {completedAt: null, archivedAt: new Date()}});
    expect((await run()).sent).toBe(0);
    expect(await db.notification.count()).toBe(0);
  });

  it('skips an archived board and an archived workspace', async () => {
    await due(day(1));
    await db.board.update({where: {id: board}, data: {archivedAt: new Date()}});
    expect((await run()).sent).toBe(0);
    await db.board.update({where: {id: board}, data: {archivedAt: null}});
    await db.workspace.update({where: {id: ws}, data: {archivedAt: new Date()}});
    expect((await run()).sent).toBe(0);
    expect(await db.notification.count()).toBe(0);
  });

  it('skips someone who lost access: removed member, private board without a seat, someone else\'s Inbox', async () => {
    await due(day(1));
    await db.cardWatcher.create({data: {cardId: card, userId: annId}});
    await db.workspaceMember.delete({where: {workspaceId_userId: {workspaceId: ws, userId: cat}}});
    await db.board.update({where: {id: board}, data: {visibility: 'private'}});
    // Ann is the workspace owner (sees every private board): still told. Cat has no seat any more: not told.
    expect((await run()).sent).toBe(1);
    expect(await bells(cat)).toEqual([]);
    expect(await bells(annId)).toHaveLength(1);
  });

  it('a member without a seat on a private board is not told, a seated one is', async () => {
    await due(day(1));
    await db.board.update({where: {id: board}, data: {visibility: 'private'}});
    expect((await run()).sent).toBe(0);
    await db.boardMember.create({data: {boardId: board, userId: cat, workspaceId: ws, role: 'member'}});
    expect((await run()).sent).toBe(1);
    expect(await bells(cat)).toHaveLength(1);
  });

  it('never notifies another workspace\'s user, even if they follow the card', async () => {
    await due(day(1));
    await db.cardWatcher.create({data: {cardId: card, userId: outsider}});
    await run();
    expect(await bells(outsider)).toEqual([]);
    expect(await bells(cat)).toHaveLength(1);
  });

  it('skips a read-only workspace (over its plan limit, grace over) and resumes when it is fine again', async () => {
    await due(day(1));
    await db.workspace.update({where: {id: ws}, data: {plan: 'free', memberCount: 9999, graceUntil: new Date(Date.now() - 86_400_000)}});
    forgetEntitlements(db, ws);
    expect((await run()).sent).toBe(0);
    await db.workspace.update({where: {id: ws}, data: {memberCount: 2, graceUntil: null}});
    forgetEntitlements(db, ws);
    expect((await run()).sent).toBe(1);
  });

  it('forgets reminder keys a week after the due day', async () => {
    await db.dueReminder.create({data: {cardId: card, userId: cat, dueOn: day(-20)}});
    await db.dueReminder.create({data: {cardId: card, userId: annId, dueOn: day(-2)}});
    expect((await run()).pruned).toBe(1);
    expect(await db.dueReminder.count()).toBe(1);
  });

  it('reminded cards do not eat the run budget: 60 due cards with a budget of 25 are all reminded across runs', async () => {
    await due(day(1));
    const lane = (await db.lane.findFirstOrThrow({where: {boardId: board}})).id;
    const extra = Array.from({length: 59}, (_, i) => ({number: 1000 + i, boardId: board, laneId: lane, workspaceId: ws, title: `Due ${i}`, position: `a${String(i).padStart(3, '0')}`, dueDate: day(1), createdBy: annId}));
    await db.card.createMany({data: extra});
    const ids = (await db.card.findMany({where: {boardId: board}, select: {id: true}})).map(c => c.id);
    await db.cardMember.createMany({data: ids.filter(id => id !== card).map(id => ({cardId: id, userId: cat, workspaceId: ws})), skipDuplicates: true});
    await db.notification.deleteMany();
    let total = 0;
    for (let i = 0; i < 4; i++) total += (await runDueReminders(db, new Date(), 25)).sent;
    expect(total).toBe(60);
    expect(await bells(cat)).toHaveLength(60);
    expect((await runDueReminders(db, new Date(), 25)).sent).toBe(0);
  });

  it('a follower added after the first run still gets one reminder', async () => {
    await due(day(1));
    expect((await run()).sent).toBe(1);
    await db.cardWatcher.create({data: {cardId: card, userId: annId}});
    expect((await run()).sent).toBe(1);
    expect(await bells(annId)).toHaveLength(1);
    expect(await bells(cat)).toHaveLength(1);
    expect((await run()).sent).toBe(0);
  });

  describe('a due time with a picked reminder', () => {
    const MIN = 60_000;
    /** A due moment `ms` from now, its UTC day as the due date (a valid pair for the route's zone check). */
    const timed = (ms: number, remind: number | null) => {
      const at = new Date(Math.floor((Date.now() + ms) / MIN) * MIN);
      const dueDate = new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
      return db.card.update({where: {id: card}, data: {dueDate, dueAt: at, dueRemindMinutes: remind}});
    };

    it('reminds once the reminder moment has come, not before, and only once', async () => {
      await timed(3 * 60 * MIN, 60); // due in 3 h, remind 1 h before: not yet
      expect((await run()).sent).toBe(0);
      expect(await runTimedReminder(db, {cardId: card})).toBe(0);
      await timed(30 * MIN, 60); // due in 30 min, remind 1 h before: now
      expect(await runTimedReminder(db, {cardId: card})).toBe(1);
      expect(await runTimedReminder(db, {cardId: card})).toBe(0);
      expect((await run()).sent).toBe(0);
      expect(await bells(cat)).toHaveLength(1);
    });

    it('the hourly run is the safety net, and skips the day rule for a timed card', async () => {
      await timed(20 * 60 * MIN, 15); // due tomorrow-ish with a time: the day rule must not fire early
      expect((await run()).sent).toBe(0);
      await timed(10 * MIN, 15);
      expect((await run()).sent).toBe(1);
    });

    it('the timed job skips a card on an archived board or in an archived workspace', async () => {
      await timed(30 * MIN, 60);
      await db.board.update({where: {id: board}, data: {archivedAt: new Date()}});
      expect(await runTimedReminder(db, {cardId: card})).toBe(0);
      await db.board.update({where: {id: board}, data: {archivedAt: null}});
      await db.workspace.update({where: {id: ws}, data: {archivedAt: new Date()}});
      expect(await runTimedReminder(db, {cardId: card})).toBe(0);
      await db.workspace.update({where: {id: ws}, data: {archivedAt: null}});
      expect(await runTimedReminder(db, {cardId: card})).toBe(1);
    });

    it('sends nothing for "None", or for a due time long past', async () => {
      await timed(10 * MIN, null);
      expect((await run()).sent).toBe(0);
      await timed(-60 * MIN, 0);
      expect((await run()).sent).toBe(0);
      expect(await runTimedReminder(db, {cardId: card})).toBe(0);
    });

    it('ignores bad job data', async () => {
      expect(await runTimedReminder(db, {cardId: 'x'})).toBe(0);
      expect(await runTimedReminder(db, null)).toBe(0);
      expect(await runTimedReminder(db, {cardId: 999_999})).toBe(0);
    });

    it('a new due day without a time drops the time and the reminder (trigger)', async () => {
      await timed(30 * MIN, 60);
      await due(day(5));
      expect(await db.card.findUnique({where: {id: card}, select: {dueAt: true, dueRemindMinutes: true}})).toEqual({dueAt: null, dueRemindMinutes: null});
    });

    it('the PATCH route saves a time and a reminder, checks them, and another user gets 404', async () => {
      const dueDate = day(3).toISOString().slice(0, 10);
      const dueAt = `${dueDate}T09:30:00.000Z`;
      const ok = await ann.request('PATCH', `/site-api/cards/${card}/details`, {dueDate, dueAt, dueRemindMinutes: 15});
      expect(ok.status).toBe(200);
      const detail = (await ann.get(`/site-api/cards/${card}/detail`)).json.card;
      expect(detail).toMatchObject({dueDate, dueAt, dueRemindMinutes: 15});
      expect((await ann.request('PATCH', `/site-api/cards/${card}/details`, {dueRemindMinutes: 7})).status).toBe(422);
      expect((await ann.request('PATCH', `/site-api/cards/${card}/details`, {dueAt: 'tomorrow'})).status).toBe(422);
      // A time on another day than the due day.
      expect((await ann.request('PATCH', `/site-api/cards/${card}/details`, {dueAt: `${day(9).toISOString().slice(0, 10)}T09:30:00.000Z`})).status).toBe(422);
      expect((await bob.request('PATCH', `/site-api/cards/${card}/details`, {dueAt, dueRemindMinutes: 0})).status).toBe(404);
      expect((await bob.get(`/site-api/cards/${card}/detail`)).status).toBe(404);
      // Removing the dates clears the time and the reminder too.
      expect((await ann.request('PATCH', `/site-api/cards/${card}/details`, {dueDate: null, dueAt: null, dueRemindMinutes: null})).status).toBe(200);
      expect((await ann.get(`/site-api/cards/${card}/detail`)).json.card).toMatchObject({dueDate: null, dueAt: null, dueRemindMinutes: null});
    });
  });

  describe('a checklist item with a due time and a reminder', () => {
    const MIN = 60_000;
    let item: number;
    const itemBells = (who: number) => db.notification.findMany({where: {userId: who, kind: 'item_due'}, select: {cardId: true, actorId: true, boardId: true}});
    /** A due moment `ms` from now on the item, its UTC day as the due date. */
    const timed = (ms: number, remind: number | null, assigneeId: number | null = null) => {
      const at = new Date(Math.floor((Date.now() + ms) / MIN) * MIN);
      const dueDate = new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
      return db.checklistItem.update({where: {id: item}, data: {dueDate, dueAt: at, dueRemindMinutes: remind, assigneeId}});
    };
    beforeEach(async () => {
      const list = (await ann.post(`/site-api/cards/${card}/checklists`, {title: 'Steps'})).json.checklist.id;
      item = (await ann.post(`/site-api/checklists/${list}/items`, {text: 'Call the venue'})).json.items[0].id;
      await db.notification.deleteMany();
    });

    it('reminds the item\'s assignee once its moment has come, and only once', async () => {
      await timed(3 * 60 * MIN, 60, annId);
      expect(await runTimedReminder(db, {itemId: item})).toBe(0);
      await timed(30 * MIN, 60, annId);
      expect(await runTimedReminder(db, {itemId: item})).toBe(1);
      expect(await runTimedReminder(db, {itemId: item})).toBe(0);
      expect((await run()).items?.sent).toBe(0);
      expect(await itemBells(annId)).toEqual([{cardId: card, actorId: null, boardId: board}]);
      expect(await itemBells(cat)).toHaveLength(0); // the card's assignee is not told when the item has its own person
    });

    it('an item with nobody on it reminds the card\'s assignees; the hourly run is the safety net', async () => {
      await timed(10 * MIN, 15);
      expect((await run()).items?.sent).toBe(1);
      expect(await itemBells(cat)).toHaveLength(1);
    });

    it('a ticked item, "None", a long-past time and an outsider assignee send nothing', async () => {
      await timed(10 * MIN, null, cat);
      expect((await run()).items?.sent).toBe(0);
      await timed(-60 * MIN, 0, cat);
      expect((await run()).items?.sent).toBe(0);
      await timed(10 * MIN, 15, outsider);
      expect((await run()).items?.sent).toBe(0);
      await timed(10 * MIN, 15, cat);
      await db.checklistItem.update({where: {id: item}, data: {doneAt: new Date()}});
      expect((await run()).items?.sent).toBe(0);
    });

    it('a new time reminds again; a new day without a time drops the time (trigger)', async () => {
      await timed(10 * MIN, 15, cat);
      expect((await run()).items?.sent).toBe(1);
      await timed(12 * MIN, 15, cat);
      expect((await run()).items?.sent).toBe(1);
      await db.checklistItem.update({where: {id: item}, data: {dueDate: day(5)}});
      expect(await db.checklistItem.findUnique({where: {id: item}, select: {dueAt: true, dueRemindMinutes: true}})).toEqual({dueAt: null, dueRemindMinutes: null});
    });

    it('the item PATCH saves a time and a reminder, checks them, and another user gets 404', async () => {
      const dueDate = day(3).toISOString().slice(0, 10);
      const dueAt = `${dueDate}T09:30:00.000Z`;
      expect((await ann.request('PATCH', `/site-api/checklist-items/${item}`, {dueDate, dueAt, dueRemindMinutes: 15})).status).toBe(200);
      const items = (await ann.get(`/site-api/cards/${card}/detail`)).json.checklists[0].items;
      expect(items[0]).toMatchObject({dueDate, dueAt, dueRemindMinutes: 15});
      expect((await ann.request('PATCH', `/site-api/checklist-items/${item}`, {dueRemindMinutes: 7})).status).toBe(422);
      expect((await ann.request('PATCH', `/site-api/checklist-items/${item}`, {dueAt: 'tomorrow'})).status).toBe(422);
      expect((await ann.request('PATCH', `/site-api/checklist-items/${item}`, {dueAt: `${day(9).toISOString().slice(0, 10)}T09:30:00.000Z`})).status).toBe(422);
      expect((await bob.request('PATCH', `/site-api/checklist-items/${item}`, {dueDate, dueAt, dueRemindMinutes: 0})).status).toBe(404);
      expect(await db.checklistItem.findUnique({where: {id: item}, select: {dueRemindMinutes: true}})).toEqual({dueRemindMinutes: 15});
      expect((await ann.request('PATCH', `/site-api/checklist-items/${item}`, {dueDate: null, dueAt: null, dueRemindMinutes: null})).status).toBe(200);
      expect((await ann.get(`/site-api/cards/${card}/detail`)).json.checklists[0].items[0]).toMatchObject({dueDate: null, dueAt: null, dueRemindMinutes: null});
    });
  });
});
