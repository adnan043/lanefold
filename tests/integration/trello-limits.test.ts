import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {invalidateAppSettings} from '../../src/server/entitlements';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Plan limits like Trello's: open boards per workspace and flow runs a month (real Postgres). */
describe.skipIf(!DATABASE_URL)('Trello-like plan limits (integration, real Postgres)', () => {
  let ann: Browser;
  let ws: number;

  const resetPlans = async () => {
    await db.$executeRaw`UPDATE plan_limits SET max_members = 10, max_boards = 10, max_file_bytes = 10485760, flow_runs_per_month = 250, audit_log = false WHERE plan = 'free'`;
    await db.$executeRaw`UPDATE plan_limits SET max_members = 500, max_boards = NULL, max_file_bytes = 262144000, flow_runs_per_month = 1000, audit_log = false WHERE plan = 'pro'`;
    await db.appSettings.update({where: {id: 1}, data: {billingMode: 'PAID', graceDays: 14}});
    await invalidateAppSettings();
  };

  beforeAll(configureEnv);
  afterAll(async () => {
    await resetPlans();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await resetPlans();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.91');
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
  });

  /** `n` open boards straight in the database (fast; the limit counts rows, not how they were made). */
  const seedBoards = (n: number) =>
    db.board.createMany({data: Array.from({length: n}, (_, i) => ({workspaceId: ws, name: `Seed ${i}`}))});
  const openBoards = () => db.board.count({where: {workspaceId: ws, archivedAt: null}});
  const createBoard = (name = 'New') => ann.post(`/site-api/workspaces/${ws}/boards`, {name, lanes: ['To do']});

  describe('open boards', () => {
    it('Free: the 11th open board is refused; archiving one frees a slot; un-archiving at the limit is refused', async () => {
      await seedBoards(9);
      const tenth = await createBoard('Tenth');
      expect(tenth.status).toBe(201);
      const eleventh = await createBoard('Eleventh');
      expect(eleventh.status).toBe(409);
      expect(eleventh.json.error).toBe('board_limit_reached');
      expect(await openBoards()).toBe(10);

      const id = tenth.json.board.id as number;
      expect((await ann.request('PATCH', `/site-api/boards/${id}`, {archived: true})).status).toBe(200);
      expect(await openBoards()).toBe(9);
      const again = await createBoard('Again');
      expect(again.status).toBe(201);
      expect(await openBoards()).toBe(10);

      const back = await ann.request('PATCH', `/site-api/boards/${id}`, {archived: false});
      expect(back.status).toBe(409);
      expect(back.json.error).toBe('board_limit_reached');
      expect((await db.board.findUniqueOrThrow({where: {id}})).archivedAt).not.toBeNull();
    });

    it('the usage shows on the billing screen', async () => {
      await seedBoards(3);
      const res = await ann.get(`/site-api/workspaces/${ws}/billing`);
      expect(res.status).toBe(200);
      expect(res.json.entitlements.usage).toMatchObject({members: 1, boards: 3, flowRuns: 0});
      expect(res.json.entitlements.limits).toMatchObject({maxBoards: 10, flowRunsPerMonth: 250});
      expect(res.json.entitlements.unlimited).toEqual({members: false, boards: false, flowRuns: false});
    });

    it('Pro (max_boards NULL): the 11th open board is fine', async () => {
      await db.workspace.update({where: {id: ws}, data: {plan: 'pro'}});
      await seedBoards(10);
      expect((await createBoard('Eleventh')).status).toBe(201);
      expect(await openBoards()).toBe(11);
    });

    it('parallel creates at 9 boards end with exactly 10', async () => {
      await seedBoards(9);
      const results = await Promise.all(Array.from({length: 5}, (_, i) => createBoard(`P${i}`)));
      expect(results.filter(r => r.status === 201)).toHaveLength(1);
      for (const r of results.filter(r => r.status !== 201)) expect(r.json.error).toBe('board_limit_reached');
      expect(await openBoards()).toBe(10);
    });
  });

  describe('flow runs a month', () => {
    let board: number;
    let lane: number;

    beforeEach(async () => {
      await db.$executeRaw`UPDATE plan_limits SET flow_runs_per_month = 2 WHERE plan = 'free'`;
      await invalidateAppSettings();
      board = (await createBoard('Flows')).json.board.id;
      lane = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].id;
      const made = await ann.post(`/site-api/boards/${board}/flows`, {name: 'Hello', trigger: {kind: 'card_created'}, actions: [{type: 'comment', body: 'hi'}]});
      expect(made.status, JSON.stringify(made.json)).toBe(201);
    });

    const addCard = async (title: string) => (await ann.post(`/site-api/lanes/${lane}/cards`, {title})).json.items[0].id as number;
    const comments = (id: number) => db.card.findUniqueOrThrow({where: {id}, select: {commentCount: true}}).then(r => r.commentCount);
    const runs = async () => (await db.flowRunCount.findMany({where: {workspaceId: ws}, select: {runs: true}, take: 2})).reduce((n, r) => n + r.runs, 0);

    it('runs for the first 2 cards of the month, not the 3rd; the flows panel shows the count', async () => {
      const a = await addCard('A');
      const b = await addCard('B');
      const c = await addCard('C');
      expect([await comments(a), await comments(b), await comments(c)]).toEqual([1, 1, 0]);
      expect(await runs()).toBe(2);
      const list = await ann.get(`/site-api/boards/${board}/flows`);
      expect(list.status).toBe(200);
      expect(list.json.limit).toMatchObject({runsPerMonth: 2, runsUsed: 2});
      // Making another flow is still allowed (plans limit runs, not flows).
      expect((await ann.post(`/site-api/boards/${board}/flows`, {name: 'Two', trigger: {kind: 'card_created'}, actions: [{type: 'comment', body: 'x'}]})).status).toBe(201);
    });

    it('parallel card creates never spend more runs than the plan allows', async () => {
      const ids = await Promise.all(Array.from({length: 6}, (_, i) => addCard(`P${i}`)));
      expect(await runs()).toBe(2);
      const done = await Promise.all(ids.map(comments));
      expect(done.reduce((n, x) => n + x, 0)).toBe(2);
    });

    it('a card that does not pass the conditions spends no run', async () => {
      await db.flow.deleteMany({where: {boardId: board}});
      const label = (await ann.post(`/site-api/boards/${board}/labels`, {name: 'Only', colorHex: '#ff0000'})).json.label.id;
      expect(
        (await ann.post(`/site-api/boards/${board}/flows`, {name: 'Cond', trigger: {kind: 'card_created'}, conditions: {labelId: label}, actions: [{type: 'comment', body: 'x'}]})).status,
      ).toBe(201);
      await addCard('No label');
      expect(await runs()).toBe(0);
    });
  });
});
