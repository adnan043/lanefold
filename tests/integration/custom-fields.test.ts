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
});
