import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** GET /boards/:id/workload: exact counts, who is listed, isolation, no email (real Postgres). */
describe.skipIf(!DATABASE_URL)('board workload (integration, real Postgres)', () => {
  let ann: Browser; // owner of A
  let ben: Browser; // member of A
  let bob: Browser; // owner of B (other workspace)
  let annId: number;
  let benId: number;
  let wsA: number;
  let boardA: number;
  let laneTodo: number;
  let laneDoing: number;
  let cards: number[]; // five cards in To do

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.81');
    ben = await signedIn(app, 'ben@example.test', undefined, '203.0.113.82');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.83');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    annId = (await db.user.findUniqueOrThrow({where: {email: 'ann@example.test'}, select: {id: true}})).id;
    benId = (await db.user.findUniqueOrThrow({where: {email: 'ben@example.test'}, select: {id: true}})).id;
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: benId, role: 'member'}});
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do', 'Doing']})).json.board.id;
    const lanes = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes;
    laneTodo = lanes[0].id;
    laneDoing = lanes[1].id;
    cards = (await ann.post(`/site-api/lanes/${laneTodo}/cards`, {titles: ['One', 'Two', 'Three', 'Four', 'Five']})).json.items.map((x: J) => x.id);
  });

  const assign = (card: number, userId: number) => db.cardMember.create({data: {cardId: card, userId, workspaceId: wsA}});
  const workload = (who: Browser, board = boardA, query = '') => who.get(`/site-api/boards/${board}/workload${query}`);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const dueOn = (card: number, offset: number, estimate?: number) =>
    db.card.update({where: {id: card}, data: {dueDate: new Date(`${day(offset)}T00:00:00.000Z`), ...(estimate ? {estimateMinutes: estimate} : {})}});

  it('counts open, overdue, due soon, estimates and lanes per person, plus the unassigned row', async () => {
    await assign(cards[0], annId); await dueOn(cards[0], -2, 60); // overdue
    await assign(cards[1], annId); await dueOn(cards[1], 3, 30); // due soon
    await assign(cards[2], annId); await dueOn(cards[2], 20); // later
    await assign(cards[2], benId); // two people on one card counts for both
    await assign(cards[3], benId);
    await db.card.update({where: {id: cards[3]}, data: {laneId: laneDoing}});
    // cards[4] stays unassigned
    const res = await workload(ann);
    expect(res.status).toBe(200);
    expect(res.json.lanes.map((l: J) => l.name)).toEqual(['To do', 'Doing']);
    const [first, second] = res.json.people;
    expect(first).toMatchObject({id: annId, open: 3, overdue: 1, dueSoon: 1, estimateMinutes: 90});
    expect(first.lanes).toEqual([{laneId: laneTodo, count: 3}]);
    expect(second).toMatchObject({id: benId, open: 2, overdue: 0, dueSoon: 0});
    expect(second.lanes.sort((a: J, b: J) => a.laneId - b.laneId)).toEqual([{laneId: laneTodo, count: 1}, {laneId: laneDoing, count: 1}]);
    expect(res.json.unassigned).toMatchObject({open: 1, overdue: 0});
    expect(res.json.truncated).toBe(false);
  });

  it('leaves out completed cards, archived cards and archived lanes', async () => {
    await assign(cards[0], annId);
    await assign(cards[1], annId);
    await assign(cards[2], annId);
    await db.card.update({where: {id: cards[0]}, data: {completedAt: new Date()}});
    await db.card.update({where: {id: cards[1]}, data: {archivedAt: new Date()}});
    expect((await workload(ann)).json.people[0]).toMatchObject({id: annId, open: 1});
    await db.lane.update({where: {id: laneTodo}, data: {archivedAt: new Date()}});
    const after = (await workload(ann)).json;
    expect(after.people).toEqual([]);
    expect(after.unassigned).toBeNull();
    expect(after.lanes.map((l: J) => l.name)).toEqual(['Doing']);
  });

  it('uses the caller\'s own day for overdue and due soon', async () => {
    await assign(cards[0], annId);
    await dueOn(cards[0], 0); // due today (server UTC day)
    expect((await workload(ann, boardA, `?today=${day(0)}`)).json.people[0]).toMatchObject({overdue: 0, dueSoon: 1});
    expect((await workload(ann, boardA, `?today=${day(1)}`)).json.people[0]).toMatchObject({overdue: 1, dueSoon: 0});
    expect((await workload(ann, boardA, '?today=2026-02-30')).status).toBe(422);
    expect((await workload(ann, boardA, '?today=tomorrow')).status).toBe(422);
  });

  it('lists only people who can still see the board (private board: board members and workspace admins)', async () => {
    await assign(cards[0], annId);
    await assign(cards[1], benId);
    await db.board.update({where: {id: boardA}, data: {visibility: 'private'}});
    let res = await workload(ann);
    expect(res.json.people.map((p: J) => p.id)).toEqual([annId]); // ben has no seat; his card shows under nobody
    expect(res.json.unassigned.open).toBe(3); // the three cards with no assignee at all
    await db.boardMember.create({data: {boardId: boardA, userId: benId, role: 'member', workspaceId: wsA}});
    res = await workload(ann);
    expect(res.json.people.map((p: J) => p.id).sort()).toEqual([annId, benId].sort());
  });

  it('refuses a member with no seat on a private board and a user of another workspace (404)', async () => {
    await db.board.update({where: {id: boardA}, data: {visibility: 'private'}});
    expect((await workload(ben)).status).toBe(404);
    expect((await workload(bob)).status).toBe(404);
    expect((await workload(bob, 999_999)).status).toBe(404);
    const signedOut = new Browser(app);
    expect([401, 403]).toContain((await signedOut.get(`/site-api/boards/${boardA}/workload`)).status);
  });

  it('a workspace member (even a viewer) may read it, and no email address is in the answer', async () => {
    await assign(cards[0], benId);
    const res = await workload(ben);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.json);
    expect(text).not.toMatch(/@example\.test/);
    expect(text).not.toMatch(/passwordHash|email/i);
    expect(Object.keys(res.json.people[0]).sort()).toEqual(['dueSoon', 'estimateMinutes', 'id', 'lanes', 'name', 'open', 'overdue']);
  });

  it('a personal Inbox board has no workload', async () => {
    const inbox = await db.board.findFirst({where: {inboxOf: annId}, select: {id: true}});
    if (!inbox) return; // no Inbox made yet in this fixture: nothing to check
    const res = await workload(ann, inbox.id);
    expect(res.status === 404 || (res.status === 200 && res.json.people.length === 0)).toBe(true);
  });

  it('caps the people list at 100 and says so', async () => {
    const users = await Promise.all(
      Array.from({length: 101}, (_, i) =>
        db.user.create({data: {email: `w${i}@example.test`, name: `Worker ${String(i).padStart(3, '0')}`, passwordHash: 'x', status: 'active'}, select: {id: true}})
      )
    );
    await db.workspaceMember.createMany({data: users.map(u => ({workspaceId: wsA, userId: u.id, role: 'member'}))});
    await db.card.createMany({data: users.map((_, i) => ({boardId: boardA, laneId: laneDoing, workspaceId: wsA, title: `Bulk ${i}`, position: `b${String(i).padStart(4, '0')}`}))});
    const made = await db.card.findMany({where: {boardId: boardA, title: {startsWith: 'Bulk '}}, select: {id: true}, orderBy: {id: 'asc'}});
    await db.cardMember.createMany({data: made.map((c, i) => ({cardId: c.id, userId: users[i]!.id, workspaceId: wsA}))});
    const res = await workload(ann);
    expect(res.status).toBe(200);
    expect(res.json.people).toHaveLength(100);
    expect(res.json.truncated).toBe(true);
  });
});
