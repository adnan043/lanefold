import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/** Everything inside a card (Phase 2): isolation between workspaces, roles, counters, caps (real Postgres). */
describe.skipIf(!DATABASE_URL)('card detail (integration, real Postgres)', () => {
  let ann: Browser; // owns workspace A
  let bob: Browser; // owns workspace B, no seat in A
  let viewer: Browser; // viewer in A
  let wsA: number;
  let boardA: number;
  let lane: number;
  let card: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.31');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.32');
    viewer = await signedIn(app, 'vic@example.test', undefined, '203.0.113.33');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const vic = await db.user.findUniqueOrThrow({where: {email: 'vic@example.test'}, select: {id: true}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: vic.id, role: 'viewer'}});
    boardA = (await ann.post(`/site-api/workspaces/${wsA}/boards`, {name: 'Roadmap', lanes: ['To do']})).json.board.id;
    lane = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes[0].id;
    card = (await ann.post(`/site-api/lanes/${lane}/cards`, {title: 'Ship it'})).json.items[0].id;
  });

  const counters = async () => (await ann.get(`/site-api/cards/${card}/detail`)).json.card as J;

  it("another workspace's user gets 404 on every card-detail route", async () => {
    const label = (await ann.post(`/site-api/boards/${boardA}/labels`, {name: 'Bug', colorHex: '#ff0000'})).json.label.id;
    const list = (await ann.post(`/site-api/cards/${card}/checklists`, {title: 'Todo'})).json.checklist.id;
    const item = (await ann.post(`/site-api/checklists/${list}/items`, {text: 'one'})).json.items[0].id;
    const comment = (await ann.post(`/site-api/cards/${card}/comments`, {body: 'hello'})).json.comment.id;
    const link = (await ann.post(`/site-api/cards/${card}/attachments/link`, {url: 'https://example.com/a'})).json.attachment.id;
    const reads = [`/cards/${card}/detail`, `/cards/${card}/activity`, `/cards/${card}/people`, `/cards/${card}/comments`, `/attachments/${link}/view`];
    for (const path of reads) expect((await bob.get(`/site-api${path}`)).status, path).toBe(404);
    const writes: [string, string, unknown][] = [
      ['PATCH', `/cards/${card}/details`, {title: 'x'}],
      ['POST', `/boards/${boardA}/labels`, {name: 'x', colorHex: '#00ff00'}],
      ['PATCH', `/labels/${label}`, {name: 'x'}],
      ['DELETE', `/labels/${label}`, undefined],
      ['PUT', `/cards/${card}/labels/${label}`, {}],
      ['PUT', `/cards/${card}/members/1`, {}],
      ['POST', `/cards/${card}/checklists`, {title: 'x'}],
      ['PATCH', `/checklists/${list}`, {title: 'x'}],
      ['DELETE', `/checklists/${list}`, undefined],
      ['POST', `/checklists/${list}/items`, {text: 'x'}],
      ['PATCH', `/checklist-items/${item}`, {done: true}],
      ['DELETE', `/checklist-items/${item}`, undefined],
      ['POST', `/cards/${card}/comments`, {body: 'x'}],
      ['PATCH', `/comments/${comment}`, {body: 'x'}],
      ['DELETE', `/comments/${comment}`, undefined],
      ['POST', `/cards/${card}/attachments/link`, {url: 'https://example.com'}],
      ['POST', `/cards/${card}/attachments/upload`, {name: 'a.png', contentType: 'image/png', size: 10}],
      ['POST', `/attachments/${link}/complete`, {}],
      ['PATCH', `/attachments/${link}`, {name: 'x'}],
      ['DELETE', `/attachments/${link}`, undefined],
      ['PUT', `/cards/${card}/cover`, {attachmentId: null}],
    ];
    for (const [method, path, body] of writes) expect((await bob.request(method, `/site-api${path}`, body)).status, `${method} ${path}`).toBe(404);
    const after = await counters();
    expect([after.title, after.checklistTotal, after.commentCount, after.attachmentCount]).toEqual(['Ship it', 1, 1, 1]);
  });

  it('board faces: labels capped at 4, members as names only, in the board, delta and lane answers', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      const id = (await ann.post(`/site-api/boards/${boardA}/labels`, {name, colorHex: '#336699'})).json.label.id;
      expect((await ann.request('PUT', `/site-api/cards/${card}/labels/${id}`, {})).status).toBe(200);
    }
    const annId = (await db.user.findUniqueOrThrow({where: {email: 'ann@example.test'}, select: {id: true}})).id;
    expect((await ann.request('PUT', `/site-api/cards/${card}/members/${annId}`, {})).status).toBe(200);
    const face = (await ann.get(`/site-api/boards/${boardA}`)).json.lanes[0].cards[0] as J;
    expect(face.labels).toHaveLength(4);
    expect(face.labelCount).toBe(5);
    expect(face.members).toEqual([{id: annId, name: expect.any(String)}]);
    expect(face.memberCount).toBe(1);
    expect(face.coverAttachmentId).toBeNull();
    expect(JSON.stringify(face)).not.toContain('@example.test');
    expect((await ann.get(`/site-api/lanes/${lane}/cards`)).json.items[0].labels).toHaveLength(4);
    expect((await ann.get(`/site-api/boards/${boardA}/changes?since=0`)).json.cards[0].labelCount).toBe(5);
    expect((await bob.get(`/site-api/boards/${boardA}`)).status).toBe(404);
  });

  it('keeps a viewer read-only', async () => {
    expect((await viewer.get(`/site-api/cards/${card}/detail`)).json.canWrite).toBe(false);
    expect((await viewer.post(`/site-api/cards/${card}/comments`, {body: 'x'})).status).toBe(403);
    expect((await viewer.request('PATCH', `/site-api/cards/${card}/details`, {title: 'x'})).status).toBe(403);
    expect((await viewer.post(`/site-api/boards/${boardA}/labels`, {name: 'x', colorHex: '#00ff00'})).status).toBe(403);
  });

  it('edits fields, rejects bad dates and keeps start before due', async () => {
    const ok = await ann.request('PATCH', `/site-api/cards/${card}/details`, {descriptionMd: '# Hi', estimateMinutes: 90, startDate: '2026-01-02', dueDate: '2026-01-05', priority: 'high'});
    expect(ok.status).toBe(200);
    const got = await counters();
    expect([got.descriptionMd, got.estimateMinutes, got.startDate, got.dueDate, got.priority]).toEqual(['# Hi', 90, '2026-01-02', '2026-01-05', 'high']);
    const bad = await ann.request('PATCH', `/site-api/cards/${card}/details`, {startDate: '2026-02-01'});
    expect(bad.status).toBe(422);
    expect(bad.json.fields.startDate).toBeTruthy();
    expect((await ann.request('PATCH', `/site-api/cards/${card}/details`, {dueDate: '2026-02-30'})).status).toBe(422);
    expect((await ann.request('PATCH', `/site-api/cards/${card}/details`, {estimateMinutes: 0})).status).toBe(422);
  });

  it('labels: any colour, one per board, only labels of this board go on a card', async () => {
    expect((await ann.post(`/site-api/boards/${boardA}/labels`, {name: 'x', colorHex: 'red'})).status).toBe(422);
    const made = await ann.post(`/site-api/boards/${boardA}/labels`, {name: 'Bug', colorHex: '#12ab34'});
    expect(made.status).toBe(201);
    expect(made.json.label.colorHex).toBe('#12AB34');
    const id = made.json.label.id;
    expect((await ann.request('PUT', `/site-api/cards/${card}/labels/${id}`, {})).status).toBe(200);
    expect((await ann.get(`/site-api/cards/${card}/detail`)).json.labelIds).toEqual([id]);
    // A label of another workspace's board is "not found" for this card.
    const otherBoard = (await bob.get('/site-api/workspaces')).json.items[0].id;
    const bobBoard = (await bob.post(`/site-api/workspaces/${otherBoard}/boards`, {name: 'B'})).json.board.id;
    const foreign = (await bob.post(`/site-api/boards/${bobBoard}/labels`, {name: 'F', colorHex: '#000000'})).json.label.id;
    expect((await ann.request('PUT', `/site-api/cards/${card}/labels/${foreign}`, {})).status).toBe(404);
    expect((await ann.request('DELETE', `/site-api/labels/${id}`)).status).toBe(200);
    expect((await ann.get(`/site-api/cards/${card}/detail`)).json.labelIds).toEqual([]);
  });

  it('members: only workspace members who can see the board; names, never emails', async () => {
    const people = await ann.get(`/site-api/cards/${card}/people`);
    expect(JSON.stringify(people.json)).not.toContain('@');
    const annId = (await ann.get(`/site-api/cards/${card}/detail`)).json.me;
    expect((await ann.request('PUT', `/site-api/cards/${card}/members/${annId}`, {})).status).toBe(200);
    const bobUser = await db.user.findUniqueOrThrow({where: {email: 'bob@example.test'}, select: {id: true}});
    expect((await ann.request('PUT', `/site-api/cards/${card}/members/${bobUser.id}`, {})).status).toBe(404);
    expect((await ann.get(`/site-api/cards/${card}/detail`)).json.members).toHaveLength(1);
  });

  it('checklists keep the card counters exact', async () => {
    const list = (await ann.post(`/site-api/cards/${card}/checklists`, {title: 'Todo'})).json.checklist.id;
    const added = await ann.post(`/site-api/checklists/${list}/items`, {texts: ['a', 'b', 'c']});
    expect(added.status).toBe(201);
    const [a, b] = added.json.items as J[];
    expect((await counters()).checklistTotal).toBe(3);
    await ann.request('PATCH', `/site-api/checklist-items/${a.id}`, {done: true});
    await ann.request('PATCH', `/site-api/checklist-items/${a.id}`, {done: true}); // a double click does not double-count
    await ann.request('PATCH', `/site-api/checklist-items/${b.id}`, {done: true});
    expect(await counters()).toMatchObject({checklistTotal: 3, checklistDone: 2});
    await ann.request('DELETE', `/site-api/checklist-items/${b.id}`);
    expect(await counters()).toMatchObject({checklistTotal: 2, checklistDone: 1});
    await ann.request('DELETE', `/site-api/checklists/${list}`);
    expect(await counters()).toMatchObject({checklistTotal: 0, checklistDone: 0});
    expect((await ann.post(`/site-api/checklists/${list}/items`, {text: 'x'})).status).toBe(404);
  });

  it('comments: counters, mentions only of seat holders, edit and delete rules', async () => {
    const bobUser = await db.user.findUniqueOrThrow({where: {email: 'bob@example.test'}, select: {id: true}});
    const vicUser = await db.user.findUniqueOrThrow({where: {email: 'vic@example.test'}, select: {id: true}});
    const made = await ann.post(`/site-api/cards/${card}/comments`, {body: '@Vic hello', mentions: [vicUser.id, bobUser.id]});
    expect(made.status).toBe(201);
    expect((made.json.comment.mentions as J[]).map(m => m.id)).toEqual([vicUser.id]); // bob has no seat in A
    expect((await counters()).commentCount).toBe(1);
    expect((await ann.post(`/site-api/cards/${card}/comments`, {body: '   '})).status).toBe(422);
    const id = made.json.comment.id;
    expect((await viewer.request('PATCH', `/site-api/comments/${id}`, {body: 'x'})).status).toBe(403);
    expect((await ann.request('PATCH', `/site-api/comments/${id}`, {body: 'edited'})).json.comment.edited).toBe(true);
    expect((await ann.request('DELETE', `/site-api/comments/${id}`)).status).toBe(200);
    expect((await counters()).commentCount).toBe(0);
  });

  it('attachments: links count, bad addresses and file types are refused, delete follows', async () => {
    expect((await ann.post(`/site-api/cards/${card}/attachments/link`, {url: 'javascript:alert(1)'})).status).toBe(422);
    expect((await ann.post(`/site-api/cards/${card}/attachments/link`, {url: 'https://user:pw@example.com/'})).status).toBe(422);
    expect((await ann.post(`/site-api/cards/${card}/attachments/upload`, {name: 'x.html', contentType: 'text/html', size: 10})).status).toBe(422);
    const link = await ann.post(`/site-api/cards/${card}/attachments/link`, {url: 'https://example.com/spec', name: 'Spec'});
    expect(link.status).toBe(201);
    expect((await counters()).attachmentCount).toBe(1);
    expect((await ann.request('PATCH', `/site-api/attachments/${link.json.attachment.id}`, {name: 'Renamed'})).status).toBe(200);
    // A link has no file to view.
    expect((await ann.get(`/site-api/attachments/${link.json.attachment.id}/view`)).status).toBe(404);
    expect((await ann.request('DELETE', `/site-api/attachments/${link.json.attachment.id}`)).status).toBe(200);
    expect((await counters()).attachmentCount).toBe(0);
  });

  it('refuses SVG and HTML uploads', async () => {
    for (const contentType of ['image/svg+xml', 'text/html', 'application/xhtml+xml']) {
      const res = await ann.post(`/site-api/cards/${card}/attachments/upload`, {name: 'x', contentType, size: 10});
      expect(res.status, contentType).toBe(422);
    }
  });

  it('a read-only workspace still lets people delete an attachment and their own comment, and nothing else', async () => {
    const link = (await ann.post(`/site-api/cards/${card}/attachments/link`, {url: 'https://example.com/a'})).json.attachment.id;
    const comment = (await ann.post(`/site-api/cards/${card}/comments`, {body: 'hello'})).json.comment.id;
    await db.workspace.update({where: {id: wsA}, data: {memberCount: 11, graceUntil: new Date(Date.now() - 1000)}});
    const blocked = await ann.request('PATCH', `/site-api/cards/${card}/details`, {title: 'No'});
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe('workspace_read_only');
    expect((await ann.post(`/site-api/cards/${card}/comments`, {body: 'more'})).status).toBe(409);
    expect((await ann.request('DELETE', `/site-api/attachments/${link}`)).status).toBe(200);
    expect((await ann.request('DELETE', `/site-api/comments/${comment}`)).status).toBe(200);
    // Removing is still not open to outsiders or viewers.
    expect((await bob.request('DELETE', `/site-api/attachments/${link}`)).status).toBe(404);
  });

  it('details: a stale expectedRev answers 409 stale and changes nothing; the current one saves', async () => {
    const first = (await counters()).rev as string;
    expect((await ann.request('PATCH', `/site-api/cards/${card}/details`, {title: 'One', expectedRev: first})).status).toBe(200);
    const stale = await ann.request('PATCH', `/site-api/cards/${card}/details`, {title: 'Two', expectedRev: first});
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe('stale');
    expect((await counters()).title).toBe('One');
    const now = (await counters()).rev as string;
    expect((await ann.request('PATCH', `/site-api/cards/${card}/details`, {title: 'Two', expectedRev: now})).status).toBe(200);
    expect((await ann.request('PATCH', `/site-api/cards/${card}/details`, {title: 'Three', expectedRev: 'abc'})).status).toBe(422);
  });

  it('marking completed twice keeps the first completion time', async () => {
    await ann.request('PATCH', `/site-api/cards/${card}/details`, {completed: true});
    const first = (await db.card.findUniqueOrThrow({where: {id: card}, select: {completedAt: true}})).completedAt;
    expect(first).not.toBeNull();
    await ann.request('PATCH', `/site-api/cards/${card}/details`, {completed: true});
    expect((await db.card.findUniqueOrThrow({where: {id: card}, select: {completedAt: true}})).completedAt).toEqual(first);
  });

  it('a person who lost their seat on a private board is not notified of a comment', async () => {
    await signedIn(app, 'eve@example.test', undefined, '203.0.113.34');
    const eveRow = await db.user.findUniqueOrThrow({where: {email: 'eve@example.test'}, select: {id: true}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: eveRow.id, role: 'member'}});
    await db.cardWatcher.create({data: {cardId: card, userId: eveRow.id}});
    await db.board.update({where: {id: boardA}, data: {visibility: 'private'}});
    await ann.post(`/site-api/cards/${card}/comments`, {body: 'secret plans'});
    expect(await db.notification.count({where: {userId: eveRow.id}})).toBe(0);
  });

  it('every write bumps the board rev and leaves an activity row', async () => {
    const before = (await ann.get(`/site-api/boards/${boardA}/rev`)).json.rev;
    await ann.post(`/site-api/cards/${card}/comments`, {body: 'hi'});
    expect((await ann.get(`/site-api/boards/${boardA}/rev`)).json.rev).not.toBe(before);
    const log = await ann.get(`/site-api/cards/${card}/activity`);
    expect((log.json.items as J[]).map(i => i.kind)).toContain('comment.created');
  });
});
