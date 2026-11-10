import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Bulk actions on a board's cards: all or nothing, one rev, isolation, caps (real Postgres). */
describe.skipIf(!DATABASE_URL)('bulk card actions (integration, real Postgres)', () => {
  let ann: Browser;
  let ben: Browser; // member of A, no seat on a private board
  let bob: Browser; // other workspace
  let vic: Browser; // viewer in A
  let annId: number;
  let benId: number;
  let wsA: number;
  let boardA: number;
  let boardB: number;
  let laneA1: number;
  let laneA2: number;
  let laneB: number;
  let cards: number[]; // three cards in lane A1
  let foreign: number; // a card of board B (same workspace)

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    ben = await signedIn(app, 'ben@example.test', undefined, '203.0.113.72');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.73');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.74');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    annId = (await db.user.findUniqueOrThrow({where: {email: 'ann@example.test'}, select: {id: true}})).id;
    benId = (await db.user.findUniqueOrThrow({where: {email: 'ben@example.test'}, select: {id: true}})).id;
    const vicId = (await db.user.findUniqueOrThrow({where: {email: 'vic@example.test'}, select: {id: true}})).id;
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: benId, role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: vicId, role: 'viewer'}});
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do', 'Doing']})).json.board.id;
    boardB = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Release', lanes: ['Backlog']})).json.board.id;
    const lanesA = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes;
    laneA1 = lanesA[0].id;
    laneA2 = lanesA[1].id;
    laneB = (await ann.get(`/site-api/boards/${boardB}`)).json.lanes[0].id;
    cards = (await ann.post(`/site-api/lanes/${laneA1}/cards`, {titles: ['One', 'Two', 'Three']})).json.items.map((x: J) => x.id);
    foreign = (await ann.post(`/site-api/lanes/${laneB}/cards`, {title: 'Elsewhere'})).json.items[0].id;
  });

  const bulk = (who: Browser, board: number, body: J) => who.post(`/site-api/boards/${board}/cards/bulk`, body);
  const rev = async (id: number) => (await db.board.findUniqueOrThrow({where: {id}})).rev;
  const laneCount = async (id: number) => (await db.lane.findUniqueOrThrow({where: {id}})).cardCount;
  const row = (id: number) => db.card.findUniqueOrThrow({where: {id}});

  it('moves the cards to the end of another lane in their order, fixes both counters, bumps the rev once', async () => {
    const before = await rev(boardA);
    const res = await bulk(ann, boardA, {cardIds: [cards[2], cards[0]], action: 'move', laneId: laneA2});
    expect(res.status).toBe(200);
    expect(res.json.changed).toBe(2);
    expect(await rev(boardA)).toBe(before + 1n);
    expect(String(res.json.rev)).toBe(String(before + 1n));
    const lanes = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes;
    expect(lanes.find((l: J) => l.id === laneA2).cards.map((x: J) => x.id)).toEqual([cards[0], cards[2]]); // board order, not the request order
    expect(lanes.find((l: J) => l.id === laneA1).cards.map((x: J) => x.id)).toEqual([cards[1]]);
    expect(await laneCount(laneA1)).toBe(1);
    expect(await laneCount(laneA2)).toBe(2);
    expect((await row(cards[0])).updatedRev).toBe(before + 1n);
    expect(await db.activity.count({where: {boardId: boardA, kind: 'cards.bulk'}})).toBe(1);
  });

  it('cards from several lanes keep the board order (lane by lane) in the target lane', async () => {
    const third = (await ann.post(`/site-api/boards/${boardA}/lanes`, {name: 'Done'})).json.lane.id;
    const x = (await ann.post(`/site-api/lanes/${laneA2}/cards`, {title: 'From Doing'})).json.items[0].id;
    const res = await bulk(ann, boardA, {cardIds: [x, cards[2], cards[0]], action: 'move', laneId: third});
    expect(res.status).toBe(200);
    const lanes = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes;
    expect(lanes.find((l: J) => l.id === third).cards.map((c: J) => c.id)).toEqual([cards[0], cards[2], x]);
    expect(await laneCount(laneA1)).toBe(1);
    expect(await laneCount(laneA2)).toBe(0);
    expect(await laneCount(third)).toBe(3);
  });

  it('a card already in the target lane stays where it is', async () => {
    const res = await bulk(ann, boardA, {cardIds: [cards[0], cards[1]], action: 'move', laneId: laneA1});
    expect(res.status).toBe(200);
    expect(res.json.changed).toBe(0);
    expect(await laneCount(laneA1)).toBe(3);
  });

  it('archives the cards and lowers the lane counter', async () => {
    const res = await bulk(ann, boardA, {cardIds: [cards[0], cards[1]], action: 'archive'});
    expect(res.status).toBe(200);
    expect((await row(cards[0])).archivedAt).not.toBeNull();
    expect((await row(cards[2])).archivedAt).toBeNull();
    expect(await laneCount(laneA1)).toBe(1);
    // an archived card is no longer a live card of the board: the same ids again are a 404
    expect((await bulk(ann, boardA, {cardIds: [cards[0]], action: 'archive'})).status).toBe(404);
  });

  it('adds and removes a label of this board', async () => {
    const bug = (await ann.post(`/site-api/boards/${boardA}/labels`, {name: 'Bug', colorHex: '#aa0000'})).json.label.id;
    expect((await bulk(ann, boardA, {cardIds: cards, action: 'label_add', labelId: bug})).status).toBe(200);
    expect(await db.cardLabel.count({where: {labelId: bug}})).toBe(3);
    expect((await bulk(ann, boardA, {cardIds: cards, action: 'label_add', labelId: bug})).status).toBe(200); // idempotent
    expect(await db.cardLabel.count({where: {labelId: bug}})).toBe(3);
    expect((await bulk(ann, boardA, {cardIds: [cards[0]], action: 'label_remove', labelId: bug})).status).toBe(200);
    expect(await db.cardLabel.count({where: {labelId: bug}})).toBe(2);
  });

  it('refuses a label of another board and changes nothing', async () => {
    const other = (await ann.post(`/site-api/boards/${boardB}/labels`, {name: 'Other', colorHex: '#00aa00'})).json.label.id;
    const before = await rev(boardA);
    expect((await bulk(ann, boardA, {cardIds: cards, action: 'label_add', labelId: other})).status).toBe(404);
    expect(await db.cardLabel.count({where: {labelId: other}})).toBe(0);
    expect(await rev(boardA)).toBe(before);
  });

  it('assigns a person with a seat (follows the cards, one notification), then unassigns', async () => {
    const res = await bulk(ann, boardA, {cardIds: cards, action: 'assign', userId: benId});
    expect(res.status).toBe(200);
    expect(res.json.changed).toBe(3);
    expect(await db.cardMember.count({where: {userId: benId, cardId: {in: cards}}})).toBe(3);
    expect(await db.cardWatcher.count({where: {userId: benId, cardId: {in: cards}}})).toBe(3);
    expect(await db.notification.count({where: {userId: benId, kind: 'assigned'}})).toBe(1);
    // again: nothing new, nobody told twice
    expect((await bulk(ann, boardA, {cardIds: cards, action: 'assign', userId: benId})).json.changed).toBe(0);
    expect(await db.notification.count({where: {userId: benId, kind: 'assigned'}})).toBe(1);
    expect((await bulk(ann, boardA, {cardIds: [cards[0], cards[1]], action: 'unassign', userId: benId})).json.changed).toBe(2);
    expect(await db.cardMember.count({where: {userId: benId, cardId: {in: cards}}})).toBe(1);
  });

  it('refuses an assignee without a seat (private board) and one from another workspace', async () => {
    await db.board.update({where: {id: boardA}, data: {visibility: 'private'}});
    const before = await rev(boardA);
    expect((await bulk(ann, boardA, {cardIds: cards, action: 'assign', userId: benId})).status).toBe(404);
    const bobId = (await db.user.findUniqueOrThrow({where: {email: 'bob@example.test'}, select: {id: true}})).id;
    expect((await bulk(ann, boardA, {cardIds: cards, action: 'assign', userId: bobId})).status).toBe(404);
    expect(await db.cardMember.count({where: {cardId: {in: cards}}})).toBe(0);
    expect(await rev(boardA)).toBe(before);
    expect(annId).toBeGreaterThan(0);
  });

  it('sets and clears the due date and sets the priority', async () => {
    expect((await bulk(ann, boardA, {cardIds: cards, action: 'set_due', dueDate: '2030-05-06'})).status).toBe(200);
    expect((await row(cards[1])).dueDate?.toISOString().slice(0, 10)).toBe('2030-05-06');
    expect((await bulk(ann, boardA, {cardIds: cards, action: 'set_due', dueDate: null})).status).toBe(200);
    expect((await row(cards[1])).dueDate).toBeNull();
    expect((await bulk(ann, boardA, {cardIds: cards, action: 'set_priority', priority: 'urgent'})).status).toBe(200);
    expect((await row(cards[2])).priority).toBe('urgent');
  });

  it('is all or nothing: one id of another board, another workspace or missing is a 404 and nothing changes', async () => {
    const before = await rev(boardA);
    const res = await bulk(ann, boardA, {cardIds: [cards[0], foreign], action: 'set_priority', priority: 'high'});
    expect(res.status).toBe(404);
    expect((await row(cards[0])).priority).toBe('none');
    expect((await row(foreign)).priority).toBe('none');
    expect(await rev(boardA)).toBe(before);
    expect((await bulk(ann, boardA, {cardIds: [cards[0], 999999], action: 'archive'})).status).toBe(404);
    expect((await row(cards[0])).archivedAt).toBeNull();
    // another workspace: the whole board is a 404, the card ids are never confirmed
    expect((await bulk(bob, boardA, {cardIds: cards, action: 'archive'})).status).toBe(404);
    expect((await row(cards[0])).archivedAt).toBeNull();
    // a target lane of another board
    expect((await bulk(ann, boardA, {cardIds: [cards[0]], action: 'move', laneId: laneB})).status).toBe(404);
    expect((await row(cards[0])).laneId).toBe(laneA1);
  });

  it('refuses a viewer (403) and a member with no seat on a private board (404)', async () => {
    expect((await bulk(vic, boardA, {cardIds: cards, action: 'archive'})).status).toBe(403);
    await db.board.update({where: {id: boardA}, data: {visibility: 'private'}});
    expect((await bulk(ben, boardA, {cardIds: cards, action: 'archive'})).status).toBe(404);
    expect((await row(cards[0])).archivedAt).toBeNull();
  });

  it('answers 409 for a full target lane, an archived board and a read-only workspace; nothing changes', async () => {
    await db.lane.update({where: {id: laneA2}, data: {cardCount: 499}});
    const before = await rev(boardA);
    const full = await bulk(ann, boardA, {cardIds: [cards[0], cards[1]], action: 'move', laneId: laneA2});
    expect(full.status).toBe(409);
    expect(full.json.error).toBe('lane_card_limit');
    expect(await laneCount(laneA1)).toBe(3);
    expect(await laneCount(laneA2)).toBe(499);
    expect((await row(cards[0])).laneId).toBe(laneA1);
    expect(await rev(boardA)).toBe(before);
    await db.lane.update({where: {id: laneA2}, data: {cardCount: 0}});
    await db.board.update({where: {id: boardA}, data: {archivedAt: new Date()}});
    expect((await bulk(ann, boardA, {cardIds: cards, action: 'archive'})).json.error).toBe('board_archived');
    await db.board.update({where: {id: boardA}, data: {archivedAt: null}});
    await db.workspace.update({where: {id: wsA}, data: {memberCount: 11, graceUntil: new Date(Date.now() - 1000)}});
    const ro = await bulk(ann, boardA, {cardIds: cards, action: 'archive'});
    expect(ro.status).toBe(409);
    expect(ro.json.error).toBe('workspace_read_only');
    expect((await row(cards[0])).archivedAt).toBeNull();
  });

  it('validates the body: 51 ids, no ids, a bad action, missing params, a bad date or priority', async () => {
    const ids = Array.from({length: 51}, (_, i) => i + 1);
    expect((await bulk(ann, boardA, {cardIds: ids, action: 'archive'})).status).toBe(422);
    expect((await bulk(ann, boardA, {cardIds: [], action: 'archive'})).status).toBe(422);
    expect((await bulk(ann, boardA, {cardIds: [cards[0]], action: 'delete'})).status).toBe(422);
    expect((await bulk(ann, boardA, {cardIds: [cards[0]], action: 'move'})).status).toBe(422);
    expect((await bulk(ann, boardA, {cardIds: [cards[0]], action: 'set_due', dueDate: '2030-13-40'})).status).toBe(422);
    expect((await bulk(ann, boardA, {cardIds: [cards[0]], action: 'set_priority', priority: 'huge'})).status).toBe(422);
    expect((await bulk(ann, boardA, {cardIds: ['1'], action: 'archive'})).status).toBe(422);
    // duplicates are one card
    expect((await bulk(ann, boardA, {cardIds: [cards[0], cards[0]], action: 'set_priority', priority: 'low'})).json.changed).toBe(2 - 1);
  });
});
