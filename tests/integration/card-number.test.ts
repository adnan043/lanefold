import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {runRecurringCards} from '../../src/server/jobs/recurring-cards';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const importCard = (ext: string) => ({ext, lane: 'l1', title: `Card ${ext}`, desc: '', due: null, done: false, labels: [], checklists: [], comments: [], links: []});

/** The short card number (#42) per board: allocation in every insert path, never reused, search, isolation (real Postgres). */
describe.skipIf(!DATABASE_URL)('card numbers (integration, real Postgres)', () => {
  let ann: Browser;
  let ben: Browser; // member of A, no seat on the private board
  let bob: Browser; // another workspace
  let ws: number;
  let boardA: number;
  let boardB: number;
  let priv: number;
  let laneA: number;
  let laneB: number;
  let lanePriv: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    ben = await signedIn(app, 'ben@example.test', undefined, '203.0.113.72');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.73');
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    const bobWs = (await bob.post('/site-api/workspaces', {name: 'Beta'})).json.workspace.id as number;
    const benId = (await db.user.findUniqueOrThrow({where: {email: 'ben@example.test'}, select: {id: true}})).id;
    await db.workspaceMember.create({data: {workspaceId: ws, userId: benId, role: 'member'}});
    boardA = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
    boardB = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Release', lanes: ['Backlog']})).json.board.id;
    priv = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Secret', lanes: ['Hidden'], visibility: 'private'})).json.board.id;
    laneA = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes[0].id;
    laneB = (await ann.get(`/site-api/boards/${boardB}`)).json.lanes[0].id;
    lanePriv = (await ann.get(`/site-api/boards/${priv}`)).json.lanes[0].id;
    void bobWs;
  });

  const add = async (lane: number, ...titles: string[]) => (await ann.post(`/site-api/lanes/${lane}/cards`, {titles})).json.items as J[];
  const numberOf = async (id: number) => (await db.card.findUniqueOrThrow({where: {id}, select: {number: true}})).number;
  const next = async (boardId: number) => (await db.board.findUniqueOrThrow({where: {id: boardId}, select: {nextCardNumber: true}})).nextCardNumber;

  it('numbers cards 1, 2, 3 on a board, each board on its own, and the board read carries them', async () => {
    const [a1, a2] = await add(laneA, 'One', 'Two');
    const [b1] = await add(laneB, 'Other board');
    const [a3] = await add(laneA, 'Three');
    expect([a1!.number, a2!.number, a3!.number]).toEqual([1, 2, 3]);
    expect(b1!.number).toBe(1);
    const read = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes[0].cards as J[];
    expect(read.map(c => c.number).sort()).toEqual([1, 2, 3]);
    expect((await ann.get(`/site-api/cards/${a2!.id}/detail`)).json.card.number).toBe(2);
    expect(await next(boardA)).toBe(4);
  });

  it('never reuses a number: an archived card keeps its own', async () => {
    const [one] = await add(laneA, 'One');
    expect((await ann.post(`/site-api/cards/${one!.id}/archive`, {})).status).toBeLessThan(300);
    const [two] = await add(laneA, 'Two');
    expect(two!.number).toBe(2);
    expect(await numberOf(one!.id)).toBe(1);
  });

  it('parallel creations never share a number (row lock + unique index)', async () => {
    const results = await Promise.all(Array.from({length: 12}, (_, i) => ann.post(`/site-api/lanes/${laneA}/cards`, {titles: [`P${i}`]})));
    expect(results.every(r => r.status === 201)).toBe(true);
    const numbers = (await db.card.findMany({where: {boardId: boardA}, select: {number: true}})).map(c => c.number!).sort((a, b) => a - b);
    expect(numbers).toEqual(Array.from({length: 12}, (_, i) => i + 1));
    expect(await next(boardA)).toBe(13);
  });

  it('copy, lane copy, copy-to-board and move-to-board allocate; a move takes a NEW number on the target and keeps the id', async () => {
    const [x, y] = await add(laneA, 'X', 'Y'); // A: 1, 2
    const [z] = await add(laneB, 'Z'); // B: 1
    const copy = (await ann.post(`/site-api/cards/${x!.id}/copy`, {})).json.cardId as number;
    expect(await numberOf(copy)).toBe(3);
    const lane = await ann.post(`/site-api/lanes/${laneA}/copy`, {name: 'To do (copy)'});
    expect(lane.status).toBeLessThan(300);
    const copied = await db.card.findMany({where: {boardId: boardA, id: {notIn: [x!.id, y!.id, copy]}}, select: {number: true}});
    expect(copied.map(c => c.number!).sort((a, b) => a - b)).toEqual([4, 5, 6]);
    const toB = await ann.post(`/site-api/cards/${y!.id}/copy-to-board`, {boardId: boardB, laneId: laneB});
    expect(toB.status).toBe(201);
    expect(toB.json.number).toBe(2);
    const moved = await ann.post(`/site-api/cards/${x!.id}/move-to-board`, {boardId: boardB, laneId: laneB});
    expect(moved.status).toBe(200);
    expect(moved.json.number).toBe(3);
    expect(await numberOf(x!.id)).toBe(3); // same id, new number on B
    expect(await next(boardA)).toBe(7); // the old number is not handed out again
    expect((await add(laneA, 'Later'))[0]!.number).toBe(7);
    expect(z!.number).toBe(1);
  });

  it('inbox capture is numbered on the inbox and triage gives the card a new number on its board', async () => {
    await add(laneA, 'A1', 'A2');
    const made = await ann.post(`/site-api/workspaces/${ws}/inbox/cards`, {title: 'Captured'});
    const id = made.json.card.id as number;
    const triage = await ann.post(`/site-api/inbox/cards/${id}/triage`, {laneId: laneA});
    expect(triage.status).toBe(200);
    expect(await numberOf(id)).toBe(3);
    expect(await next(boardA)).toBe(4);
  });

  it('the recurring job and a Trello import chunk allocate from the same counter', async () => {
    const [card] = await add(laneA, 'Weekly');
    await ann.request('PUT', `/site-api/cards/${card!.id}/recurrence`, {frequency: 'daily', interval: 1, startOn: plusDays(0), endsOn: null});
    await db.cardRecurrence.update({where: {cardId: card!.id}, data: {nextRunOn: new Date(`${plusDays(-1)}T00:00:00.000Z`)}});
    expect(await runRecurringCards(db)).toMatchObject({created: 1});
    const made = await db.card.findFirstOrThrow({where: {boardId: boardA, importId: 'recurring'}, select: {number: true}});
    expect(made.number).toBe(2);

    const importId = 'number-import-0001';
    const started = await ann.post(`/site-api/workspaces/${ws}/import/trello/start`, {importId, name: 'Imported', lanes: [{ext: 'l1', name: 'Todo'}], labels: [], totalCards: 3});
    const imported = (started.json.board as J).id as number;
    const chunk = await ann.post(`/site-api/boards/${imported}/import/trello/cards`, {importId, cards: [importCard('c1'), importCard('c2'), importCard('c3')]});
    expect(chunk.status).toBe(200);
    const numbers = (await db.card.findMany({where: {boardId: imported}, select: {number: true}})).map(c => c.number!).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3]);
    const json = await ann.get(`/site-api/boards/${imported}/export.json`);
    expect(json.status).toBe(200);
    const csv = await ann.get(`/site-api/boards/${imported}/export.csv`);
    expect(csv.status).toBe(200);
    expect(String(csv.json.text)).toContain('card_number');
  });

  it('search finds #N and N per board, inside the workspace and the person\'s seats only', async () => {
    await add(laneA, 'Alpha one', 'Alpha two'); // A: 1, 2
    await add(laneB, 'Beta one'); // B: 1
    await add(lanePriv, 'Hidden one'); // private: 1
    const hits = async (who: Browser, wsId: number, q: string) => ((await who.get(`/site-api/workspaces/${wsId}/search?q=${encodeURIComponent(q)}`)).json.cards ?? []) as J[];
    const withOne = await hits(ann, ws, '#1');
    expect(withOne.filter(h => h.number === 1).map(h => h.title).sort()).toEqual(['Alpha one', 'Beta one', 'Hidden one']);
    const bare = await hits(ann, ws, '2');
    expect(bare.map(h => h.title)).toContain('Alpha two');
    // Ben is a member without a seat on the private board.
    expect((await hits(ben, ws, '#1')).map(h => h.title)).not.toContain('Hidden one');
    expect((await hits(ben, ws, '#1')).map(h => h.title)).toContain('Alpha one');
    // Another workspace's person gets a 404, never a card.
    expect((await bob.get(`/site-api/workspaces/${ws}/search?q=%231`)).status).toBe(404);
    // Text still works and is not mistaken for a number.
    expect((await hits(ann, ws, 'Alpha')).map(h => h.title).sort()).toEqual(['Alpha one', 'Alpha two']);
  });

  it('the migration backfill numbers existing cards in id order, per board, and is safe to repeat', async () => {
    const [a, b, c] = await add(laneA, 'A', 'B', 'C');
    const [d] = await add(laneB, 'D');
    await db.$executeRaw`UPDATE cards SET number = NULL WHERE board_id IN (${boardA}, ${boardB})`;
    await db.$executeRaw`UPDATE boards SET next_card_number = 1 WHERE id IN (${boardA}, ${boardB})`;
    const backfill = async () => {
      await db.$executeRaw`
        UPDATE cards c SET number = t.rn
        FROM (SELECT id, row_number() OVER (PARTITION BY board_id ORDER BY id) AS rn FROM cards) t
        WHERE c.id = t.id AND c.number IS NULL`;
      await db.$executeRaw`
        UPDATE boards b SET next_card_number = m.mx + 1
        FROM (SELECT board_id, MAX(number) AS mx FROM cards GROUP BY board_id) m
        WHERE b.id = m.board_id AND b.next_card_number <= m.mx`;
    };
    await backfill();
    await backfill();
    expect([await numberOf(a!.id), await numberOf(b!.id), await numberOf(c!.id), await numberOf(d!.id)]).toEqual([1, 2, 3, 1]);
    expect(await next(boardA)).toBe(4);
    expect((await add(laneA, 'E'))[0]!.number).toBe(4);
  });
});
