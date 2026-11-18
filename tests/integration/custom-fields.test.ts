import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

/** Custom fields: define on a board, set on a card, read for the Table view; another workspace sees nothing (real Postgres). */
describe.skipIf(!DATABASE_URL)('custom fields (integration, real Postgres)', () => {
  let ann: Browser;
  let eve: Browser;
  let board: number;
  let card: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.51');
    eve = await signedIn(app, 'eve@example.test', undefined, '203.0.113.52');
    const ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    board = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
    const lane = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].id;
    card = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'Ship it'})).json.items[0].id;
  });

  it('defines fields, sets values per type, validates, and lists them for the table', async () => {
    const num = (await ann.post(`/site-api/boards/${board}/fields`, {name: 'Points', type: 'number'})).json.field;
    const sel = (await ann.post(`/site-api/boards/${board}/fields`, {name: 'Size', type: 'dropdown', options: [{name: 'S', colorHex: '#22aa55'}]})).json.field;
    const opt = sel.options[0].id;
    expect((await ann.post(`/site-api/boards/${board}/fields`, {name: '', type: 'text'})).status).toBe(422);
    expect((await ann.post(`/site-api/boards/${board}/fields`, {name: 'X', type: 'bogus'})).status).toBe(422);

    expect((await ann.request('PUT', `/site-api/cards/${card}/fields/${num.id}`, {value: 'abc'})).status).toBe(422);
    expect((await ann.request('PUT', `/site-api/cards/${card}/fields/${num.id}`, {value: 5})).status).toBe(200);
    expect((await ann.request('PUT', `/site-api/cards/${card}/fields/${sel.id}`, {value: 999999})).status).toBe(422);
    expect((await ann.request('PUT', `/site-api/cards/${card}/fields/${sel.id}`, {value: opt})).status).toBe(200);

    const read = await ann.get(`/site-api/boards/${board}/field-values`);
    expect(read.status).toBe(200);
    expect(read.json.fields.map((f: {name: string}) => f.name)).toEqual(['Points', 'Size']);
    expect(read.json.values[String(card)]).toEqual({[num.id]: 5, [sel.id]: opt});

    await ann.request('PUT', `/site-api/cards/${card}/fields/${num.id}`, {value: null});
    expect((await ann.get(`/site-api/boards/${board}/field-values`)).json.values[String(card)]).toEqual({[sel.id]: opt});
  });

  it('reorders the whole list, keeps new fields last, and refuses a list that is not the board\'s', async () => {
    const make = async (name: string) => (await ann.post(`/site-api/boards/${board}/fields`, {name, type: 'text'})).json.field.id as number;
    const a = await make('A');
    const b = await make('B');
    const c = await make('C');
    const names = async () => (await ann.get(`/site-api/boards/${board}/field-values`)).json.fields.map((f: {name: string}) => f.name);
    expect(await names()).toEqual(['A', 'B', 'C']);

    const ok = await ann.request('PUT', `/site-api/boards/${board}/fields/order`, {ids: [c, a, b]});
    expect(ok.status).toBe(200);
    expect(await names()).toEqual(['C', 'A', 'B']);
    // The card panel reads the same order.
    expect((await ann.get(`/site-api/cards/${card}/detail`)).json.fields.map((f: {name: string}) => f.name)).toEqual(['C', 'A', 'B']);

    // A field added after a reorder goes last.
    await make('D');
    expect(await names()).toEqual(['C', 'A', 'B', 'D']);

    // Missing a field, a stranger's id, or a duplicate: refused, nothing moves.
    expect((await ann.request('PUT', `/site-api/boards/${board}/fields/order`, {ids: [a, b, c]})).status).toBe(409);
    expect((await ann.request('PUT', `/site-api/boards/${board}/fields/order`, {ids: [a, a, b, c]})).status).toBe(422);
    expect((await ann.request('PUT', `/site-api/boards/${board}/fields/order`, {ids: []})).status).toBe(422);
    expect((await ann.request('PUT', `/site-api/boards/${board}/fields/order`, {ids: 'a,b'})).status).toBe(422);
    expect(await names()).toEqual(['C', 'A', 'B', 'D']);
  });

  it('hides everything from a user outside the workspace', async () => {
    const f = (await ann.post(`/site-api/boards/${board}/fields`, {name: 'Note', type: 'text'})).json.field;
    expect((await eve.get(`/site-api/boards/${board}/field-values`)).status).toBe(404);
    expect((await eve.post(`/site-api/boards/${board}/fields`, {name: 'Hack', type: 'text'})).status).toBe(404);
    expect((await eve.request('PUT', `/site-api/cards/${card}/fields/${f.id}`, {value: 'x'})).status).toBe(404);
    expect((await eve.request('DELETE', `/site-api/fields/${f.id}`)).status).toBe(404);
    expect((await eve.request('PUT', `/site-api/boards/${board}/fields/order`, {ids: [f.id]})).status).toBe(404);
  });

  it('reads the values in whole-card pages, then only what changed since a revision', async () => {
    const ws = (await db.board.findUniqueOrThrow({where: {id: board}, select: {workspaceId: true}})).workspaceId;
    const lane = (await db.lane.findFirstOrThrow({where: {boardId: board}, select: {id: true}})).id;
    await db.customField.createMany({data: Array.from({length: 20}, (_, i) => ({boardId: board, workspaceId: ws, name: `F${i}`, type: 'text', position: i}))});
    const fieldIds = (await db.customField.findMany({where: {boardId: board}, orderBy: {id: 'asc'}, select: {id: true}})).map(f => f.id);
    await db.card.createMany({data: Array.from({length: 260}, (_, i) => ({boardId: board, laneId: lane, workspaceId: ws, title: `Bulk ${i}`, position: `b${String(i).padStart(4, '0')}`}))});
    const cards = (await db.card.findMany({where: {boardId: board}, orderBy: {id: 'asc'}, select: {id: true}})).map(c => c.id);
    await db.cardFieldValue.createMany({data: cards.flatMap(cardId => fieldIds.map(fieldId => ({cardId, fieldId, workspaceId: ws, textValue: `v${cardId}`})))});
    // 261 cards x 20 values: the first page holds 250 whole cards, the second the rest.
    const first = (await ann.get(`/site-api/boards/${board}/field-values`)).json;
    expect(Object.keys(first.values)).toHaveLength(250);
    expect(first.nextAfter).toBe(cards[249]);
    expect(Object.values(first.values).every(v => Object.keys(v as object).length === 20)).toBe(true);
    const second = (await ann.get(`/site-api/boards/${board}/field-values?after=${first.nextAfter}`)).json;
    expect(Object.keys(second.values).map(Number)).toEqual(cards.slice(250));
    expect(second.nextAfter).toBeNull();
    expect((await ann.get(`/site-api/boards/${board}/field-values?after=x`)).status).toBe(422);
    expect((await ann.get(`/site-api/boards/${board}/field-values?since=-1`)).status).toBe(422);

    // Nothing changed: an empty delta. Then a value cleared, a card edited, and a card archived.
    const rev = first.rev as string;
    expect((await ann.get(`/site-api/boards/${board}/field-values?since=${rev}`)).json).toMatchObject({rev, values: {}, changed: []});
    expect((await ann.request('PUT', `/site-api/cards/${cards[0]}/fields/${fieldIds[0]}`, {value: null})).status).toBe(200);
    expect((await ann.request('PATCH', `/site-api/cards/${cards[1]}/details`, {title: 'Touched'})).status).toBe(200);
    await db.board.update({where: {id: board}, data: {rev: {increment: 1}}});
    const top = (await db.board.findUniqueOrThrow({where: {id: board}, select: {rev: true}})).rev;
    await db.card.update({where: {id: cards[2]}, data: {archivedAt: new Date(), updatedRev: top}});
    const delta = (await ann.get(`/site-api/boards/${board}/field-values?since=${rev}`)).json;
    expect([...delta.changed].sort((a: number, b: number) => a - b)).toEqual(cards.slice(0, 3));
    expect(Object.keys(delta.values[String(cards[0])])).toHaveLength(19);
    expect(Object.keys(delta.values[String(cards[1])])).toHaveLength(20);
    expect(delta.values[String(cards[2])]).toBeUndefined(); // archived: in `changed`, without values
    expect(delta.reset).toBeUndefined();

    // Too much changed for a delta, or a revision from the future: read it all again.
    await db.card.updateMany({where: {boardId: board}, data: {updatedRev: top}});
    expect((await ann.get(`/site-api/boards/${board}/field-values?since=${rev}`)).json.reset).toBe(true);
    expect((await ann.get(`/site-api/boards/${board}/field-values?since=${top + 1000n}`)).json.reset).toBe(true);
    expect((await eve.get(`/site-api/boards/${board}/field-values?since=${rev}`)).status).toBe(404);
    expect((await eve.get(`/site-api/boards/${board}/field-values?after=1`)).status).toBe(404);
  });
});
