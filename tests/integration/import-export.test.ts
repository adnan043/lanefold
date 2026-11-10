import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

const card = (ext: string, extra: J = {}) => ({ext, lane: 'l1', title: `Card ${ext}`, desc: '', due: null, done: false, labels: [], checklists: [], comments: [], links: [], ...extra});

/** Trello import (start, chunks, retry) and board export (JSON, CSV): access, isolation, idempotency (real Postgres). */
describe.skipIf(!DATABASE_URL)('import and export (integration, real Postgres)', () => {
  let ann: Browser; // owns workspace A
  let bob: Browser; // owns workspace B, no seat in A
  let viewer: Browser; // viewer in A
  let wsA: number;
  const importId = 'import-test-0001';

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.41');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.42');
    viewer = await signedIn(app, 'vic@example.test', undefined, '203.0.113.43');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const vic = await db.user.findUniqueOrThrow({where: {email: 'vic@example.test'}, select: {id: true}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: vic.id, role: 'viewer'}});
  });

  const start = (b: Browser, key = importId) =>
    b.post(`/site-api/workspaces/${wsA}/import/trello/start`, {
      importId: key,
      name: 'Imported',
      lanes: [{ext: 'l1', name: 'Todo'}],
      labels: [{ext: 'lb1', name: 'Bug', color: '#ff0000'}],
      totalCards: 2,
    });

  it('requires sign-in, hides the workspace from outsiders (404) and refuses viewers (403)', async () => {
    const anon = new Browser(app);
    const counts = {lanes: 1, labels: 0, cards: 1, maxLaneCards: 1, checklists: 0, comments: 0};
    expect((await anon.post(`/site-api/workspaces/${wsA}/import/trello/dry-run`, counts)).status).toBe(401);
    expect((await bob.post(`/site-api/workspaces/${wsA}/import/trello/dry-run`, counts)).status).toBe(404);
    expect((await bob.post(`/site-api/workspaces/${wsA}/import/trello/start`, {importId, name: 'x', lanes: [], labels: [], totalCards: 0})).status).toBe(404);
    expect((await viewer.post(`/site-api/workspaces/${wsA}/import/trello/dry-run`, counts)).status).toBe(403);
    expect((await start(viewer)).status).toBe(403);
    expect(await db.board.count({where: {workspaceId: wsA}})).toBe(0);
  });

  it('dry run writes nothing and lists the reasons an import would be refused', async () => {
    const ok = await ann.post(`/site-api/workspaces/${wsA}/import/trello/dry-run`, {lanes: 1, labels: 0, cards: 2, maxLaneCards: 2, checklists: 0, comments: 0});
    expect(ok.status).toBe(200);
    expect(ok.json.canImport).toBe(true);
    const big = await ann.post(`/site-api/workspaces/${wsA}/import/trello/dry-run`, {lanes: 51, labels: 0, cards: 10, maxLaneCards: 501, checklists: 0, comments: 0});
    expect(big.json.canImport).toBe(false);
    expect((big.json.problems as J[]).map(p => p.code)).toEqual(expect.arrayContaining(['too_many_lanes', 'lane_full']));
    expect((await ann.post(`/site-api/workspaces/${wsA}/import/trello/dry-run`, {lanes: 'x'})).status).toBe(422);
    expect(await db.board.count({where: {workspaceId: wsA}})).toBe(0);
  });

  it('imports a board in chunks and a retried start or chunk duplicates nothing', async () => {
    const first = await start(ann);
    expect(first.status).toBe(201);
    const boardId = (first.json.board as J).id as number;
    const again = await start(ann);
    expect(again.status).toBe(200);
    expect(again.json.resumed).toBe(true);
    expect((again.json.board as J).id).toBe(boardId);
    expect(await db.board.count({where: {workspaceId: wsA}})).toBe(1);

    const chunk = {
      importId,
      cards: [
        card('c1', {labels: ['lb1'], checklists: [{name: 'Steps', items: [{text: 'one', done: true}, {text: 'two', done: false}]}], comments: [{by: 'Zed', at: '2024-01-02T03:04:05.000Z', text: 'hello'}], links: [{name: 'Doc', url: 'https://example.com/d'}]}),
        card('c2'),
      ],
    };
    const done = await ann.post(`/site-api/boards/${boardId}/import/trello/cards`, chunk);
    expect(done.status).toBe(200);
    expect(done.json.created).toBe(2);
    const retry = await ann.post(`/site-api/boards/${boardId}/import/trello/cards`, chunk);
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({created: 0, skipped: 2});
    expect(await db.card.count({where: {boardId}})).toBe(2);
    expect(await db.checklistItem.count({where: {checklist: {card: {boardId}}}})).toBe(2);
    const comments = await db.comment.findMany({where: {card: {boardId}}, select: {bodyMd: true}});
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).toContain('Imported comment by Zed');

    // More cards than the start announced are refused.
    const extra = await ann.post(`/site-api/boards/${boardId}/import/trello/cards`, {importId, cards: [card('c3')]});
    expect(extra.status).toBe(409);
    expect(await db.card.count({where: {boardId}})).toBe(2);
  });

  it('rejects malformed chunks and unknown lanes with 422', async () => {
    const boardId = ((await start(ann)).json.board as J).id as number;
    expect((await ann.post(`/site-api/boards/${boardId}/import/trello/cards`, {importId, cards: []})).status).toBe(422);
    expect((await ann.post(`/site-api/boards/${boardId}/import/trello/cards`, {importId: 'x', cards: [card('c1')]})).status).toBe(422);
    expect((await ann.post(`/site-api/boards/${boardId}/import/trello/cards`, {importId, cards: [card('c1', {links: [{name: 'x', url: 'javascript:alert(1)'}]})]})).status).toBe(422);
    expect((await ann.post(`/site-api/boards/${boardId}/import/trello/cards`, {importId, cards: [card('c1', {lane: 'nope'})]})).status).toBe(422);
    expect(await db.card.count({where: {boardId}})).toBe(0);
  });

  it("another workspace's user, and another person's import key, get 404 on chunks", async () => {
    const boardId = ((await start(ann)).json.board as J).id as number;
    const body = {importId, cards: [card('c1')]};
    expect((await bob.post(`/site-api/boards/${boardId}/import/trello/cards`, body)).status).toBe(404);
    // Imported boards are private: a workspace viewer with no seat cannot see it (404); with a viewer seat it is visible but read-only (403).
    expect((await viewer.post(`/site-api/boards/${boardId}/import/trello/cards`, body)).status).toBe(404);
    const vicId = (await db.user.findUniqueOrThrow({where: {email: 'vic@example.test'}, select: {id: true}})).id;
    await db.boardMember.create({data: {boardId, workspaceId: wsA, userId: vicId, role: 'viewer'}});
    expect((await viewer.post(`/site-api/boards/${boardId}/import/trello/cards`, body)).status).toBe(403);
    // A member of A who did not start this import cannot feed it.
    const mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.44');
    const miaRow = await db.user.findUniqueOrThrow({where: {email: 'mia@example.test'}, select: {id: true}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: miaRow.id, role: 'member'}});
    await db.boardMember.create({data: {boardId, workspaceId: wsA, userId: miaRow.id, role: 'member'}});
    expect((await mia.post(`/site-api/boards/${boardId}/import/trello/cards`, body)).status).toBe(404);
    expect(await db.card.count({where: {boardId}})).toBe(0);
  });

  describe('export', () => {
    let boardId: number;
    beforeEach(async () => {
      boardId = ((await start(ann)).json.board as J).id as number;
      await ann.post(`/site-api/boards/${boardId}/import/trello/cards`, {
        importId,
        cards: [card('c1', {title: '=HYPERLINK("http://evil.test")', labels: ['lb1']}), card('c2')],
      });
    });

    it('streams JSON and CSV to a board admin; CSV defuses formulas; downloads are private and nosniff', async () => {
      const json = await ann.get(`/site-api/boards/${boardId}/export.json`);
      expect(json.status).toBe(200);
      expect(json.headers.get('content-type')).toContain('application/json');
      expect(json.headers.get('content-disposition')).toMatch(/^attachment; filename="imported-\d{4}-\d{2}-\d{2}\.json"$/);
      expect(json.headers.get('cache-control')).toContain('no-store');
      expect(json.headers.get('x-content-type-options')).toBe('nosniff');
      expect(json.json.format).toBe('lanefold.board.v1');
      expect(JSON.stringify(json.json)).not.toMatch(/@example\.test/);

      const csv = await ann.get(`/site-api/boards/${boardId}/export.csv`);
      expect(csv.status).toBe(200);
      expect(csv.headers.get('content-type')).toContain('text/csv');
      const text = String(csv.json.text);
      expect(text.split('\r\n')[0]).toContain('"lane","card_id","title"');
      expect(text).toContain(`"'=HYPERLINK(`);
      expect(text).not.toContain(',"=HYPERLINK');
    });

    it('is 404 for another workspace, 403 below board admin, 401 signed out', async () => {
      expect((await bob.get(`/site-api/boards/${boardId}/export.json`)).status).toBe(404);
      expect((await bob.get(`/site-api/boards/${boardId}/export.csv`)).status).toBe(404);
      // Private board: no seat is 404; a viewer seat sees it but is below board admin (403).
      expect((await viewer.get(`/site-api/boards/${boardId}/export.json`)).status).toBe(404);
    const vicId = (await db.user.findUniqueOrThrow({where: {email: 'vic@example.test'}, select: {id: true}})).id;
      await db.boardMember.create({data: {boardId, workspaceId: wsA, userId: vicId, role: 'viewer'}});
      expect((await viewer.get(`/site-api/boards/${boardId}/export.json`)).status).toBe(403);
      expect((await viewer.get(`/site-api/boards/${boardId}/export.csv`)).status).toBe(403);
      expect((await new Browser(app).get(`/site-api/boards/${boardId}/export.csv`)).status).toBe(401);
    });

    it('records each export in the audit log', async () => {
      await ann.get(`/site-api/boards/${boardId}/export.json`);
      expect(await db.auditEvent.count({where: {action: 'board.exported'}})).toBe(1);
    });
  });
});
