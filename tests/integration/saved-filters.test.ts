import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {MAX_PER_BOARD} from '../../src/server/routes/saved-filters';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Saved filters: personal, per board, scoped to workspace seats (real Postgres). */
describe.skipIf(!DATABASE_URL)('saved filters (integration, real Postgres)', () => {
  let ann: Browser; // owns workspace A
  let mia: Browser; // member of A
  let vic: Browser; // viewer of A
  let bob: Browser; // owns workspace B, no seat in A
  let wsA: number;
  let boardA: number;
  const url = `/site-api/boards`;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.61');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.62');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.63');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.64');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    for (const [email, role] of [['vic@example.test', 'viewer'], ['mia@example.test', 'member']] as const) {
      const u = await db.user.findUniqueOrThrow({where: {email}, select: {id: true}});
      await db.workspaceMember.create({data: {workspaceId: wsA, userId: u.id, role}});
    }
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
  });

  const save = (who: Browser, name = 'Urgent', filter: unknown = {priority: 'urgent', text: 'bug'}) =>
    who.post(`${url}/${boardA}/saved-filters`, {name, filter});

  it('requires sign-in', async () => {
    const anon = new Browser(app);
    expect((await anon.get(`${url}/${boardA}/saved-filters`)).status).toBe(401);
    expect((await anon.post(`${url}/${boardA}/saved-filters`, {name: 'x', filter: {text: 'a'}})).status).toBe(401);
    expect((await anon.request('DELETE', '/site-api/saved-filters/1')).status).toBe(401);
  });

  it('lets an owner, a member and a viewer each keep their own filters, and see only those', async () => {
    for (const who of [ann, mia, vic]) expect((await save(who, 'Mine')).status).toBe(201);
    await save(mia, 'Second');
    const list = await mia.get(`${url}/${boardA}/saved-filters`);
    expect(list.status).toBe(200);
    expect((list.json.items as J[]).map(i => i.name)).toEqual(['Second', 'Mine']);
    expect(list.json.items[1].filter).toEqual({priority: 'urgent', text: 'bug'});
    expect(((await vic.get(`${url}/${boardA}/saved-filters`)).json.items as J[]).map(i => i.name)).toEqual(['Mine']);
  });

  it("answers 404 to another workspace's user on every route", async () => {
    const made = (await save(ann)).json.item.id as number;
    expect((await bob.get(`${url}/${boardA}/saved-filters`)).status).toBe(404);
    expect((await save(bob)).status).toBe(404);
    expect((await bob.request('PATCH', `/site-api/saved-filters/${made}`, {name: 'x'})).status).toBe(404);
    expect((await bob.request('DELETE', `/site-api/saved-filters/${made}`)).status).toBe(404);
  });

  it("answers 404 for a teammate's filter and leaves it untouched", async () => {
    const made = (await save(ann, 'Private to ann')).json.item.id as number;
    expect((await mia.request('PATCH', `/site-api/saved-filters/${made}`, {name: 'Hijacked'})).status).toBe(404);
    expect((await mia.request('DELETE', `/site-api/saved-filters/${made}`)).status).toBe(404);
    const row = await db.savedFilter.findUniqueOrThrow({where: {id: made}});
    expect(row.name).toBe('Private to ann');
  });

  it('renames and deletes my own filter', async () => {
    const made = (await save(mia, 'Old')).json.item.id as number;
    const renamed = await mia.request('PATCH', `/site-api/saved-filters/${made}`, {name: '  New name  '});
    expect(renamed.status).toBe(200);
    expect(renamed.json.item.name).toBe('New name');
    expect((await mia.request('PATCH', `/site-api/saved-filters/${made}`, {name: ''})).status).toBe(422);
    expect((await mia.request('DELETE', `/site-api/saved-filters/${made}`)).status).toBe(200);
    expect((await mia.request('DELETE', `/site-api/saved-filters/${made}`)).status).toBe(404);
    expect((await mia.get(`${url}/${boardA}/saved-filters`)).json.items).toHaveLength(0);
  });

  it('validates the name and the filter strictly', async () => {
    const bad: unknown[] = [
      {name: '', filter: {text: 'a'}},
      {name: 'x'.repeat(61), filter: {text: 'a'}},
      {name: 'ok', filter: {}},
      {name: 'ok', filter: {unknown: 1}},
      {name: 'ok', filter: {priority: 'nope'}},
      {name: 'ok', filter: {due: 'someday'}},
      {name: 'ok', filter: {dueFrom: '2026-02-30'}},
      {name: 'ok', filter: {dueTo: 'tomorrow'}},
      {name: 'ok', filter: {dueFrom: '2026-12-10', dueTo: '2026-12-01'}},
      {name: 'ok', filter: {labelIds: ['1']}},
      {name: 'ok', filter: {labelIds: Array.from({length: 21}, (_, i) => i + 1)}},
      {name: 'ok', filter: {text: 'x'.repeat(81)}},
      {name: 'ok', filter: 'text'},
      {name: 'ok'},
    ];
    for (const body of bad) expect((await ann.post(`${url}/${boardA}/saved-filters`, body)).status, JSON.stringify(body)).toBe(422);
    expect((await ann.get(`${url}/${boardA}/saved-filters`)).json.items).toHaveLength(0);
    const ok = await ann.post(`${url}/${boardA}/saved-filters`, {name: 'ok', filter: {labelIds: [3, 3, 4], due: 'overdue', memberIds: [], text: ''}});
    expect(ok.status).toBe(201);
    // The old single `due` is stored as the `dues` list the filter bar uses.
    expect(ok.json.item.filter).toEqual({labelIds: [3, 4], dues: ['overdue']});
  });

  it('caps the filters per person per board, and the cap is per person', async () => {
    for (let i = 0; i < MAX_PER_BOARD; i++) expect((await save(mia, `f${i}`)).status).toBe(201);
    const over = await save(mia, 'one too many');
    expect(over.status).toBe(409);
    expect(over.json.error).toBe('limit_reached');
    expect((await save(vic, 'still fine')).status).toBe(201);
  });

  it('refuses to save or rename on an archived board but still lets me delete', async () => {
    const made = (await save(mia)).json.item.id as number;
    await ann.request('PATCH', `${url}/${boardA}`, {archived: true});
    expect((await save(mia, 'later')).status).toBe(409);
    expect((await mia.request('PATCH', `/site-api/saved-filters/${made}`, {name: 'x'})).status).toBe(409);
    expect((await mia.get(`${url}/${boardA}/saved-filters`)).status).toBe(200);
    expect((await mia.request('DELETE', `/site-api/saved-filters/${made}`)).status).toBe(200);
  });

  it('hides a private board from a member without a seat, even for a filter they saved before', async () => {
    const priv = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', visibility: 'private'})).json.board.id as number;
    expect((await mia.get(`${url}/${priv}/saved-filters`)).status).toBe(404);
    expect((await mia.post(`${url}/${priv}/saved-filters`, {name: 'x', filter: {text: 'a'}})).status).toBe(404);
    const mineUser = await db.user.findUniqueOrThrow({where: {email: 'mia@example.test'}, select: {id: true}});
    const stale = await db.savedFilter.create({data: {userId: mineUser.id, boardId: priv, workspaceId: wsA, name: 'stale', filter: {text: 'a'}}, select: {id: true}});
    expect((await mia.request('DELETE', `/site-api/saved-filters/${stale.id}`)).status).toBe(404);
  });
});
