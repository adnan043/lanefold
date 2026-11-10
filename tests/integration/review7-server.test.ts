import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

describe.skipIf(!DATABASE_URL)('review 7: board cursor and stale move (integration)', () => {
  let ann: Browser;
  let board: number;
  let lane: number;
  let cardA: number;
  let cardB: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    const ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    board = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'B', lanes: ['L1']})).json.board.id;
    lane = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].id;
    cardA = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'A'})).json.items[0].id;
    cardB = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'B'})).json.items[0].id;
  });

  it('a card cursor with a huge id is a 4xx, never a 500', async () => {
    for (const after of ['a|99999999999', 'a|2147483648', 'a|0', 'a|9999999999']) {
      const res = await ann.get(`/site-api/lanes/${lane}/cards?after=${encodeURIComponent(after)}`);
      expect(res.status, after).toBeLessThan(500);
      expect(res.status, after).toBeGreaterThanOrEqual(400);
    }
  });

  it('a stale card move (anchor gone) does not bump the board revision', async () => {
    const before = (await ann.get(`/site-api/boards/${board}/rev`)).json.rev;
    const res = await ann.post(`/site-api/cards/${cardA}/move`, {laneId: lane, afterId: 2147483000});
    // The anchor does not exist: refused as stale (409) before the board lock and the rev bump.
    expect(res.status).toBe(409);
    expect(res.json.error).toBe('stale');
    const huge = await ann.post(`/site-api/cards/${cardA}/move`, {laneId: lane, afterId: 99999999999});
    expect(huge.status).toBe(422);
    expect((await ann.get(`/site-api/boards/${board}/rev`)).json.rev).toBe(before);
    expect(cardB).toBeGreaterThan(0);
  });
});
