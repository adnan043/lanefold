import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {invalidateAppSettings} from '../../src/server/entitlements';
import {runDailyFlows} from '../../src/server/jobs/flows';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

type J = Record<string, any>;

/** Phase 7 Flows: routes, authorization, the engine after card writes, loop safety, the daily job (real Postgres). */
describe.skipIf(!DATABASE_URL)('flows (integration, real Postgres)', () => {
  let ann: Browser; // owner of workspace A (board admin)
  let bob: Browser; // owner of workspace B: no seat in A
  let mia: Browser; // plain member of A: not a board admin
  let ws: number;
  let board: number;
  let lanes: number[]; // To do, Doing, Done
  let label: number;
  let annId: number;

  beforeAll(async () => {
    configureEnv();
    await db.appSettings.update({where: {id: 1}, data: {billingMode: 'FREE_FOR_ALL'}});
    await invalidateAppSettings();
  });
  afterAll(async () => {
    await db.appSettings.update({where: {id: 1}, data: {billingMode: 'PAID'}});
    await invalidateAppSettings();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.72');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.73');
    annId = await userId('ann@example.test');
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    await db.workspaceMember.create({data: {workspaceId: ws, userId: await userId('mia@example.test'), role: 'member'}});
    board = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Roadmap', lanes: ['To do', 'Doing', 'Done']})).json.board.id;
    lanes = (await ann.get(`/site-api/boards/${board}`)).json.lanes.map((l: J) => l.id);
    label = (await ann.post(`/site-api/boards/${board}/labels`, {name: 'Auto', colorHex: '#ff0000'})).json.label.id;
  });

  const flow = (body: J) => ann.post(`/site-api/boards/${board}/flows`, {name: 'F', ...body});
  const addCard = async (lane = lanes[0]!) => (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'Card'})).json.items[0].id as number;
  const move = (card: number, lane: number) => ann.post(`/site-api/cards/${card}/move`, {laneId: lane, afterId: null});
  const cardRow = (id: number) => db.card.findUniqueOrThrow({where: {id}, select: {laneId: true, commentCount: true}});

  it('keeps other workspaces out (404) and non-admins out (403)', async () => {
    const made = (await flow({trigger: {kind: 'card_created'}, actions: [{type: 'comment', body: 'hi'}]})).json.flow.id;
    for (const [method, path, body] of [
      ['GET', `/boards/${board}/flows`, undefined],
      ['POST', `/boards/${board}/flows`, {name: 'x', trigger: {kind: 'card_created'}, actions: [{type: 'comment', body: 'x'}]}],
      ['PATCH', `/flows/${made}`, {name: 'x'}],
      ['DELETE', `/flows/${made}`, undefined],
    ] as [string, string, unknown][]) {
      expect((await bob.request(method, `/site-api${path}`, body)).status, `bob ${method} ${path}`).toBe(404);
      expect((await mia.request(method, `/site-api${path}`, body)).status, `mia ${method} ${path}`).toBe(403);
    }
    expect((await db.flow.count({where: {boardId: board}}))).toBe(1);
    expect((await db.flow.findUniqueOrThrow({where: {id: made}})).name).toBe('F');
  });

  it('validates input and references that belong to the board', async () => {
    const other = (await db.workspace.findFirstOrThrow({where: {name: 'Beta'}})).id;
    const bobBoard = (await bob.post(`/site-api/workspaces/${other}/boards`, {name: 'B', lanes: ['X']})).json.board.id;
    const bobLane = (await bob.get(`/site-api/boards/${bobBoard}`)).json.lanes[0].id;
    const bad = await flow({trigger: {kind: 'card_moved', laneId: lanes[1]}, actions: [{type: 'move', laneId: bobLane}, {type: 'assign', userId: 999999}, {type: 'add_label', labelId: 999999}]});
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.json.fields).sort()).toEqual(['actions.0.laneId', 'actions.1.userId', 'actions.2.labelId']);
    const loop = await flow({trigger: {kind: 'card_moved', laneId: lanes[1]}, actions: [{type: 'move', laneId: lanes[1]}]});
    expect(loop.status).toBe(422);
    expect((await flow({trigger: {kind: 'card_moved'}, actions: []})).status).toBe(422);
    expect((await flow({name: '', trigger: {kind: 'card_created'}, actions: [{type: 'comment', body: 'x'}]})).status).toBe(422);
  });

  it('runs a moved flow: assign, label, comment, then moves on; activity has no actor', async () => {
    const made = await flow({
      trigger: {kind: 'card_moved', laneId: lanes[1]},
      actions: [{type: 'assign', userId: annId}, {type: 'add_label', labelId: label}, {type: 'comment', body: 'Started'}, {type: 'move', laneId: lanes[2]}],
    });
    expect(made.status).toBe(422); // 4 actions: over the limit of 3
    expect((await flow({trigger: {kind: 'card_moved', laneId: lanes[1]}, actions: [{type: 'assign', userId: annId}, {type: 'add_label', labelId: label}, {type: 'comment', body: 'Started'}]})).status).toBe(201);
    const card = await addCard();
    expect((await move(card, lanes[1]!)).status).toBe(200);
    const row = await cardRow(card);
    expect(row.commentCount).toBe(1);
    expect(await db.cardMember.count({where: {cardId: card, userId: annId}})).toBe(1);
    expect(await db.cardLabel.count({where: {cardId: card, labelId: label}})).toBe(1);
    const comment = await db.comment.findFirstOrThrow({where: {cardId: card}});
    expect(comment.authorId).toBeNull();
    const acts = await db.activity.findMany({where: {cardId: card, actorId: null}});
    expect(acts.map(a => a.kind).sort()).toEqual(['card.label_added', 'card.member_added', 'comment.created']);
    expect(acts.every(a => (a.meta as J).flowName === 'F')).toBe(true);
  });

  it('chains a move action to another flow and stops ping-pong loops', async () => {
    // Doing -> Done, Done -> Doing: each fires the other; depth and the per-chain memory end it.
    expect((await flow({trigger: {kind: 'card_moved', laneId: lanes[1]}, actions: [{type: 'move', laneId: lanes[2]}]})).status).toBe(201);
    expect((await flow({name: 'Back', trigger: {kind: 'card_moved', laneId: lanes[2]}, actions: [{type: 'move', laneId: lanes[1]}]})).status).toBe(201);
    const card = await addCard();
    expect((await move(card, lanes[1]!)).status).toBe(200);
    const moves = await db.activity.count({where: {cardId: card, kind: 'card.moved', actorId: null}});
    expect(moves).toBeGreaterThan(0);
    expect(moves).toBeLessThanOrEqual(3);
    const counts = await db.lane.findMany({where: {boardId: board}, select: {id: true, cardCount: true}});
    expect(counts.reduce((n, l) => n + l.cardCount, 0)).toBe(1); // counters stay consistent
  });

  it('runs created flows once per card, conditions respected, disabled flows ignored', async () => {
    const on = (await flow({trigger: {kind: 'card_created', laneId: lanes[0]}, actions: [{type: 'comment', body: 'Welcome'}]})).json.flow.id;
    await flow({name: 'Cond', trigger: {kind: 'card_created'}, conditions: {labelId: label}, actions: [{type: 'comment', body: 'never'}]});
    const cards = (await ann.post(`/site-api/lanes/${lanes[0]}/cards`, {titles: ['a', 'b']})).json.items as J[];
    for (const c of cards) expect((await cardRow(c.id)).commentCount).toBe(1);
    expect((await ann.request('PATCH', `/site-api/flows/${on}`, {enabled: false})).json.flow.enabled).toBe(false);
    const later = await addCard();
    expect((await cardRow(later)).commentCount).toBe(0);
    const listed = (await ann.get(`/site-api/boards/${board}/flows`)).json;
    expect(listed.items).toHaveLength(2);
    expect(listed.enabled).toBe(true);
  });

  it('flags a deleted lane as a problem and skips it without failing the card write', async () => {
    const made = (await flow({trigger: {kind: 'card_created'}, actions: [{type: 'move', laneId: lanes[2]}]})).json.flow.id;
    await db.lane.update({where: {id: lanes[2]!}, data: {archivedAt: new Date()}});
    const listed = (await ann.get(`/site-api/boards/${board}/flows`)).json.items.find((f: J) => f.id === made);
    expect(listed.problems).toEqual(['lane_gone']);
    const card = await addCard();
    expect((await cardRow(card)).laneId).toBe(lanes[0]);
  });

  it('daily job: runs a due-date flow once a day, even when repeated', async () => {
    expect((await flow({trigger: {kind: 'daily_due', dueInDays: 1}, actions: [{type: 'comment', body: 'Due tomorrow'}, {type: 'notify', target: 'assignees'}]})).status).toBe(201);
    const now = new Date('2026-11-10T06:00:00Z');
    const due = await addCard();
    const later = await addCard();
    const done = await addCard();
    await db.card.update({where: {id: due}, data: {dueDate: new Date('2026-11-11T00:00:00Z')}});
    await db.card.update({where: {id: later}, data: {dueDate: new Date('2026-11-12T00:00:00Z')}});
    await db.card.update({where: {id: done}, data: {dueDate: new Date('2026-11-11T00:00:00Z'), completedAt: new Date()}});
    const first = await runDailyFlows(db, now);
    const second = await runDailyFlows(db, now);
    expect(first).toEqual({claimed: 1, cards: 1});
    expect(second.claimed).toBe(0);
    expect((await cardRow(due)).commentCount).toBe(1);
    expect((await cardRow(later)).commentCount).toBe(0);
    expect((await cardRow(done)).commentCount).toBe(0);
    // The next day it runs again for that day's cards.
    const next = await runDailyFlows(db, new Date('2026-11-11T06:00:00Z'));
    expect(next.claimed).toBe(1);
    expect((await cardRow(later)).commentCount).toBe(1);
  });

  it('refuses writes when the plan has no Flows, and never runs them', async () => {
    const made = (await flow({trigger: {kind: 'card_created'}, actions: [{type: 'comment', body: 'x'}]})).json.flow.id;
    await db.appSettings.update({where: {id: 1}, data: {billingMode: 'PAID'}});
    await invalidateAppSettings();
    try {
      await db.$executeRaw`UPDATE plan_limits SET max_flows = 0 WHERE plan = 'free'`;
      expect((await flow({trigger: {kind: 'card_created'}, actions: [{type: 'comment', body: 'x'}]})).status).toBe(403);
      const card = await addCard();
      expect((await cardRow(card)).commentCount).toBe(0);
      expect((await ann.delete(`/site-api/flows/${made}`)).status).toBe(200);
    } finally {
      await db.appSettings.update({where: {id: 1}, data: {billingMode: 'FREE_FOR_ALL'}});
      await invalidateAppSettings();
    }
  });
});
