import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {inRequestScope} from '../../src/platform/request-scope';
import {app} from '../../src/server/app';
import {invalidateAppSettings} from '../../src/server/entitlements';
import {sweepGrace} from '../../src/server/jobs/sweeps';
import {applyWorkspacePlan} from '../../src/server/payments-hooks';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

type J = Record<string, any>;

const membership = (customerRef: string, price: string, status: 'active' | 'canceled') => ({
  id: `sub_${price}_journey`,
  price,
  email: null,
  status,
  currentPeriodEnd: null,
  accessEndsAt: null,
  customerRef,
  checkoutId: null,
});

/**
 * The whole product path through the real Hono app, against a real Postgres, as ONE story:
 * workspace -> board -> cards -> card detail -> invites on the free plan -> roles -> chat -> search, My Day, Inbox
 * -> sandbox checkout and plan hook -> downgrade and grace -> read-only -> leaving.
 * The steps share state and run in order; each one asserts what the previous one left behind.
 */
describe.skipIf(!DATABASE_URL)('Lanefold journey (integration, real Postgres)', () => {
  let ann: Browser; // owner, creates everything
  let bob: Browser; // joins by link
  let cy: Browser; // joins by link
  let dee: Browser; // turned away at the free cap, joins after the upgrade
  let ids: Record<string, number>;
  let ws: number;
  let board: number;
  let lane1: number;
  let lane2: number;
  let lane3: number;
  let cards: J[];
  let general: number;
  let linkToken: string;
  const realFetch = globalThis.fetch;
  const checkoutBodies: J[] = [];

  const rev = async () => BigInt((await ann.get(`/site-api/boards/${board}/rev`)).json.rev as string);
  const laneTitles = async (lane: number) => ((await ann.get(`/site-api/lanes/${lane}/cards`)).json.items as J[]).map(c => c.title);
  const boardLanes = async () => (await ann.get(`/site-api/boards/${board}`)).json.lanes as J[];
  const accept = (b: Browser, token: string) => b.post('/site-api/invites/accept', {token});
  const memberCount = async () => (await db.workspace.findUniqueOrThrow({where: {id: ws}, select: {memberCount: true}})).memberCount;

  beforeAll(async () => {
    configureEnv();
    await resetDatabase();
    // Plan numbers this story relies on: free holds 3 people, paid is billed.
    await db.planLimit.updateMany({where: {plan: 'free'}, data: {maxMembers: 3}});
    await db.appSettings.update({where: {id: 1}, data: {billingMode: 'PAID', graceDays: 14}});
    await invalidateAppSettings();
    // Sandbox payments: the platform answers a checkout like a test-mode gateway would.
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/site/v1/payments/checkout') && (init?.method ?? 'GET') === 'POST') {
        checkoutBodies.push(JSON.parse(String(init?.body ?? '{}')) as J);
        return new Response(JSON.stringify({data: {id: 'pcs_journey_sandbox', mode: 'test', embedded: {kind: 'redirect', url: 'https://pay.example.test/pcs_journey_sandbox'}}}), {
          status: 200,
        });
      }
      return realFetch(input, init);
    };
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.121');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.122');
    cy = await signedIn(app, 'cy@example.test', undefined, '203.0.113.123');
    dee = await signedIn(app, 'dee@example.test', undefined, '203.0.113.124');
    ids = {ann: await userId('ann@example.test'), bob: await userId('bob@example.test'), cy: await userId('cy@example.test'), dee: await userId('dee@example.test')};
  });
  afterAll(async () => {
    globalThis.fetch = realFetch;
    await db.planLimit.updateMany({where: {plan: 'free'}, data: {maxMembers: 10}});
    await db.appSettings.update({where: {id: 1}, data: {billingMode: 'PAID', graceDays: 14}});
    await db.$disconnect();
  });

  it('signs in and creates a workspace with a #general channel', async () => {
    expect((await new Browser(app).get('/site-api/workspaces')).status).toBe(401);
    const made = await ann.post('/site-api/workspaces', {name: 'Acme'});
    expect(made.status).toBe(201);
    ws = made.json.workspace.id;
    expect(made.json.workspace).toMatchObject({name: 'Acme', role: 'owner', plan: 'free', memberCount: 1});
    const convs = await ann.get(`/site-api/workspaces/${ws}/conversations`);
    const found = (convs.json.items as J[]).find(c => c.name === 'general');
    expect(found).toMatchObject({kind: 'channel'});
    general = found!.id;
  });

  it('creates a board from a lane list, then adds a lane and cards', async () => {
    const made = await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Launch', lanes: ['To do', 'Doing']});
    expect(made.status).toBe(201);
    board = made.json.board.id;
    let lanes = await boardLanes();
    expect(lanes.map(l => l.name)).toEqual(['To do', 'Doing']);
    [lane1, lane2] = lanes.map(l => l.id as number) as [number, number];

    const lane = await ann.post(`/site-api/boards/${board}/lanes`, {name: 'Done'});
    expect(lane.status).toBe(201);
    lane3 = lane.json.lane.id;
    lanes = await boardLanes();
    expect(lanes.map(l => l.name)).toEqual(['To do', 'Doing', 'Done']);

    const before = await rev();
    const added = await ann.post(`/site-api/lanes/${lane1}/cards`, {titles: ['Plan the launch', 'Write the post', 'Book the venue']});
    expect(added.status).toBe(201);
    cards = added.json.items as J[];
    expect(cards.map(c => c.title)).toEqual(['Plan the launch', 'Write the post', 'Book the venue']);
    expect(await rev()).toBeGreaterThan(before);
    expect((await boardLanes())[0]!.cardCount).toBe(3);
  });

  it('moves cards between lanes with exact positions, counters and rev', async () => {
    const [a, , c] = cards as [J, J, J];
    const r0 = await rev();
    const first = await ann.post(`/site-api/cards/${a.id}/move`, {laneId: lane2, afterId: null});
    expect(first.status).toBe(200);
    const r1 = await rev();
    expect(r1).toBeGreaterThan(r0);
    expect(BigInt(first.json.rev as string)).toBe(r1);
    const second = await ann.post(`/site-api/cards/${c.id}/move`, {laneId: lane2, afterId: a.id});
    expect(second.status).toBe(200);
    expect(await rev()).toBeGreaterThan(r1);
    expect(await laneTitles(lane2)).toEqual(['Plan the launch', 'Book the venue']);
    expect(await laneTitles(lane1)).toEqual(['Write the post']);
    // The "after" card sorts strictly before the moved one (byte-order keys).
    expect((first.json.position as string) < (second.json.position as string)).toBe(true);
    const lanes = await boardLanes();
    expect(lanes.map(l => l.cardCount)).toEqual([1, 2, 0]);
    // The counters are the rows, not a guess.
    for (const lane of lanes) expect(await db.card.count({where: {laneId: lane.id, archivedAt: null}})).toBe(lane.cardCount);
    // The delta feed sees the moves.
    const changes = await ann.get(`/site-api/boards/${board}/changes?since=${r0}`);
    expect(changes.status).toBe(200);
    expect((changes.json.cards as J[]).map(x => x.id).sort()).toEqual([a.id, c.id].sort());
    // Moving after a card that is not in the target lane is refused, nothing changes.
    expect((await ann.post(`/site-api/cards/${a.id}/move`, {laneId: lane3, afterId: 999999})).status).toBeGreaterThanOrEqual(400);
    expect(await laneTitles(lane2)).toEqual(['Plan the launch', 'Book the venue']);
  });

  it('opens card detail; adds a label, a checklist and a comment that mentions someone', async () => {
    const card = cards[0]!.id as number;
    const detail = await ann.get(`/site-api/cards/${card}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.json.card).toMatchObject({title: 'Plan the launch', checklistTotal: 0, commentCount: 0});
    expect(detail.json.canWrite).toBe(true);

    const label = await ann.post(`/site-api/boards/${board}/labels`, {name: 'Urgent', colorHex: '#e5484d'});
    expect(label.status).toBe(201);
    expect((await ann.request('PUT', `/site-api/cards/${card}/labels/${label.json.label.id}`, {})).status).toBe(200);
    expect((await ann.get(`/site-api/cards/${card}/detail`)).json.labelIds).toEqual([label.json.label.id]);

    const list = await ann.post(`/site-api/cards/${card}/checklists`, {title: 'Steps'});
    expect(list.status).toBe(201);
    const items = await ann.post(`/site-api/checklists/${list.json.checklist.id}/items`, {texts: ['Draft', 'Review']});
    expect(items.status).toBe(201);
    await ann.request('PATCH', `/site-api/checklist-items/${items.json.items[0].id}`, {done: true});
    expect((await ann.get(`/site-api/cards/${card}/detail`)).json.card).toMatchObject({checklistTotal: 2, checklistDone: 1});

    // The mention needs a seat in the workspace: Bob has none yet, so no one is mentioned.
    const early = await ann.post(`/site-api/cards/${card}/comments`, {body: '@bob look', mentions: [ids.bob]});
    expect(early.status).toBe(201);
    expect(early.json.comment.mentions).toEqual([]);
    expect(await db.notification.count({where: {userId: ids.bob}})).toBe(0);
    expect((await ann.get(`/site-api/cards/${card}/detail`)).json.card.commentCount).toBe(1);
  });

  it('joins by link on the free plan and respects the member cap', async () => {
    const link = await ann.post(`/site-api/workspaces/${ws}/join-links`, {role: 'member', maxUses: 10});
    expect(link.status).toBe(201);
    linkToken = link.json.token as string;
    expect(linkToken).toMatch(/^lj_/);
    expect((await accept(new Browser(app), linkToken)).status).toBe(401);

    const joinedBob = await accept(bob, linkToken);
    expect(joinedBob.status).toBe(201);
    expect(joinedBob.json).toMatchObject({workspaceId: ws, role: 'member', alreadyMember: false});
    // The same link twice by the same person consumes nothing.
    expect((await accept(bob, linkToken)).json.alreadyMember).toBe(true);
    expect((await accept(cy, linkToken)).status).toBe(201);
    expect(await memberCount()).toBe(3);

    // The free plan holds 3: the fourth person is turned away and no seat or use is taken.
    const full = await accept(dee, linkToken);
    expect(full.status).toBe(409);
    expect(full.json.error).toBe('member_limit_reached');
    expect(await memberCount()).toBe(3);
    expect(await db.workspaceMember.count({where: {workspaceId: ws, userId: ids.dee}})).toBe(0);
    expect((await db.workspaceJoinLink.findFirstOrThrow({where: {workspaceId: ws}})).uses).toBe(2);
    expect((await dee.get(`/site-api/boards/${board}`)).status).toBe(404);
    // No new links or invites while full, either.
    expect((await ann.post(`/site-api/workspaces/${ws}/join-links`, {})).status).toBe(409);
  });

  it('notifies a mentioned member who now has a seat', async () => {
    const card = cards[0]!.id as number;
    const made = await ann.post(`/site-api/cards/${card}/comments`, {body: '@bob please review', mentions: [ids.bob, ids.dee]});
    expect(made.status).toBe(201);
    expect((made.json.comment.mentions as J[]).map(m => m.id)).toEqual([ids.bob]); // dee has no seat
    const mine = await bob.get('/site-api/notifications?unread=1');
    expect(mine.status).toBe(200);
    const mention = (mine.json.items as J[]).find(n => n.kind === 'mentioned');
    expect(mention).toMatchObject({workspaceId: ws, cardId: card, boardId: board, read: false});
    expect(mention!.actor).toMatchObject({id: ids.ann});
    expect(JSON.stringify(mine.json)).not.toContain('@example.test');
    expect((await bob.get('/site-api/notifications/unread-count')).json.count).toBeGreaterThanOrEqual(1);
    expect((await bob.post(`/site-api/notifications/${mention!.id}/read`)).status).toBe(200);
    expect(((await bob.get('/site-api/notifications?unread=1')).json.items as J[]).some(n => n.id === mention!.id)).toBe(false);
    // Nobody is notified of their own comment, and Dee (not a member) gets nothing.
    expect(await db.notification.count({where: {userId: ids.ann, kind: 'mentioned'}})).toBe(0);
    expect(await db.notification.count({where: {userId: ids.dee}})).toBe(0);
  });

  it('changes a role and the new rights apply at once', async () => {
    expect((await bob.request('PATCH', `/site-api/workspaces/${ws}/members/${ids.cy}`, {role: 'viewer'})).status).toBe(403); // a member cannot
    expect((await ann.request('PATCH', `/site-api/workspaces/${ws}/members/${ids.ann}`, {role: 'member'})).status).toBe(409); // not yourself
    const down = await ann.request('PATCH', `/site-api/workspaces/${ws}/members/${ids.bob}`, {role: 'viewer'});
    expect(down.status).toBe(200);
    expect(down.json).toMatchObject({userId: ids.bob, role: 'viewer'});
    const list = await ann.get(`/site-api/workspaces/${ws}/members`);
    expect((list.json.items as J[]).find(m => m.userId === ids.bob)!.role).toBe('viewer');
    // Admins see a MASKED address (m•••@host) at most, never a full one.
    expect(JSON.stringify(list.json)).not.toMatch(/"email"|(ann|bob|cy|dee)@example\.test/);
    expect((await bob.post(`/site-api/lanes/${lane1}/cards`, {title: 'nope'})).status).toBe(403);
    expect((await bob.get(`/site-api/boards/${board}`)).json.board.canWrite).toBe(false);
    expect((await ann.request('PATCH', `/site-api/workspaces/${ws}/members/${ids.bob}`, {role: 'member'})).status).toBe(200);
    expect((await bob.post(`/site-api/lanes/${lane1}/cards`, {title: 'Bob was here'})).status).toBe(201);
    expect(await db.auditEvent.count({where: {action: 'workspace.member.role_changed'}})).toBe(2);
  });

  it('chats in #general: send, read and unread', async () => {
    const sent = await bob.post(`/site-api/conversations/${general}/messages`, {body: 'hello team', clientId: 'journey-msg-1'});
    expect(sent.status).toBe(201);
    expect((await bob.post(`/site-api/conversations/${general}/messages`, {body: 'hello team', clientId: 'journey-msg-1'})).status).toBe(200); // a retry, not a copy
    expect((await bob.post(`/site-api/conversations/${general}/messages`, {body: 'second', clientId: 'journey-msg-2'})).status).toBe(201);

    const pulse = async (b: Browser) => ((await b.get('/site-api/chat/pulse')).json.items as J[]).find(p => p.conversationId === general);
    expect(await pulse(ann)).toMatchObject({lastSeq: 2, unread: 2});
    const page = await ann.get(`/site-api/conversations/${general}/messages`);
    expect((page.json.items as J[]).map(m => m.body)).toEqual(['hello team', 'second']);
    expect(page.json.items[0].sender.name).toBe('bob');
    expect(JSON.stringify(page.json)).not.toContain('@example.test');
    expect((await ann.post(`/site-api/conversations/${general}/read`, {seq: 1})).json.unread).toBe(1);
    expect((await ann.post(`/site-api/conversations/${general}/read`, {seq: 2})).json.unread).toBe(0);
    expect(await pulse(ann)).toMatchObject({unread: 0});
    // A viewer reads but cannot send.
    expect((await ann.request('PATCH', `/site-api/workspaces/${ws}/members/${ids.cy}`, {role: 'viewer'})).status).toBe(200);
    expect((await cy.get(`/site-api/conversations/${general}/messages`)).status).toBe(200);
    expect((await cy.post(`/site-api/conversations/${general}/messages`, {body: 'x', clientId: 'journey-msg-3'})).status).toBe(403);
    expect((await ann.request('PATCH', `/site-api/workspaces/${ws}/members/${ids.cy}`, {role: 'member'})).status).toBe(200);
  });

  it('finds cards, shows My Day, captures into the Inbox and triages', async () => {
    const found = await ann.get(`/site-api/workspaces/${ws}/search?q=${encodeURIComponent('launch')}`);
    expect(found.status).toBe(200);
    expect((found.json.cards as J[]).map(c => c.title)).toEqual(['Plan the launch']);
    expect((await dee.get(`/site-api/workspaces/${ws}/search?q=launch`)).status).toBe(404);

    // My Day: a card assigned to me, due today.
    const card = cards[0]!.id as number;
    expect((await ann.request('PUT', `/site-api/cards/${card}/members/${ids.ann}`, {})).status).toBe(200);
    const today = new Date().toISOString().slice(0, 10);
    expect((await ann.request('PATCH', `/site-api/cards/${card}/details`, {dueDate: today})).status).toBe(200);
    const day = await ann.get(`/site-api/my-day?today=${today}`);
    expect(day.status).toBe(200);
    expect((day.json.items as J[]).map(i => [i.title, i.group])).toEqual([['Plan the launch', 'today']]);
    expect((await bob.get(`/site-api/my-day?today=${today}`)).json.items).toEqual([]);

    // Inbox: capture, then triage into a lane.
    const captured = await ann.post(`/site-api/workspaces/${ws}/inbox/cards`, {title: 'Call the printer'});
    expect(captured.status).toBe(201);
    const inbox = await ann.get(`/site-api/workspaces/${ws}/inbox`);
    expect((inbox.json.items as J[]).map(i => i.title)).toEqual(['Call the printer']);
    expect(((await bob.get(`/site-api/workspaces/${ws}/inbox`)).json.items as J[])).toEqual([]);
    const triaged = await ann.post(`/site-api/inbox/cards/${captured.json.card.id}/triage`, {laneId: lane3});
    expect(triaged.status).toBe(200);
    expect((await ann.get(`/site-api/workspaces/${ws}/inbox`)).json.items).toEqual([]);
    expect(await laneTitles(lane3)).toEqual(['Call the printer']);
    expect((await boardLanes())[2]!.cardCount).toBe(1);
  });

  it('starts a sandbox checkout from the free plan (admins only) and the hook upgrades the workspace', async () => {
    expect((await bob.post(`/site-api/workspaces/${ws}/billing/checkout`, {plan: 'pro', gateway: 'sandbox'})).status).toBe(403);
    expect((await dee.post(`/site-api/workspaces/${ws}/billing/checkout`, {plan: 'pro', gateway: 'sandbox'})).status).toBe(404);
    const checkout = await ann.post(`/site-api/workspaces/${ws}/billing/checkout`, {plan: 'pro', gateway: 'sandbox'});
    expect(checkout.status).toBe(200);
    expect(checkout.json).toMatchObject({choose: false, id: 'pcs_journey_sandbox', mode: 'test', redirectUrl: '/checkout/?id=pcs_journey_sandbox'});
    // The price is the server's key; the workspace comes from OUR reference, never the browser.
    expect(checkoutBodies).toHaveLength(1);
    expect(checkoutBodies[0]).toMatchObject({price: 'pro-monthly', customerRef: `${ids.ann}:${ws}`, quantity: 1});

    // The platform's paid event reaches the hook: the plan changes, the seat limit follows.
    const ref = `${ids.ann}:${ws}`;
    expect((await inRequestScope(() => applyWorkspacePlan(membership(ref, 'pro-monthly', 'active')))).changed).toBe(true);
    const row = await db.workspace.findUniqueOrThrow({where: {id: ws}});
    expect([row.plan, row.memberLimit, row.graceUntil]).toEqual(['pro', 50, null]);
    expect(((await ann.get(`/site-api/workspaces/${ws}/billing`)).json.entitlements as J).plan).toBe('pro');

    // The cap is lifted: the turned-away person joins with the same link.
    const joined = await accept(dee, linkToken);
    expect(joined.status).toBe(201);
    expect(await memberCount()).toBe(4);
    expect((await dee.get(`/site-api/boards/${board}`)).status).toBe(200);
  });

  it('downgrades: nothing is deleted, the grace clock starts, and the sweep is safe to repeat', async () => {
    const ref = `${ids.ann}:${ws}`;
    expect((await inRequestScope(() => applyWorkspacePlan(membership(ref, 'pro-monthly', 'canceled')))).changed).toBe(true);
    const row = await db.workspace.findUniqueOrThrow({where: {id: ws}});
    expect(row.plan).toBe('free');
    expect(row.memberCount).toBe(4); // over the free 3, nobody removed
    expect(row.graceUntil).not.toBeNull();
    expect(row.graceUntil!.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    const entitlements = (await ann.get(`/site-api/workspaces/${ws}/billing`)).json.entitlements as J;
    expect(entitlements).toMatchObject({plan: 'free', overLimit: true, inGrace: true, readOnly: false});
    // Still working during grace.
    expect((await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'In grace'})).status).toBe(201);
    // The daily sweep has nothing to start and changes nothing.
    expect(await sweepGrace(db)).toEqual({checked: 0});
    expect((await db.workspace.findUniqueOrThrow({where: {id: ws}})).graceUntil?.getTime()).toBe(row.graceUntil!.getTime());
  });

  it('turns read-only after the grace ends: reads work, writes answer 409', async () => {
    await db.workspace.update({where: {id: ws}, data: {graceUntil: new Date(Date.now() - 60_000)}});
    const entitlements = (await ann.get(`/site-api/workspaces/${ws}/billing`)).json.entitlements as J;
    expect(entitlements).toMatchObject({overLimit: true, inGrace: false, readOnly: true});

    expect((await ann.get(`/site-api/boards/${board}`)).status).toBe(200);
    expect((await ann.get(`/site-api/conversations/${general}/messages`)).status).toBe(200);
    expect((await ann.get(`/site-api/workspaces/${ws}/search?q=launch`)).status).toBe(200);

    const refused = [
      await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Another'}),
      await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'Too late'}),
      await ann.post(`/site-api/cards/${cards[0]!.id}/comments`, {body: 'too late'}),
      await ann.post(`/site-api/workspaces/${ws}/join-links`, {}),
      await ann.post(`/site-api/workspaces/${ws}/inbox/cards`, {title: 'Too late'}),
    ];
    for (const res of refused) {
      expect(res.status).toBe(409);
      expect(res.json.error).toBe('workspace_read_only');
    }
    expect((await accept(new Browser(app), linkToken)).status).toBe(401);
    expect(await laneTitles(lane1)).not.toContain('Too late');
  });

  it('lets a member leave, which frees the seat and ends the read-only state', async () => {
    expect((await dee.post(`/site-api/workspaces/${ws}/leave`)).status).toBe(200);
    expect(await memberCount()).toBe(3);
    expect(await db.workspaceMember.count({where: {workspaceId: ws, userId: ids.dee}})).toBe(0);
    expect(await db.conversationMember.count({where: {workspaceId: ws, userId: ids.dee}})).toBe(0);
    // Gone for good: the workspace is a 404 to them now.
    expect((await dee.get(`/site-api/boards/${board}`)).status).toBe(404);
    expect((await dee.post(`/site-api/workspaces/${ws}/leave`)).status).toBe(404);
    expect(((await dee.get('/site-api/workspaces')).json.items as J[])).toEqual([]);
    // The owner cannot strand the workspace.
    const last = await ann.post(`/site-api/workspaces/${ws}/leave`);
    expect(last.status).toBe(409);
    expect(last.json.error).toBe('last_owner');
    // Back under the limit, the daily sweep drops the clock and the workspace is writable again.
    expect(await sweepGrace(db)).toEqual({checked: 1});
    expect((await db.workspace.findUniqueOrThrow({where: {id: ws}})).graceUntil).toBeNull();
    expect((await ann.post(`/site-api/lanes/${lane1}/cards`, {title: 'Back to work'})).status).toBe(201);
    expect(await db.auditEvent.count({where: {action: 'workspace.member.left'}})).toBe(1);
  });
});
