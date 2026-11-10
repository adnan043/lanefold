import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

/** The Timeline draws start-to-due bars: the card shapes of the board, a lane page and the delta carry `startDate` and `createdAt` (real Postgres). */
describe.skipIf(!DATABASE_URL)('card start date on board reads (integration, real Postgres)', () => {
  let ann: Browser;
  let board: number;
  let lane: number;
  let card: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.41');
    const ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    board = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
    lane = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].id;
    card = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'Ship it'})).json.items[0].id;
  });

  it('carries startDate on the board, lane page and delta, and follows an edit', async () => {
    const before = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].cards[0];
    expect(before.startDate).toBeNull();
    expect(before.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const patched = await ann.request('PATCH', `/site-api/cards/${card}/details`, {startDate: '2026-11-03', dueDate: '2026-11-10'});
    expect(patched.status).toBe(200);
    expect(patched.json.card.startDate).toBe('2026-11-03');

    const full = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].cards[0];
    expect(full).toMatchObject({startDate: '2026-11-03', dueDate: '2026-11-10'});
    const page = (await ann.get(`/site-api/lanes/${lane}/cards`)).json.items[0];
    expect(page).toMatchObject({startDate: '2026-11-03', dueDate: '2026-11-10'});
    const delta = (await ann.get(`/site-api/boards/${board}/changes?since=0`)).json.cards.find((x: {id: number}) => x.id === card);
    expect(delta).toMatchObject({startDate: '2026-11-03', dueDate: '2026-11-10'});
  });
});
