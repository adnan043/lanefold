import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {runStaleCards} from '../../src/server/jobs/stale-cards';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

const DAY = 86_400_000;

/** The daily stale-cards job and the board setting behind it (real Postgres). */
describe.skipIf(!DATABASE_URL)('stale cards (integration, real Postgres)', () => {
  let ann: Browser; // workspace owner
  let bob: Browser; // another workspace
  let cat: Browser; // member of Ann's workspace (not a board admin)
  let vic: Browser; // viewer of Ann's workspace
  let ws: number;
  let board: number;
  let lane1: number;
  let lane2: number;
  let card: number;
  let annId: number;
  let catId: number;
  let bobId: number;

  const bells = (user: number) => db.notification.findMany({where: {userId: user, kind: 'card_stale'}, select: {cardId: true, actorId: true, boardId: true, workspaceId: true}});
  const turnOn = (days: number | null = 7) => db.board.update({where: {id: board}, data: {staleDays: days}});
  /** The card came into its lane `n` days before `at`. */
  const enteredAgo = (n: number, at: Date, id = card) => db.card.update({where: {id}, data: {laneEnteredAt: new Date(at.getTime() - n * DAY)}});
  const now = () => new Date();
  const put = (who: Browser, id: number, body: unknown) => who.request('PUT', `/site-api/boards/${id}/stale-days`, body);

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.72');
    cat = await signedIn(app, 'cat@example.test', undefined, '203.0.113.73');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.74');
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    annId = await userId('ann@example.test');
    catId = await userId('cat@example.test');
    bobId = await userId('bob@example.test');
    await db.workspaceMember.create({data: {workspaceId: ws, userId: catId, role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: ws, userId: await userId('vic@example.test'), role: 'viewer'}});
    board = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Ops', lanes: ['To do', 'Doing']})).json.board.id;
    const lanes = (await ann.get(`/site-api/boards/${board}`)).json.lanes;
    lane1 = lanes[0].id;
    lane2 = lanes[1].id;
    card = (await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'Ship it'})).json.items[0].id;
    await db.cardMember.create({data: {cardId: card, userId: catId, workspaceId: ws}});
    await db.notification.deleteMany();
    await db.cardWatcher.deleteMany();
  });

  describe('the job', () => {
    it('does nothing while the board setting is off (the default), however old the card is', async () => {
      await enteredAgo(100, now());
      expect((await runStaleCards(db)).sent).toBe(0);
      expect(await db.notification.count()).toBe(0);
    });

    it('reminds an assignee once for a card that sat N days, and a second run sends nothing', async () => {
      await turnOn(7);
      await enteredAgo(8, now());
      expect((await runStaleCards(db)).sent).toBe(1);
      expect(await bells(catId)).toEqual([{cardId: card, actorId: null, boardId: board, workspaceId: ws}]);
      expect((await runStaleCards(db)).sent).toBe(0);
      expect(await bells(catId)).toHaveLength(1);
    });

    it('is not stale before N days and is exactly at N days', async () => {
      await turnOn(3);
      const at = new Date('2026-12-01T12:00:00.000Z');
      await enteredAgo(2, at);
      expect((await runStaleCards(db, at)).sent).toBe(0);
      await enteredAgo(3, at);
      expect((await runStaleCards(db, at)).sent).toBe(1);
    });

    it('also reminds followers, once even when they are assigned and follow', async () => {
      await turnOn(7);
      await enteredAgo(9, now());
      await db.cardWatcher.createMany({data: [{cardId: card, userId: annId}, {cardId: card, userId: catId}]});
      expect((await runStaleCards(db)).sent).toBe(2);
      expect(await bells(annId)).toHaveLength(1);
      expect(await bells(catId)).toHaveLength(1);
    });

    it('moving the card resets the clock (a trigger, so every path counts) and the old key is pruned; stale again reminds again', async () => {
      await turnOn(7);
      await enteredAgo(8, now());
      expect((await runStaleCards(db)).sent).toBe(1);
      const before = (await db.card.findUniqueOrThrow({where: {id: card}, select: {laneEnteredAt: true}})).laneEnteredAt;
      expect((await ann.post(`/site-api/cards/${card}/move`, {laneId: lane2, afterId: null})).status).toBe(200);
      const after = (await db.card.findUniqueOrThrow({where: {id: card}, select: {laneEnteredAt: true}})).laneEnteredAt;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
      // Fresh in the new lane: nothing now, and the superseded key is forgotten.
      const idle = await runStaleCards(db);
      expect(idle.sent).toBe(0);
      expect(idle.pruned).toBe(1);
      expect(await db.staleReminder.count()).toBe(0);
      // Ten days later it is stale again: one more reminder.
      expect((await runStaleCards(db, new Date(Date.now() + 10 * DAY))).sent).toBe(1);
      expect(await bells(catId)).toHaveLength(2);
    });

    it('restoring an archived card starts the clock again', async () => {
      await turnOn(7);
      await enteredAgo(30, now());
      expect((await ann.post(`/site-api/cards/${card}/archive`)).status).toBe(200);
      expect((await runStaleCards(db)).sent).toBe(0);
      expect((await ann.post(`/site-api/cards/${card}/restore`)).status).toBe(200);
      expect((await runStaleCards(db)).sent).toBe(0);
    });

    it('ignores completed and archived cards, an archived lane, an archived board and an archived workspace', async () => {
      await turnOn(7);
      await enteredAgo(10, now());
      await db.card.update({where: {id: card}, data: {completedAt: new Date()}});
      expect((await runStaleCards(db)).sent).toBe(0);
      await db.card.update({where: {id: card}, data: {completedAt: null, archivedAt: new Date()}});
      await enteredAgo(10, now());
      expect((await runStaleCards(db)).sent).toBe(0);
      await db.card.update({where: {id: card}, data: {archivedAt: null}});
      await enteredAgo(10, now());
      await db.lane.update({where: {id: lane1}, data: {archivedAt: new Date()}});
      expect((await runStaleCards(db)).sent).toBe(0);
      await db.lane.update({where: {id: lane1}, data: {archivedAt: null}});
      await db.board.update({where: {id: board}, data: {archivedAt: new Date()}});
      expect((await runStaleCards(db)).sent).toBe(0);
      await db.board.update({where: {id: board}, data: {archivedAt: null}});
      await db.workspace.update({where: {id: ws}, data: {archivedAt: new Date()}});
      expect((await runStaleCards(db)).sent).toBe(0);
      expect(await db.notification.count()).toBe(0);
    });

    it('skips a member removed from the workspace and one without a seat on a private board; a seated one is told', async () => {
      await turnOn(7);
      await enteredAgo(10, now());
      await db.board.update({where: {id: board}, data: {visibility: 'private'}});
      expect((await runStaleCards(db)).sent).toBe(0); // Cat has no seat
      await db.boardMember.create({data: {boardId: board, userId: catId, workspaceId: ws, role: 'member'}});
      expect((await runStaleCards(db)).sent).toBe(1);
      await db.notification.deleteMany();
      await db.staleReminder.deleteMany();
      await db.workspaceMember.delete({where: {workspaceId_userId: {workspaceId: ws, userId: catId}}});
      expect((await runStaleCards(db)).sent).toBe(0);
    });

    it("never notifies another workspace's user, even if they follow the card", async () => {
      await turnOn(7);
      await enteredAgo(10, now());
      await db.cardWatcher.create({data: {cardId: card, userId: bobId}});
      await runStaleCards(db);
      expect(await bells(bobId)).toEqual([]);
    });

    it('a card that gains a follower later still reminds that person once', async () => {
      await turnOn(7);
      await enteredAgo(10, now());
      expect((await runStaleCards(db)).sent).toBe(1);
      await db.cardWatcher.create({data: {cardId: card, userId: annId}});
      expect((await runStaleCards(db)).sent).toBe(1);
      expect((await runStaleCards(db)).sent).toBe(0);
    });

    it('reminded cards do not use the per-run card budget: all of them are reminded across runs', async () => {
      await turnOn(7);
      const ids = [card];
      for (let i = 0; i < 9; i++) {
        const made = (await ann.post(`/site-api/lanes/${lane1}/cards`, {title: `Extra ${i}`})).json.items[0].id as number;
        await db.cardMember.create({data: {cardId: made, userId: catId, workspaceId: ws}});
        ids.push(made);
      }
      await db.card.updateMany({where: {id: {in: ids}}, data: {laneEnteredAt: new Date(Date.now() - 10 * DAY)}});
      // Ann follows the 9 cards she made, Cat is assigned to all 10: every card has someone to tell.
      for (let run = 0; run < 6; run++) await runStaleCards(db, now(), 4);
      const told = await db.notification.findMany({where: {kind: 'card_stale', userId: catId}, select: {cardId: true}});
      expect(told.map(n => n.cardId).sort()).toEqual([...ids].sort());
      expect((await runStaleCards(db, now(), 4)).sent).toBe(0);
    });
  });

  describe('the board setting route', () => {
    it('a board admin turns it on, reads it and turns it off', async () => {
      expect((await ann.get(`/site-api/boards/${board}/stale-days`)).json).toEqual({staleDays: null});
      const on = await put(ann, board, {staleDays: 14});
      expect(on.status).toBe(200);
      expect(on.json).toEqual({staleDays: 14});
      expect((await ann.get(`/site-api/boards/${board}/stale-days`)).json).toEqual({staleDays: 14});
      expect((await db.board.findUniqueOrThrow({where: {id: board}, select: {staleDays: true}})).staleDays).toBe(14);
      expect((await put(ann, board, {staleDays: null})).json).toEqual({staleDays: null});
      expect((await db.board.findUniqueOrThrow({where: {id: board}, select: {staleDays: true}})).staleDays).toBeNull();
    });

    it('refuses values that are not 3, 7, 14, 30 or null', async () => {
      for (const bad of [0, 1, 5, 31, '7', 7.5, true, undefined]) {
        const res = await put(ann, board, {staleDays: bad});
        expect(res.status).toBe(422);
      }
      expect((await db.board.findUniqueOrThrow({where: {id: board}, select: {staleDays: true}})).staleDays).toBeNull();
    });

    it('a member who is not a board admin and a viewer are refused (403), changing nothing', async () => {
      for (const who of [cat, vic]) {
        expect((await put(who, board, {staleDays: 7})).status).toBe(403);
        expect((await who.get(`/site-api/boards/${board}/stale-days`)).status).toBe(403);
      }
      expect((await db.board.findUniqueOrThrow({where: {id: board}, select: {staleDays: true}})).staleDays).toBeNull();
    });

    it("another workspace's user gets 404 and signed-out gets 401", async () => {
      expect((await put(bob, board, {staleDays: 7})).status).toBe(404);
      expect((await bob.get(`/site-api/boards/${board}/stale-days`)).status).toBe(404);
      const anon = new Browser(app, '203.0.113.79');
      expect((await anon.request('PUT', `/site-api/boards/${board}/stale-days`, {staleDays: 7})).status).toBe(401);
      expect((await db.board.findUniqueOrThrow({where: {id: board}, select: {staleDays: true}})).staleDays).toBeNull();
    });

    it('an archived board is a 409; a personal Inbox board is a 404', async () => {
      const inbox = await db.board.findFirst({where: {workspaceId: ws, inboxOf: annId}, select: {id: true}});
      if (inbox) expect((await put(ann, inbox.id, {staleDays: 7})).status).toBe(404);
      await db.board.update({where: {id: board}, data: {archivedAt: new Date()}});
      expect((await put(ann, board, {staleDays: 7})).status).toBe(409);
    });
  });
});
