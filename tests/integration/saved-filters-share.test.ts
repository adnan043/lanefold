import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {MAX_SHARED_PER_BOARD} from '../../src/server/routes/saved-filters';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Sharing saved filters with the board: who sees, who may change, caps, ids, isolation (real Postgres). */
describe.skipIf(!DATABASE_URL)('saved filters, shared with the board (integration, real Postgres)', () => {
  let ann: Browser; // owner of workspace A (board admin)
  let mia: Browser; // member of A
  let vic: Browser; // viewer of A
  let bob: Browser; // owns workspace B, no seat in A
  let wsA: number;
  let boardA: number;
  let labelA: number;
  let miaId: number;
  let bobId: number;
  const url = '/site-api/boards';

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.72');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.73');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.74');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    for (const [email, role] of [['vic@example.test', 'viewer'], ['mia@example.test', 'member']] as const) {
      const u = await db.user.findUniqueOrThrow({where: {email}, select: {id: true}});
      await db.workspaceMember.create({data: {workspaceId: wsA, userId: u.id, role}});
    }
    miaId = (await db.user.findUniqueOrThrow({where: {email: 'mia@example.test'}, select: {id: true}})).id;
    bobId = (await db.user.findUniqueOrThrow({where: {email: 'bob@example.test'}, select: {id: true}})).id;
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
    labelA = (await db.label.create({data: {boardId: boardA, workspaceId: wsA, name: 'Bug', colorHex: '#aa0000'}, select: {id: true}})).id;
  });

  const save = (who: Browser, name: string, scope?: 'private' | 'board', filter: unknown = {priority: 'urgent'}, board = boardA) =>
    who.post(`${url}/${board}/saved-filters`, {name, filter, ...(scope ? {scope} : {})});
  const list = async (who: Browser, board = boardA) => (await who.get(`${url}/${board}/saved-filters`)).json.items as J[];
  const patch = (who: Browser, id: number, body: unknown) => who.request('PATCH', `/site-api/saved-filters/${id}`, body);
  const del = (who: Browser, id: number) => who.request('DELETE', `/site-api/saved-filters/${id}`);

  it('shows a shared filter to everyone with a seat, with the author as a name only, and keeps private ones private', async () => {
    const shared = await save(ann, 'Team view', 'board');
    expect(shared.status).toBe(201);
    expect(shared.json.item).toMatchObject({scope: 'board', mine: true, author: {name: 'ann'}});
    await save(ann, 'Only me');
    for (const who of [mia, vic]) {
      const items = await list(who);
      expect(items.map(i => i.name)).toEqual(['Team view']);
      expect(items[0]).toMatchObject({scope: 'board', mine: false, author: {name: 'ann'}});
    }
    expect((await list(ann)).map(i => i.name)).toEqual(['Only me', 'Team view']);
    const raw = JSON.stringify([await list(mia), await list(vic), shared.json]);
    expect(raw).not.toContain('example.test');
  });

  it('answers the viewer: can use shared filters and keep private ones, cannot share', async () => {
    const answer = await vic.get(`${url}/${boardA}/saved-filters`);
    expect(answer.json).toMatchObject({canShare: false, canAdmin: false});
    expect((await save(vic, 'Mine', 'board')).status).toBe(403);
    const priv = await save(vic, 'Mine');
    expect(priv.status).toBe(201);
    expect((await patch(vic, priv.json.item.id, {scope: 'board'})).status).toBe(403);
    expect((await mia.get(`${url}/${boardA}/saved-filters`)).json).toMatchObject({canShare: true, canAdmin: false});
    expect((await ann.get(`${url}/${boardA}/saved-filters`)).json).toMatchObject({canShare: true, canAdmin: true});
  });

  it('lets a member share and unshare their own filter', async () => {
    const made = (await save(mia, 'Mine')).json.item.id as number;
    expect((await list(ann)).map(i => i.name)).toEqual([]);
    const shared = await patch(mia, made, {scope: 'board'});
    expect(shared.status).toBe(200);
    expect(shared.json.item).toMatchObject({scope: 'board', mine: true});
    expect((await list(ann)).map(i => i.name)).toEqual(['Mine']);
    expect((await patch(mia, made, {scope: 'private'})).status).toBe(200);
    expect((await list(ann)).map(i => i.name)).toEqual([]);
  });

  it("lets only the author or a board admin rename, unshare or delete a shared filter; a private one of someone else does not exist", async () => {
    const miaShared = (await save(mia, 'Mia shared', 'board')).json.item.id as number;
    const annShared = (await save(ann, 'Ann shared', 'board')).json.item.id as number;
    const miaPrivate = (await save(mia, 'Mia private')).json.item.id as number;
    // another member who can see it may only use it
    expect((await patch(mia, annShared, {name: 'x'})).status).toBe(403);
    expect((await patch(mia, annShared, {scope: 'private'})).status).toBe(403);
    expect((await del(mia, annShared)).status).toBe(403);
    expect((await del(vic, miaShared)).status).toBe(403);
    // a board admin manages a member's shared one
    expect((await patch(ann, miaShared, {name: 'Renamed by admin'})).json.item.name).toBe('Renamed by admin');
    // but not a member's private one: it does not exist for them
    expect((await patch(ann, miaPrivate, {name: 'x'})).status).toBe(404);
    expect((await del(ann, miaPrivate)).status).toBe(404);
    expect((await db.savedFilter.findUniqueOrThrow({where: {id: miaPrivate}})).name).toBe('Mia private');
    // an admin unshares: it turns private for its author
    expect((await patch(ann, miaShared, {scope: 'private'})).status).toBe(200);
    expect((await list(vic)).map(i => i.name)).toEqual(['Ann shared']);
    expect((await list(mia)).map(i => i.name).sort()).toEqual(['Ann shared', 'Mia private', 'Renamed by admin']);
    // an admin deletes a shared one; the author deletes their own
    expect((await del(ann, annShared)).status).toBe(200);
    expect((await del(mia, miaShared)).status).toBe(200);
  });

  it("answers 404 to another workspace's user on every route, for shared filters too", async () => {
    const id = (await save(ann, 'Team', 'board')).json.item.id as number;
    expect((await bob.get(`${url}/${boardA}/saved-filters`)).status).toBe(404);
    expect((await save(bob, 'x', 'board')).status).toBe(404);
    expect((await patch(bob, id, {scope: 'private'})).status).toBe(404);
    expect((await del(bob, id)).status).toBe(404);
    expect((await db.savedFilter.findUniqueOrThrow({where: {id}})).scope).toBe('board');
  });

  it('hides a shared filter of a private board from a member without a seat', async () => {
    const priv = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Secret', visibility: 'private'})).json.board.id as number;
    const id = (await save(ann, 'Secret view', 'board', {priority: 'high'}, priv)).json.item.id as number;
    expect((await mia.get(`${url}/${priv}/saved-filters`)).status).toBe(404);
    expect((await patch(mia, id, {name: 'x'})).status).toBe(404);
    expect((await del(mia, id)).status).toBe(404);
  });

  it('checks the ids of a shared filter against this board and workspace, but keeps private ones as before', async () => {
    const otherBoard = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Other', lanes: ['x']})).json.board.id as number;
    const otherLabel = (await db.label.create({data: {boardId: otherBoard, workspaceId: wsA, name: 'Elsewhere', colorHex: '#00aa00'}, select: {id: true}})).id;
    expect((await save(ann, 'ok', 'board', {labelIds: [labelA], memberIds: [miaId]})).status).toBe(201);
    for (const filter of [{labelIds: [otherLabel]}, {labelIds: [999999]}, {memberIds: [bobId]}, {labelIds: [labelA], memberIds: [999999]}]) {
      const r = await save(ann, 'bad', 'board', filter);
      expect(r.status, JSON.stringify(filter)).toBe(422);
      expect(r.json.fields.filter).toBeTruthy();
    }
    // a private filter keeps its ids (they only select cards); sharing it later is checked
    const priv = await save(ann, 'private', undefined, {labelIds: [otherLabel]});
    expect(priv.status).toBe(201);
    expect((await patch(ann, priv.json.item.id, {scope: 'board'})).status).toBe(422);
    expect((await list(mia)).map(i => i.name)).toEqual(['ok']);
  });

  it('validates the scope and the patch body', async () => {
    expect((await save(ann, 'x', 'everyone' as never)).status).toBe(422);
    const id = (await save(ann, 'x')).json.item.id as number;
    expect((await patch(ann, id, {})).status).toBe(422);
    expect((await patch(ann, id, {scope: 'public'})).status).toBe(422);
    expect((await patch(ann, id, {name: ''})).status).toBe(422);
    expect((await patch(ann, id, {name: 'renamed'})).json.item.name).toBe('renamed');
  });

  it('caps the shared filters per board, and a refused one is not stored', async () => {
    for (let i = 0; i < 20; i++) expect((await save(ann, `a${i}`, 'board')).status).toBe(201);
    for (let i = 0; i < MAX_SHARED_PER_BOARD - 20; i++) expect((await save(mia, `m${i}`, 'board')).status).toBe(201);
    const over = await save(mia, 'one too many', 'board');
    expect(over.status).toBe(409);
    expect(over.json.error).toBe('limit_reached');
    const priv = (await save(mia, 'private ok')).json.item.id as number;
    expect((await patch(mia, priv, {scope: 'board'})).status).toBe(409);
    expect(await db.savedFilter.count({where: {boardId: boardA, scope: 'board'}})).toBe(MAX_SHARED_PER_BOARD);
    // unsharing frees a place
    const first = (await list(ann)).find(i => i.name === 'a0')!;
    expect((await patch(ann, first.id, {scope: 'private'})).status).toBe(200);
    expect((await patch(mia, priv, {scope: 'board'})).status).toBe(200);
  });

  it('shows no author name once the author left the workspace', async () => {
    await save(mia, 'Mia shared', 'board');
    await db.workspaceMember.delete({where: {workspaceId_userId: {workspaceId: wsA, userId: miaId}}});
    const items = await list(vic);
    expect(items).toHaveLength(1);
    expect(items[0].author).toEqual({name: null});
  });

  it('refuses to share on an archived board but still lets the author delete', async () => {
    const id = (await save(mia, 'Shared', 'board')).json.item.id as number;
    const priv = (await save(mia, 'Priv')).json.item.id as number;
    await ann.request('PATCH', `${url}/${boardA}`, {archived: true});
    expect((await save(mia, 'later', 'board')).status).toBe(409);
    expect((await patch(mia, priv, {scope: 'board'})).status).toBe(409);
    expect((await del(mia, id)).status).toBe(200);
  });
});
