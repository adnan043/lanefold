import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {MAX_CARD_TEMPLATES} from '../../src/server/entitlements';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Card templates: save from a card, apply to a card, workspace scoping, roles (real Postgres). */
describe.skipIf(!DATABASE_URL)('card templates (integration, real Postgres)', () => {
  let ann: Browser; // owner of A
  let mia: Browser; // member of A
  let vic: Browser; // viewer of A
  let bob: Browser; // owner of B
  let wsA: number;
  let boardA: number;
  let laneA: number;

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
    const made = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json;
    boardA = made.board.id;
    laneA = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes[0].id;
  });

  const url = () => `/site-api/workspaces/${wsA}/card-templates`;
  const newCard = async (title = 'Card') => (await ann.post(`/site-api/lanes/${laneA}/cards`, {title})).json.items[0].id as number;
  const payload = {title: 'Release {date}', description: 'Steps', priority: 'high', estimateMinutes: 45, checklists: [{title: 'Prep', items: ['One', 'Two']}], labels: ['Bug']};

  it('requires sign-in', async () => {
    const anon = new Browser(app);
    expect((await anon.get(url())).status).toBe(401);
    expect((await anon.post(url(), {name: 'x', payload})).status).toBe(401);
    expect((await anon.request('DELETE', '/site-api/card-templates/1')).status).toBe(401);
  });

  it('creates, lists, validates and deletes; viewers read but cannot write', async () => {
    expect((await mia.post(url(), {name: 'Release', payload})).status).toBe(201);
    expect((await ann.post(url(), {name: '', payload})).status).toBe(422);
    expect((await ann.post(url(), {name: 'ok', payload: {evil: 1}})).status).toBe(422);
    expect((await vic.post(url(), {name: 'nope', payload})).status).toBe(403);
    const list = await vic.get(url());
    expect(list.status).toBe(200);
    expect(list.json.items).toHaveLength(1);
    expect(list.json.canManage).toBe(false);
    const id = list.json.items[0].id as number;
    expect((await vic.request('DELETE', `/site-api/card-templates/${id}`)).status).toBe(403);
    expect((await ann.request('DELETE', `/site-api/card-templates/${id}`)).status).toBe(200); // admin deletes another's
    expect((await ann.request('DELETE', `/site-api/card-templates/${id}`)).status).toBe(404);
  });

  it('answers 404 to another workspace on every route', async () => {
    const id = (await ann.post(url(), {name: 'T', payload})).json.item.id as number;
    const card = await newCard();
    expect((await bob.get(url())).status).toBe(404);
    expect((await bob.post(url(), {name: 'x', payload})).status).toBe(404);
    expect((await bob.request('DELETE', `/site-api/card-templates/${id}`)).status).toBe(404);
    expect((await bob.post(`/site-api/cards/${card}/apply-template`, {templateId: id})).status).toBe(404);
    expect((await bob.post(`/site-api/cards/${card}/save-template`, {name: 'x'})).status).toBe(404);
    expect(await db.cardTemplate.count({where: {workspaceId: wsA}})).toBe(1);
  });

  it("never applies another workspace's template", async () => {
    const wsB = (await db.workspace.findFirstOrThrow({where: {name: 'Beta'}, select: {id: true}})).id;
    const foreign = (await bob.post(`/site-api/workspaces/${wsB}/card-templates`, {name: 'B only', payload})).json.item.id as number;
    const card = await newCard();
    expect((await ann.post(`/site-api/cards/${card}/apply-template`, {templateId: foreign})).status).toBe(404);
  });

  it('applies a template: fills empty fields, adds checklists and matching labels', async () => {
    const label = (await ann.post(`/site-api/boards/${boardA}/labels`, {name: 'bug', colorHex: '#FF0000'})).json;
    const labelId = (label.label?.id ?? label.id) as number;
    const id = (await ann.post(url(), {name: 'Release', payload})).json.item.id as number;
    const card = await newCard();
    const res = await mia.post(`/site-api/cards/${card}/apply-template`, {templateId: id});
    expect(res.status).toBe(200);
    const row = await db.card.findUniqueOrThrow({where: {id: card}, select: {descriptionMd: true, priority: true, estimateMinutes: true, checklistTotal: true, checklists: {select: {title: true, items: {select: {text: true}}}}, labels: {select: {labelId: true}}}});
    expect(row).toMatchObject({descriptionMd: 'Steps', priority: 'high', estimateMinutes: 45, checklistTotal: 2});
    expect(row.checklists[0]!.title).toBe('Prep');
    expect(row.checklists[0]!.items.map(i => i.text).sort()).toEqual(['One', 'Two']);
    expect(row.labels.map(l => l.labelId)).toEqual([labelId]);
    // A second apply never overwrites what the card already says.
    await db.card.update({where: {id: card}, data: {priority: 'low'}});
    await mia.post(`/site-api/cards/${card}/apply-template`, {templateId: id});
    expect((await db.card.findUniqueOrThrow({where: {id: card}})).priority).toBe('low');
    expect((await vic.post(`/site-api/cards/${card}/apply-template`, {templateId: id})).status).toBe(403);
  });

  it('saves a card as a template', async () => {
    const card = await newCard('Plan');
    await ann.post(`/site-api/cards/${card}/checklists`, {title: 'Todo'});
    const made = await ann.post(`/site-api/cards/${card}/save-template`, {name: 'From card'});
    expect(made.status).toBe(201);
    expect(made.json.item.payload).toMatchObject({title: 'Plan', checklists: [{title: 'Todo', items: []}]});
    expect((await vic.post(`/site-api/cards/${card}/save-template`, {name: 'x'})).status).toBe(403);
  });

  it('caps templates per workspace', async () => {
    await db.cardTemplate.createMany({data: Array.from({length: MAX_CARD_TEMPLATES}, (_, i) => ({workspaceId: wsA, kind: 'card', name: `t${i}`, payload: {}}))});
    expect((await ann.post(url(), {name: 'one more', payload})).status).toBe(409);
  });
  it('a guest (a seat on one board, no membership) cannot apply a workspace template to read it', async () => {
    const id = (await ann.post(url(), {name: 'Secret steps', payload})).json.template?.id ?? (await ann.get(url())).json.items[0].id;
    // bob owns another workspace and holds only a member seat on this board: a guest here.
    const bobId = (await db.user.findUniqueOrThrow({where: {email: 'bob@example.test'}, select: {id: true}})).id;
    await db.boardMember.create({data: {boardId: boardA, userId: bobId, workspaceId: wsA, role: 'member'}});
    const card = await newCard('Guest card');
    expect((await bob.get(`/site-api/boards/${boardA}`)).json.board.canWrite).toBe(true); // the seat really writes
    expect((await bob.post(`/site-api/cards/${card}/apply-template`, {templateId: Number(id)})).status).toBe(404);
    const detail = await ann.get(`/site-api/cards/${card}/detail`);
    expect(JSON.stringify(detail.json)).not.toContain('Steps');
    expect((await mia.post(`/site-api/cards/${card}/apply-template`, {templateId: Number(id)})).status).toBe(200); // a member still can
  });
});
