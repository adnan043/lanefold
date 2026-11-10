import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** The Undo of a bulk action: the server's exact inverse, guarded by the rev (real Postgres). */
describe.skipIf(!DATABASE_URL)('bulk card actions: Undo (integration, real Postgres)', () => {
  let ann: Browser;
  let ben: Browser;
  let bob: Browser; // other workspace
  let vic: Browser; // viewer in A
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
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.81');
    ben = await signedIn(app, 'ben@example.test', undefined, '203.0.113.82');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.83');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.84');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
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
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  /** Send every undo step the answer carried, in order; returns the answers. */
  const undoAll = async (who: Browser, board: number, res: {json: J}) => {
    const out: {status: number; json: J}[] = [];
    for (const step of res.json.undo ?? []) out.push(await bulk(who, board, step));
    return out;
  };

  it('move: one guarded step back to the lane the cards came from; counters and rev follow', async () => {
    const res = await bulk(ann, boardA, {cardIds: [cards[0], cards[2]], action: 'move', laneId: laneA2});
    expect(res.json.undo).toEqual([{action: 'move', laneId: laneA1, cardIds: [cards[0], cards[2]], ifUnchangedSince: res.json.rev}]);
    const back = await undoAll(ann, boardA, res);
    expect(back[0]!.status).toBe(200);
    expect(back[0]!.json.changed).toBe(2);
    expect((await row(cards[0])).laneId).toBe(laneA1);
    expect((await row(cards[2])).laneId).toBe(laneA1);
    expect(await laneCount(laneA1)).toBe(3);
    expect(await laneCount(laneA2)).toBe(0);
    expect(await db.activity.count({where: {boardId: boardA, kind: 'cards.bulk'}})).toBe(2);
  });

  it('a move with nothing to move offers no Undo', async () => {
    const res = await bulk(ann, boardA, {cardIds: cards, action: 'move', laneId: laneA1});
    expect(res.json.changed).toBe(0);
    expect(res.json.undo).toBeUndefined();
  });

  it('archive: Undo restores the cards and the lane counter; a restored card is a live card again', async () => {
    const res = await bulk(ann, boardA, {cardIds: [cards[0], cards[1]], action: 'archive'});
    expect(res.json.undo).toEqual([{action: 'restore', cardIds: [cards[0], cards[1]], ifUnchangedSince: res.json.rev}]);
    expect(await laneCount(laneA1)).toBe(1);
    const back = await undoAll(ann, boardA, res);
    expect(back[0]!.json.changed).toBe(2);
    expect((await row(cards[0])).archivedAt).toBeNull();
    expect(await laneCount(laneA1)).toBe(3);
    // the answer to the Undo is itself undoable (redo)
    expect(back[0]!.json.undo?.[0]).toMatchObject({action: 'archive', cardIds: [cards[0], cards[1]]});
  });

  it('GUARD: a card written after the action is skipped, not overwritten', async () => {
    const res = await bulk(ann, boardA, {cardIds: cards, action: 'set_priority', priority: 'urgent'});
    // somebody edits ONE card afterwards
    expect((await ben.request('PATCH', `/site-api/cards/${cards[1]}`, {priority: 'low'})).status).toBe(200);
    const back = await undoAll(ann, boardA, res);
    expect(back).toHaveLength(1);
    expect(back[0]!.json.changed).toBe(2);
    expect(back[0]!.json.skipped).toBe(1);
    expect((await row(cards[0])).priority).toBe('none');
    expect((await row(cards[1])).priority).toBe('low'); // the later edit stays
    expect((await row(cards[2])).priority).toBe('none');
  });

  it('GUARD: when every card was written since, the Undo changes nothing and bumps no rev', async () => {
    const res = await bulk(ann, boardA, {cardIds: [cards[0]], action: 'set_priority', priority: 'high'});
    expect((await ann.request('PATCH', `/site-api/cards/${cards[0]}`, {priority: 'low'})).status).toBe(200);
    const before = await rev(boardA);
    const back = await undoAll(ann, boardA, res);
    expect(back[0]!.status).toBe(200);
    expect(back[0]!.json).toEqual({changed: 0, skipped: 1});
    expect(await rev(boardA)).toBe(before);
    expect((await row(cards[0])).priority).toBe('low');
  });

  it('GUARD: an archived card somebody already restored (or never archived) is skipped, never resurrected twice', async () => {
    const res = await bulk(ann, boardA, {cardIds: [cards[0]], action: 'archive'});
    expect((await ann.post(`/site-api/cards/${cards[0]}/restore`, {})).status).toBe(200);
    const back = await undoAll(ann, boardA, res);
    expect(back[0]!.json).toEqual({changed: 0, skipped: 1});
    expect(await laneCount(laneA1)).toBe(3); // not counted twice
    // WITHOUT the guard a card in the wrong state is still the old 404
    expect((await bulk(ann, boardA, {cardIds: [cards[0]], action: 'restore'})).status).toBe(404);
  });

  it('label_add: Undo takes the label off only the cards that did not have it', async () => {
    const bug = (await ann.post(`/site-api/boards/${boardA}/labels`, {name: 'Bug', colorHex: '#aa0000'})).json.label.id;
    await bulk(ann, boardA, {cardIds: [cards[0]], action: 'label_add', labelId: bug});
    const res = await bulk(ann, boardA, {cardIds: cards, action: 'label_add', labelId: bug});
    expect(res.json.undo).toMatchObject([{action: 'label_remove', labelId: bug, cardIds: [cards[1], cards[2]]}]);
    await undoAll(ann, boardA, res);
    expect((await db.cardLabel.findMany({where: {labelId: bug}, select: {cardId: true}})).map(r => r.cardId)).toEqual([cards[0]]);
  });

  it('label_remove: Undo puts the label back on the cards that had it', async () => {
    const bug = (await ann.post(`/site-api/boards/${boardA}/labels`, {name: 'Bug', colorHex: '#aa0000'})).json.label.id;
    await bulk(ann, boardA, {cardIds: [cards[0], cards[1]], action: 'label_add', labelId: bug});
    const res = await bulk(ann, boardA, {cardIds: cards, action: 'label_remove', labelId: bug});
    await undoAll(ann, boardA, res);
    expect((await db.cardLabel.findMany({where: {labelId: bug}, select: {cardId: true}, orderBy: {cardId: 'asc'}})).map(r => r.cardId)).toEqual([cards[0], cards[1]]);
  });

  it('assign / unassign: Undo takes back exactly the change', async () => {
    await bulk(ann, boardA, {cardIds: [cards[0]], action: 'assign', userId: benId});
    const assign = await bulk(ann, boardA, {cardIds: cards, action: 'assign', userId: benId});
    expect(assign.json.undo).toMatchObject([{action: 'unassign', userId: benId, cardIds: [cards[1], cards[2]]}]);
    await undoAll(ann, boardA, assign);
    expect((await db.cardMember.findMany({where: {userId: benId}, select: {cardId: true}})).map(r => r.cardId)).toEqual([cards[0]]);
    const un = await bulk(ann, boardA, {cardIds: cards, action: 'unassign', userId: benId});
    expect(un.json.undo).toMatchObject([{action: 'assign', userId: benId, cardIds: [cards[0]]}]);
    await undoAll(ann, boardA, un);
    expect(await db.cardMember.count({where: {userId: benId, cardId: {in: cards}}})).toBe(1);
  });

  it('set_due: one step per previous day (a card with none is cleared again)', async () => {
    await bulk(ann, boardA, {cardIds: [cards[0]], action: 'set_due', dueDate: '2030-05-05'});
    const res = await bulk(ann, boardA, {cardIds: cards, action: 'set_due', dueDate: '2031-01-01'});
    expect(res.json.undo).toHaveLength(2);
    const back = await undoAll(ann, boardA, res);
    expect(back.map(b => b.status)).toEqual([200, 200]);
    expect(day((await row(cards[0])).dueDate)).toBe('2030-05-05');
    expect(day((await row(cards[1])).dueDate)).toBeNull();
    expect(day((await row(cards[2])).dueDate)).toBeNull();
  });

  it('more previous values than MAX_UNDO_STEPS: no Undo is offered', async () => {
    const many = (await ann.post(`/site-api/lanes/${laneA2}/cards`, {titles: Array.from({length: 9}, (_, i) => `D${i}`)})).json.items.map((x: J) => x.id);
    for (const [i, id] of many.entries()) await bulk(ann, boardA, {cardIds: [id], action: 'set_due', dueDate: `2030-02-${String(i + 1).padStart(2, '0')}`});
    const res = await bulk(ann, boardA, {cardIds: many, action: 'set_due', dueDate: null});
    expect(res.status).toBe(200);
    expect(res.json.changed).toBe(9);
    expect(res.json.undo).toBeUndefined();
  });

  it('restore into a full lane is a 409 and changes nothing (the card stays archived)', async () => {
    const res = await bulk(ann, boardA, {cardIds: [cards[0]], action: 'archive'});
    await db.lane.update({where: {id: laneA1}, data: {cardCount: 500}});
    const before = await rev(boardA);
    const back = await undoAll(ann, boardA, res);
    expect(back[0]!.status).toBe(409);
    expect(back[0]!.json.error).toBe('lane_card_limit');
    expect((await row(cards[0])).archivedAt).not.toBeNull();
    expect(await rev(boardA)).toBe(before);
    expect(await laneCount(laneA1)).toBe(500);
  });

  it('restore into an archived lane is a 404', async () => {
    const res = await bulk(ann, boardA, {cardIds: [cards[0]], action: 'archive'});
    await db.lane.update({where: {id: laneA1}, data: {archivedAt: new Date()}});
    const before = await rev(boardA);
    const back = await undoAll(ann, boardA, res);
    expect(back[0]!.status).toBe(404);
    expect((await row(cards[0])).archivedAt).not.toBeNull();
    expect(await rev(boardA)).toBe(before);
  });

  it('AUTHZ: restore and the guard never reach a card of another board, another workspace, or a viewer', async () => {
    const res = await bulk(ann, boardA, {cardIds: [cards[0]], action: 'archive'});
    const step = res.json.undo[0];
    // a card of ANOTHER board of the same workspace: 404 (with the guard too), and it stays untouched
    expect((await bulk(ann, boardA, {cardIds: [foreign], action: 'restore', ifUnchangedSince: '999999'})).status).toBe(404);
    expect((await bulk(ann, boardA, {cardIds: [cards[0], foreign], action: 'restore', ifUnchangedSince: '999999'})).status).toBe(404);
    expect((await row(cards[0])).archivedAt).not.toBeNull();
    // another workspace
    expect((await bulk(bob, boardA, step)).status).toBe(404);
    // a viewer
    expect((await bulk(vic, boardA, step)).status).toBe(403);
    expect((await row(cards[0])).archivedAt).not.toBeNull();
  });

  it('validates the guard: a bad revision is a 422', async () => {
    for (const bad of ['', 'abc', '-1', '1.5', 7, null]) {
      expect((await bulk(ann, boardA, {cardIds: [cards[0]], action: 'archive', ifUnchangedSince: bad})).status).toBe(422);
    }
    expect((await row(cards[0])).archivedAt).toBeNull();
  });

  it('an Undo is recorded in the activity (meta.undo) and is one rev bump', async () => {
    const res = await bulk(ann, boardA, {cardIds: cards, action: 'set_priority', priority: 'high'});
    const before = await rev(boardA);
    await undoAll(ann, boardA, res);
    expect(await rev(boardA)).toBe(before + 1n);
    const last = await db.activity.findFirstOrThrow({where: {boardId: boardA, kind: 'cards.bulk'}, orderBy: {id: 'desc'}});
    expect(last.meta).toMatchObject({action: 'set_priority', undo: true});
  });
});
