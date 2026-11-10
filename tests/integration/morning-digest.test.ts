import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {runMorningDigest} from '../../src/server/jobs/morning-digest';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

// The run happens "today at 09:00 UTC"; the people below choose 07:00 in UTC, so they are due.
const NOW = new Date(`${new Date().toISOString().slice(0, 10)}T09:00:00.000Z`);
const day = (n: number) => new Date(`${new Date(NOW.getTime() + n * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`);

/** The morning digest job and its setting route (real Postgres). */
describe.skipIf(!DATABASE_URL)('morning digest (integration, real Postgres)', () => {
  let ann: Browser;
  let bob: Browser;
  let ws: number;
  let board: number;
  let lane: number;
  let annId: number;
  let bobId: number;
  let cat: number;
  let card: number;

  const optIn = (uid: number, hour: number | null = 7, tz: string | null = 'UTC') =>
    db.userProfile.upsert({where: {userId: uid}, create: {userId: uid, digestHour: hour, digestTz: tz}, update: {digestHour: hour, digestTz: tz, digestLastOn: null, digestSentAt: null}});
  const run = () => runMorningDigest(db, NOW);
  const digests = (uid: number) => db.notification.findMany({where: {userId: uid, kind: 'digest'}, select: {id: true, workspaceId: true, actorId: true, boardId: true, cardId: true, digest: true}});
  const newCard = async (title: string, dueOn: Date | null, who: number[] = [], laneId = lane, owner = ann) => {
    const id = (await owner.post(`/site-api/lanes/${laneId}/cards`, {title})).json.items[0].id as number;
    await db.card.update({where: {id}, data: {dueDate: dueOn}});
    for (const u of who) await db.cardMember.create({data: {cardId: id, userId: u, workspaceId: ws}});
    await db.notification.deleteMany();
    await db.cardWatcher.deleteMany();
    return id;
  };

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.72');
    await signedIn(app, 'cat@example.test', undefined, '203.0.113.73');
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    annId = await userId('ann@example.test');
    bobId = await userId('bob@example.test');
    cat = await userId('cat@example.test');
    await db.workspaceMember.create({data: {workspaceId: ws, userId: cat, role: 'member'}});
    board = (await ann.post(`/site-api/workspaces/${ws}/boards`, {name: 'Ops', lanes: ['To do']})).json.board.id;
    lane = (await ann.get(`/site-api/boards/${board}`)).json.lanes[0].id;
    card = await newCard('Ship it', day(0), [annId]);
  });

  it('makes one digest with the counts, once a day, by the system, with no title or address', async () => {
    await optIn(annId);
    await newCard('Late', day(-3), [annId]);
    await newCard('Soon', day(1), [annId]); // tomorrow is not in a MORNING digest
    await db.notification.create({data: {userId: annId, workspaceId: ws, kind: 'mentioned', actorId: cat}});
    const first = await run();
    expect(first.made).toBe(1);
    const rows = await digests(annId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({workspaceId: ws, actorId: null, boardId: null, cardId: null});
    expect(rows[0]!.digest).toMatchObject({dueCount: 1, overdueCount: 1, mentionCount: 1, userId: annId});
    expect(rows[0]!.digest!.cardIds).toHaveLength(2);
    expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain('example.test');
    // A second run, and an overlapping one, make nothing.
    expect((await run()).made).toBe(0);
    await Promise.all([run(), run()]);
    expect(await digests(annId)).toHaveLength(1);
  });

  it('the bell list carries the numbers of the digest and nothing of another person', async () => {
    await optIn(annId);
    await run();
    const list = (await ann.get('/site-api/notifications')).json.items.filter((i: {kind: string}) => i.kind === 'digest');
    expect(list).toHaveLength(1);
    expect(list[0].digest).toEqual({due: 1, overdue: 0, mentions: 0});
    expect(list[0].actor).toBeNull();
    expect((await bob.get('/site-api/notifications')).json.items).toEqual([]);
  });

  it('makes nothing when there is nothing to say, and the day is used up', async () => {
    await db.card.update({where: {id: card}, data: {dueDate: null}});
    await optIn(annId);
    const out = await run();
    expect(out.made).toBe(0);
    expect(await digests(annId)).toEqual([]);
    const profile = await db.userProfile.findUnique({where: {userId: annId}, select: {digestLastOn: true}});
    expect(profile!.digestLastOn).not.toBeNull();
    await db.card.update({where: {id: card}, data: {dueDate: day(0)}}); // due later that day: tomorrow's digest, not another one today
    expect((await run()).made).toBe(0);
  });

  it('skips people who did not opt in or switched off, and honours the hour and the zone', async () => {
    expect((await run()).made).toBe(0); // nobody opted in
    await optIn(annId, 7, 'UTC');
    await optIn(cat, null);
    await db.cardMember.create({data: {cardId: card, userId: cat, workspaceId: ws}});
    await run();
    expect(await digests(cat)).toEqual([]);
    expect(await digests(annId)).toHaveLength(1);
    // 07:00 in Dhaka is 01:00 UTC: at 09:00 UTC it is 15:00 there, past the morning window.
    await db.notification.deleteMany();
    await optIn(annId, 7, 'Asia/Dhaka');
    expect((await run()).made).toBe(0);
    // 09:00 UTC is 04:00 in New York: not yet.
    await optIn(annId, 7, 'America/New_York');
    expect((await run()).made).toBe(0);
  });

  it('only counts what the person can still see: no seat on a private board, an archived board, no longer a member', async () => {
    await db.cardMember.create({data: {cardId: card, userId: cat, workspaceId: ws}});
    await optIn(cat);
    await db.board.update({where: {id: board}, data: {visibility: 'private'}});
    await db.notification.create({data: {userId: cat, workspaceId: ws, kind: 'mentioned', boardId: board, actorId: annId}});
    expect((await run()).made).toBe(0); // no seat: neither the card nor the mention
    await db.userProfile.update({where: {userId: cat}, data: {digestLastOn: null, digestSentAt: null}});
    await db.boardMember.create({data: {boardId: board, userId: cat, workspaceId: ws, role: 'member'}});
    expect((await run()).made).toBe(1);
    expect((await digests(cat))[0]!.digest).toMatchObject({dueCount: 1, mentionCount: 1});
    // Archived board and a removed member.
    await db.notification.deleteMany();
    await db.userProfile.update({where: {userId: cat}, data: {digestLastOn: null, digestSentAt: null}});
    await db.board.update({where: {id: board}, data: {archivedAt: new Date()}});
    expect((await run()).made).toBe(0);
    await db.board.update({where: {id: board}, data: {archivedAt: null, visibility: 'workspace'}});
    await db.userProfile.update({where: {userId: cat}, data: {digestLastOn: null, digestSentAt: null}});
    await db.workspaceMember.delete({where: {workspaceId_userId: {workspaceId: ws, userId: cat}}});
    expect((await run()).made).toBe(0);
  });

  it('never mixes workspaces: each person gets only their own, and a follower of a foreign card gets nothing', async () => {
    const bws = (await db.workspaceMember.findFirst({where: {userId: bobId}, select: {workspaceId: true}}))!.workspaceId;
    const bboard = (await bob.post(`/site-api/workspaces/${bws}/boards`, {name: 'Theirs', lanes: ['L']})).json.board.id;
    const blane = (await bob.get(`/site-api/boards/${bboard}`)).json.lanes[0].id;
    const bcard = (await bob.post(`/site-api/lanes/${blane}/cards`, {title: 'Bob due'})).json.items[0].id as number;
    await db.card.update({where: {id: bcard}, data: {dueDate: day(0)}});
    await db.cardMember.create({data: {cardId: bcard, userId: bobId, workspaceId: bws}});
    await db.cardWatcher.create({data: {cardId: bcard, userId: annId}}); // Ann is NOT in Bob's workspace
    await optIn(annId);
    await optIn(bobId);
    await run();
    expect((await digests(annId))[0]!.digest).toMatchObject({dueCount: 1, overdueCount: 0});
    expect((await digests(annId))[0]!.workspaceId).toBe(ws);
    expect((await digests(bobId))[0]!.digest).toMatchObject({dueCount: 1, overdueCount: 0});
    expect((await digests(bobId))[0]!.workspaceId).toBe(bws);
  });

  it('ignores done, archived and long-forgotten overdue cards', async () => {
    await newCard('Old', day(-120), [annId]);
    const done = await newCard('Done', day(-1), [annId]);
    await db.card.update({where: {id: done}, data: {completedAt: new Date()}});
    const gone = await newCard('Gone', day(-1), [annId]);
    await db.card.update({where: {id: gone}, data: {archivedAt: new Date()}});
    await optIn(annId);
    await run();
    expect((await digests(annId))[0]!.digest).toMatchObject({dueCount: 1, overdueCount: 0});
  });

  it('lists at most 5 overdue and 10 due-today cards, oldest overdue first', async () => {
    for (let i = 0; i < 7; i++) await newCard(`Late ${i}`, day(-1 - i), [annId]);
    for (let i = 0; i < 12; i++) await newCard(`Today ${i}`, day(0), [annId]);
    await optIn(annId);
    await run();
    const d = (await digests(annId))[0]!.digest!;
    expect(d.overdueCount).toBe(7);
    expect(d.dueCount).toBe(13);
    expect(d.cardIds).toHaveLength(15);
  });

  it('the setting route: own row, validated, off keeps today used', async () => {
    expect((await ann.get('/site-api/morning-digest')).json).toMatchObject({hour: null, timezone: null});
    const patch = (b: unknown) => ann.request('PATCH', '/site-api/morning-digest', b);
    expect((await patch({hour: 4})).status).toBe(422);
    expect((await patch({hour: 13})).status).toBe(422);
    expect((await patch({hour: 7.5})).status).toBe(422);
    expect((await patch({hour: '7'})).status).toBe(422);
    expect((await patch({hour: 7, timezone: 'Not/AZone'})).status).toBe(422);
    expect((await patch({})).status).toBe(422);
    const ok = await patch({hour: 7, timezone: 'Asia/Dhaka'});
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({hour: 7, timezone: 'Asia/Dhaka'});
    expect((await bob.get('/site-api/morning-digest')).json.hour).toBeNull(); // Bob's own row
    await db.userProfile.update({where: {userId: annId}, data: {digestLastOn: day(0), digestTz: 'UTC'}});
    expect((await patch({hour: null})).json.hour).toBeNull();
    expect((await patch({hour: 7})).status).toBe(200);
    const row = await db.userProfile.findUnique({where: {userId: annId}, select: {digestLastOn: true}});
    expect(row!.digestLastOn).not.toBeNull(); // off and on again does not reset the day
    expect((await run()).made).toBe(0);
  });

  it('a signed-out visitor is refused', async () => {
    const anon = new Browser(app, '203.0.113.79');
    expect((await anon.get('/site-api/morning-digest')).status).toBe(401);
    expect((await anon.request('PATCH', '/site-api/morning-digest', {hour: 7})).status).toBe(401);
  });
});
