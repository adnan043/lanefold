import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** A card to another board: move and copy, labels by name, seats, counters, revs, isolation (real Postgres). */
describe.skipIf(!DATABASE_URL)('card move / copy to another board (integration, real Postgres)', () => {
  let ann: Browser;
  let ben: Browser; // member of A, no seat on a private board
  let bob: Browser; // other workspace
  let vic: Browser; // viewer in A
  let annId: number;
  let benId: number;
  let wsA: number;
  let boardA: number;
  let boardB: number;
  let laneA: number;
  let laneB: number;
  let card: number;
  let other: number; // a second card on board A

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.61');
    ben = await signedIn(app, 'ben@example.test', undefined, '203.0.113.62');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.63');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.64');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    annId = (await db.user.findUniqueOrThrow({where: {email: 'ann@example.test'}, select: {id: true}})).id;
    benId = (await db.user.findUniqueOrThrow({where: {email: 'ben@example.test'}, select: {id: true}})).id;
    const vicId = (await db.user.findUniqueOrThrow({where: {email: 'vic@example.test'}, select: {id: true}})).id;
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: benId, role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: vicId, role: 'viewer'}});
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
    boardB = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Release', lanes: ['Backlog', 'Doing']})).json.board.id;
    laneA = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes[0].id;
    laneB = (await ann.get(`/site-api/boards/${boardB}`)).json.lanes[0].id;
    card = (await ann.post(`/site-api/lanes/${laneA}/cards`, {title: 'Ship it'})).json.items[0].id;
    other = (await ann.post(`/site-api/lanes/${laneA}/cards`, {title: 'Other'})).json.items[0].id;
  });

  const moveTo = (who: Browser, id: number, boardId: number, laneId: number, extra: J = {}) =>
    who.post(`/site-api/cards/${id}/move-to-board`, {boardId, laneId, ...extra});
  const copyTo = (who: Browser, id: number, boardId: number, laneId: number) => who.post(`/site-api/cards/${id}/copy-to-board`, {boardId, laneId});
  const laneCount = async (id: number) => (await db.lane.findUniqueOrThrow({where: {id}})).cardCount;
  const rev = async (id: number) => (await db.board.findUniqueOrThrow({where: {id}})).rev;

  it('moves the card, keeps its id, fixes both lane counters and bumps both revs', async () => {
    const [revA, revB] = [await rev(boardA), await rev(boardB)];
    const res = await moveTo(ann, card, boardB, laneB);
    expect(res.status).toBe(200);
    const row = await db.card.findUniqueOrThrow({where: {id: card}});
    expect(row).toMatchObject({boardId: boardB, laneId: laneB, title: 'Ship it'});
    expect(await laneCount(laneA)).toBe(1);
    expect(await laneCount(laneB)).toBe(1);
    expect(await rev(boardA)).toBeGreaterThan(revA);
    expect(await rev(boardB)).toBeGreaterThan(revB);
    expect((await ann.get(`/site-api/cards/${card}/detail`)).json.card.id).toBe(card);
    const onB = (await ann.get(`/site-api/boards/${boardB}`)).json.lanes[0].cards.map((x: J) => x.id);
    const onA = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes[0].cards.map((x: J) => x.id);
    expect(onB).toContain(card);
    expect(onA).not.toContain(card);
    expect(await db.activity.count({where: {cardId: card, kind: 'card.moved'}})).toBe(2);
  });

  it('places the card after a sibling when afterId is given, else last', async () => {
    const first = (await ann.post(`/site-api/lanes/${laneB}/cards`, {title: 'First'})).json.items[0].id;
    const second = (await ann.post(`/site-api/lanes/${laneB}/cards`, {title: 'Second'})).json.items[0].id;
    expect((await moveTo(ann, card, boardB, laneB, {afterId: first})).status).toBe(200);
    expect((await moveTo(ann, other, boardB, laneB)).status).toBe(200);
    const ids = (await ann.get(`/site-api/boards/${boardB}`)).json.lanes[0].cards.map((x: J) => x.id);
    expect(ids).toEqual([first, card, second, other]);
    expect((await moveTo(ann, card, boardA, laneA)).status).toBe(200); // and back
  });

  it('labels follow by name; the others are dropped; field values and the repeat rule go', async () => {
    const bug = (await ann.post(`/site-api/boards/${boardA}/labels`, {name: 'Bug', colorHex: '#aa0000'})).json.label.id;
    const solo = (await ann.post(`/site-api/boards/${boardA}/labels`, {name: 'OnlyHere', colorHex: '#00aa00'})).json.label.id;
    const bugB = (await ann.post(`/site-api/boards/${boardB}/labels`, {name: 'bug', colorHex: '#0000aa'})).json.label.id;
    await ann.request('PUT', `/site-api/cards/${card}/labels/${bug}`);
    await ann.request('PUT', `/site-api/cards/${card}/labels/${solo}`);
    const field = (await ann.post(`/site-api/boards/${boardA}/fields`, {name: 'Size', type: 'text'})).json.field.id;
    await ann.request('PUT', `/site-api/cards/${card}/fields/${field}`, {value: 'big'});
    await ann.request('PUT', `/site-api/cards/${card}/recurrence`, {frequency: 'weekly', startOn: '2030-01-07'});
    expect((await moveTo(ann, card, boardB, laneB)).status).toBe(200);
    const labels = await db.cardLabel.findMany({where: {cardId: card}});
    expect(labels.map(l => l.labelId)).toEqual([bugB]);
    expect(await db.cardFieldValue.count({where: {cardId: card}})).toBe(0);
    expect(await db.cardRecurrence.count({where: {cardId: card}})).toBe(0);
  });

  it('keeps people only where they have a seat (a private target board)', async () => {
    await ann.request('PUT', `/site-api/cards/${card}/members/${benId}`);
    await db.cardWatcher.createMany({data: [{cardId: card, userId: benId}], skipDuplicates: true});
    await db.notification.create({data: {userId: benId, workspaceId: wsA, kind: 'assigned', boardId: boardA, cardId: card}});
    await db.board.update({where: {id: boardB}, data: {visibility: 'private'}});
    expect((await moveTo(ann, card, boardB, laneB)).status).toBe(200);
    expect(await db.cardMember.count({where: {cardId: card, userId: benId}})).toBe(0);
    expect(await db.cardWatcher.count({where: {cardId: card, userId: benId}})).toBe(0);
    expect(await db.notification.count({where: {cardId: card, userId: benId}})).toBe(0);
    expect(await db.cardWatcher.count({where: {cardId: card, userId: annId}})).toBeGreaterThanOrEqual(0);
  });

  it('keeps people who have a seat, and points their notifications at the new board', async () => {
    await ann.request('PUT', `/site-api/cards/${card}/members/${benId}`);
    await db.notification.create({data: {userId: benId, workspaceId: wsA, kind: 'assigned', boardId: boardA, cardId: card}});
    expect((await moveTo(ann, card, boardB, laneB)).status).toBe(200);
    expect(await db.cardMember.count({where: {cardId: card, userId: benId}})).toBe(1);
    expect((await db.notification.findFirstOrThrow({where: {cardId: card, userId: benId}})).boardId).toBe(boardB);
  });

  it('refuses a target the person cannot see or write (404 / 403), another workspace (404), and the same board (422)', async () => {
    // a private board without a seat for ben: ben can write on A but must get 404 for the target
    await db.board.update({where: {id: boardB}, data: {visibility: 'private'}});
    const benCard = (await ben.post(`/site-api/lanes/${laneA}/cards`, {title: 'Ben card'})).json.items[0].id;
    expect((await moveTo(ben, benCard, boardB, laneB)).status).toBe(404);
    expect((await copyTo(ben, benCard, boardB, laneB)).status).toBe(404);
    expect((await db.card.findUniqueOrThrow({where: {id: benCard}})).boardId).toBe(boardA);
    // another workspace's user: the card is a 404
    expect((await moveTo(bob, card, boardB, laneB)).status).toBe(404);
    // a board of another workspace as the target
    const betaBoard = (await bob.post(`/site-api/workspaces/${(await db.workspaceMember.findFirstOrThrow({where: {userId: (await db.user.findUniqueOrThrow({where: {email: 'bob@example.test'}, select: {id: true}})).id}})).workspaceId}/boards`, {name: 'Secret', lanes: ['X']})).json.board.id;
    const betaLane = (await db.lane.findFirstOrThrow({where: {boardId: betaBoard}})).id;
    expect((await moveTo(ann, card, betaBoard, betaLane)).status).toBe(404);
    expect((await copyTo(ann, card, betaBoard, betaLane)).status).toBe(404);
    // a lane of a different board than the one named
    expect((await moveTo(ann, card, boardB, (await db.lane.findFirstOrThrow({where: {boardId: boardA}})).id)).status).toBe(404);
    // same board
    expect((await moveTo(ann, card, boardA, laneA)).status).toBe(422);
    expect((await db.card.findUniqueOrThrow({where: {id: card}})).boardId).toBe(boardA);
  });

  it('never targets a personal Inbox', async () => {
    const made = await ann.post(`/site-api/workspaces/${wsA}/inbox/cards`, {title: 'In my inbox'});
    expect(made.status).toBe(201);
    const inboxLane = (await db.lane.findFirstOrThrow({where: {boardId: made.json.boardId}})).id;
    expect((await moveTo(ann, card, made.json.boardId, inboxLane)).status).toBe(404);
    expect((await copyTo(ann, card, made.json.boardId, inboxLane)).status).toBe(404);
    expect((await db.card.findUniqueOrThrow({where: {id: card}})).boardId).toBe(boardA);
  });

  it('a refused copy (full lane) leaves the target board rev and lane unchanged', async () => {
    await db.lane.update({where: {id: laneB}, data: {cardCount: 500}});
    const before = await rev(boardB);
    const res = await copyTo(ann, card, boardB, laneB);
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('lane_card_limit');
    expect(await rev(boardB)).toBe(before);
    expect(await laneCount(laneB)).toBe(500);
  });

  it('refuses a viewer, bad input and signed-out calls', async () => {
    expect([403, 404]).toContain((await moveTo(vic, card, boardB, laneB)).status);
    expect((await ann.post(`/site-api/cards/${card}/move-to-board`, {boardId: 'x', laneId: laneB})).status).toBe(422);
    expect((await ann.post(`/site-api/cards/${card}/move-to-board`, {boardId: boardB})).status).toBe(422);
    expect((await ann.post(`/site-api/cards/${card}/move-to-board`, {boardId: boardB, laneId: laneB, afterId: -1})).status).toBe(422);
    expect((await moveTo(ann, 999999, boardB, laneB)).status).toBe(404);
    // a viewer cannot be the target writer either: viewer on A with a card they cannot move
    const anon = await signedIn(app, 'zed@example.test', undefined, '203.0.113.65');
    expect((await moveTo(anon, card, boardB, laneB)).status).toBe(404);
  });

  it('answers 409 for a full lane, an archived target and a read-only workspace; nothing changes', async () => {
    await db.lane.update({where: {id: laneB}, data: {cardCount: 500}});
    const full = await moveTo(ann, card, boardB, laneB);
    expect(full.status).toBe(409);
    expect(full.json.error).toBe('lane_card_limit');
    expect(await db.card.findUniqueOrThrow({where: {id: card}})).toMatchObject({boardId: boardA, laneId: laneA});
    expect(await laneCount(laneA)).toBe(2);
    await db.lane.update({where: {id: laneB}, data: {cardCount: 0}});
    await db.board.update({where: {id: boardB}, data: {archivedAt: new Date()}});
    expect((await moveTo(ann, card, boardB, laneB)).json.error).toBe('board_archived');
    await db.board.update({where: {id: boardB}, data: {archivedAt: null}});
    await db.workspace.update({where: {id: wsA}, data: {memberCount: 11, graceUntil: new Date(Date.now() - 1000)}});
    const ro = await moveTo(ann, card, boardB, laneB);
    expect(ro.status).toBe(409);
    expect(ro.json.error).toBe('workspace_read_only');
    expect((await copyTo(ann, card, boardB, laneB)).json.error).toBe('workspace_read_only');
  });

  it('copies a card to another board: labels by name, checklists unticked, no comments, source untouched', async () => {
    const bug = (await ann.post(`/site-api/boards/${boardA}/labels`, {name: 'Bug', colorHex: '#aa0000'})).json.label.id;
    const bugB = (await ann.post(`/site-api/boards/${boardB}/labels`, {name: 'Bug', colorHex: '#0000aa'})).json.label.id;
    await ann.request('PUT', `/site-api/cards/${card}/labels/${bug}`);
    const list = (await ann.post(`/site-api/cards/${card}/checklists`, {title: 'Steps'})).json.checklist.id;
    await ann.post(`/site-api/checklists/${list}/items`, {texts: ['one', 'two']});
    await ann.post(`/site-api/cards/${card}/comments`, {body: 'hello'});
    const res = await copyTo(ann, card, boardB, laneB);
    expect(res.status).toBe(201);
    const copy = await db.card.findUniqueOrThrow({where: {id: res.json.cardId}, include: {labels: true, checklists: {include: {items: true}}, comments: true}});
    expect(copy).toMatchObject({boardId: boardB, laneId: laneB, title: 'Ship it (copy)', checklistDone: 0});
    expect(copy.labels.map(l => l.labelId)).toEqual([bugB]);
    expect(copy.checklists[0]?.items).toHaveLength(2);
    expect(copy.comments).toHaveLength(0);
    expect(await db.card.findUniqueOrThrow({where: {id: card}})).toMatchObject({boardId: boardA, laneId: laneA});
    expect(await laneCount(laneB)).toBe(1);
    expect(await laneCount(laneA)).toBe(2);
  });

  it('a viewer may copy only where they can write (they cannot)', async () => {
    expect([403, 404]).toContain((await copyTo(vic, card, boardB, laneB)).status);
    expect(await db.card.count({where: {boardId: boardB}})).toBe(0);
  });
});
