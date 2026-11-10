import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {forgetEntitlements} from '../../src/server/entitlements';
import {runRecurringCards} from '../../src/server/jobs/recurring-cards';
import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Repeat rules and the job that makes the copies (real Postgres). */
describe.skipIf(!DATABASE_URL)('recurring cards (integration, real Postgres)', () => {
  let ann: Browser;
  let bob: Browser; // another workspace
  let viewer: Browser;
  let ws: number;
  let board: number;
  let lane: number;
  let card: number;
  const rule = (extra: J = {}) => ({frequency: 'weekly', interval: 1, startOn: today(), endsOn: null, ...extra});
  const put = (who: Browser, id: number, body: J) => who.request('PUT', `/site-api/cards/${id}/recurrence`, body);
  const copies = () => db.card.findMany({where: {boardId: board, importId: 'recurring'}, select: {id: true, title: true, dueDate: true, laneId: true, checklistTotal: true}});
  const makeDue = (id = card, on = plusDays(-1)) => db.cardRecurrence.update({where: {cardId: id}, data: {nextRunOn: at(on)}});

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.51');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.52');
    viewer = await signedIn(app, 'vic@example.test', undefined, '203.0.113.53');
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const vic = await db.user.findUniqueOrThrow({where: {email: 'vic@example.test'}, select: {id: true}});
    await db.workspaceMember.create({data: {workspaceId: ws, userId: vic.id, role: 'viewer'}});
    board = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Ops', lanes: ['To do']})).json.board.id;
    lane = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].id;
    card = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'Weekly report'})).json.items[0].id;
  });

  it('sets, reads, changes and stops a rule', async () => {
    expect((await ann.get(`/site-api/cards/${card}/recurrence`)).json).toEqual({recurrence: null});
    const saved = await put(ann, card, rule({frequency: 'monthly', interval: 2, endsOn: plusDays(400)}));
    expect(saved.status).toBe(200);
    expect(saved.json.recurrence).toMatchObject({frequency: 'monthly', interval: 2, startOn: today(), nextRunOn: today(), enabled: true});
    expect((await put(ann, card, rule({interval: 3}))).json.recurrence).toMatchObject({frequency: 'weekly', interval: 3, endsOn: null});
    expect(await db.cardRecurrence.count({where: {cardId: card}})).toBe(1);
    expect((await viewer.get(`/site-api/cards/${card}/recurrence`)).json.recurrence.interval).toBe(3);
    expect((await ann.request('DELETE', `/site-api/cards/${card}/recurrence`)).status).toBe(200);
    expect((await ann.get(`/site-api/cards/${card}/recurrence`)).json).toEqual({recurrence: null});
    expect((await ann.request('DELETE', `/site-api/cards/${card}/recurrence`)).status).toBe(404);
  });

  it('validates the rule with field errors', async () => {
    const bad = await put(ann, card, {frequency: 'hourly', interval: 0, startOn: 'tomorrow'});
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.json.fields).sort()).toEqual(['frequency', 'interval', 'startOn']);
    expect((await put(ann, card, rule({startOn: plusDays(-5)}))).json.fieldCodes.startOn).toBe('recurrence_past');
    expect((await put(ann, card, rule({endsOn: plusDays(-1)}))).json.fieldCodes.endsOn).toBe('recurrence_end_before_start');
    expect(await db.cardRecurrence.count()).toBe(0);
  });

  it('answers 404 to another workspace and 403 to a viewer, and writes nothing', async () => {
    for (const who of [bob]) {
      expect((await who.get(`/site-api/cards/${card}/recurrence`)).status).toBe(404);
      expect((await put(who, card, rule())).status).toBe(404);
      expect((await who.request('DELETE', `/site-api/cards/${card}/recurrence`)).status).toBe(404);
    }
    expect((await put(viewer, card, rule())).status).toBe(403);
    expect((await new Browser(app).get(`/site-api/cards/${card}/recurrence`)).status).toBe(401);
    expect(await db.cardRecurrence.count()).toBe(0);
    await put(ann, card, rule());
    expect((await viewer.request('DELETE', `/site-api/cards/${card}/recurrence`)).status).toBe(403);
    expect(await db.cardRecurrence.count()).toBe(1);
  });

  it('the job makes one copy, moves the rule on, and a repeat run changes nothing', async () => {
    await ann.request('PATCH', `/site-api/cards/${card}/details`, {dueDate: plusDays(3)});
    await put(ann, card, rule({frequency: 'daily', startOn: plusDays(-1)}));
    await makeDue();
    const first = await runRecurringCards(db);
    expect(first).toMatchObject({created: 1, failed: 0});
    const made = await copies();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({title: 'Weekly report', laneId: lane});
    const after = await db.cardRecurrence.findUniqueOrThrow({where: {cardId: card}});
    expect(after.nextRunOn.toISOString().slice(0, 10)).toBe(plusDays(1));
    expect(after.lastRunOn?.toISOString().slice(0, 10)).toBe(plusDays(-1));
    expect((await db.card.findUniqueOrThrow({where: {id: card}})).id).toBe(card);
    expect((await db.lane.findUniqueOrThrow({where: {id: lane}})).cardCount).toBe(2);
    expect(await db.cardRecurrence.count({where: {cardId: made[0]!.id}})).toBe(0); // the copy carries no rule
    expect(await runRecurringCards(db)).toMatchObject({created: 0, scanned: 0});
    expect(await copies()).toHaveLength(1);
    // the board delta carries the new card
    const delta = (await ann.get(`/site-api/boards/${board}/changes?since=0`)).json;
    expect(delta.cards.some((c: {id: number}) => c.id === made[0]!.id)).toBe(true);
  });

  it('two overlapping runs make exactly one copy', async () => {
    await put(ann, card, rule({frequency: 'daily'}));
    await makeDue();
    const runs = await Promise.all([runRecurringCards(db), runRecurringCards(db), runRecurringCards(db)]);
    expect(runs.reduce((n, r) => n + r.created, 0)).toBe(1);
    expect(await copies()).toHaveLength(1);
  });

  it('copies the checklist and shifts the due date; a long outage makes one copy only', async () => {
    const list = (await ann.post(`/site-api/cards/${card}/checklists`, {title: 'Steps'})).json;
    await ann.post(`/site-api/checklists/${list.checklist?.id ?? list.id}/items`, {text: 'one'});
    await put(ann, card, rule({frequency: 'daily'}));
    await makeDue(card, plusDays(-40));
    expect((await runRecurringCards(db)).created).toBe(1);
    expect(await copies()).toHaveLength(1);
    const next = await db.cardRecurrence.findUniqueOrThrow({where: {cardId: card}});
    expect(next.nextRunOn.toISOString().slice(0, 10)).toBe(plusDays(1));
  });

  it('ends: the last copy switches the rule off', async () => {
    await put(ann, card, rule({frequency: 'daily', startOn: today(), endsOn: today()}));
    expect((await runRecurringCards(db)).created).toBe(1);
    const done = await db.cardRecurrence.findUniqueOrThrow({where: {cardId: card}});
    expect(done.enabled).toBe(false);
    expect((await ann.get(`/site-api/cards/${card}/recurrence`)).json.recurrence).toMatchObject({enabled: false, nextRunOn: null});
    expect(await runRecurringCards(db)).toMatchObject({scanned: 0});
  });

  it('skips an archived board and an archived card (the card stops repeating)', async () => {
    await put(ann, card, rule({frequency: 'daily'}));
    await makeDue();
    await db.board.update({where: {id: board}, data: {archivedAt: new Date()}});
    expect(await runRecurringCards(db)).toMatchObject({created: 0, skipped: 1});
    expect(await copies()).toHaveLength(0);
    await db.board.update({where: {id: board}, data: {archivedAt: null}});
    await makeDue();
    await db.card.update({where: {id: card}, data: {archivedAt: new Date()}});
    expect(await runRecurringCards(db)).toMatchObject({created: 0, disabled: 1});
    expect((await db.cardRecurrence.findUniqueOrThrow({where: {cardId: card}})).enabled).toBe(false);
  });

  it('a read-only workspace makes no copy and cannot add a rule, but can stop one', async () => {
    await put(ann, card, rule({frequency: 'daily'}));
    await makeDue();
    await db.workspace.update({where: {id: ws}, data: {memberCount: 11, graceUntil: new Date(Date.now() - 1000)}});
    forgetEntitlements(db, ws);
    expect((await put(ann, card, rule())).status).toBe(409);
    expect(await runRecurringCards(db)).toMatchObject({created: 0, skipped: 1});
    expect(await copies()).toHaveLength(0);
    expect((await ann.request('DELETE', `/site-api/cards/${card}/recurrence`)).status).toBe(200);
  });
});
