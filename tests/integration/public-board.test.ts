import {createHash, randomBytes} from 'node:crypto';
import {beforeAll, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv} from './support/harness';

/** Needs TEST_DATABASE_URL (see database.md). Boards are made straight in the database with a known token. */
const url = process.env.TEST_DATABASE_URL;
const token = () => randomBytes(32).toString('base64url');
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

describe.skipIf(!url)('public board (database)', () => {
  beforeAll(configureEnv);

  async function seed(over: {visibility?: string; archived?: boolean; inbox?: boolean} = {}) {
    const {createDb} = await import('../../src/platform/db');
    const db = createDb(url!);
    const t = token();
    const stamp = randomBytes(4).toString('hex');
    const ws = await db.workspace.create({data: {name: `Pub ${stamp}`, slug: `pub-${stamp}`}});
    const user = await db.user.create({data: {email: `leak-${stamp}@example.com`, passwordHash: 'x', name: 'Maria Khan'}});
    const board = await db.board.create({
      data: {
        workspaceId: ws.id,
        name: 'Roadmap',
        visibility: over.visibility ?? 'public',
        shareTokenHash: hash(t),
        archivedAt: over.archived ? new Date() : null,
        inboxOf: over.inbox ? user.id : null,
      },
    });
    const lane = await db.lane.create({data: {boardId: board.id, workspaceId: ws.id, name: 'Todo', position: 'a0'}});
    const card = await db.card.create({
      data: {boardId: board.id, laneId: lane.id, workspaceId: ws.id, title: 'Ship it', position: 'a0', descriptionMd: 'Plain text'},
    });
    await db.cardMember.create({data: {cardId: card.id, userId: user.id, workspaceId: ws.id}});
    await db.comment.create({data: {cardId: card.id, workspaceId: ws.id, authorId: user.id, bodyMd: 'SECRET-COMMENT-MARKER'}});
    return {t, stamp};
  }

  const get = (t: string) => new Browser(app).get(`/site-api/public/boards/${t}`);

  it('shows the board without emails, user ids or comments', async () => {
    const {t, stamp} = await seed();
    const res = await get(t);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.json);
    expect(text).toContain('Ship it');
    expect(text).toContain('Maria K.');
    expect(text).not.toContain('@');
    expect(text).not.toContain(stamp + '@');
    expect(text).not.toContain('SECRET-COMMENT-MARKER');
    expect(text).not.toContain(t);
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('answers the same 404 for unknown, private, archived and inbox boards', async () => {
    const bodies = new Set<string>();
    for (const t of [token(), (await seed({visibility: 'private'})).t, (await seed({archived: true})).t, (await seed({inbox: true})).t]) {
      const res = await get(t);
      expect(res.status).toBe(404);
      bodies.add(JSON.stringify(res.json));
    }
    expect(bodies.size).toBe(1);
  });

  it('stops showing a board right after it is made private (no stale cache)', async () => {
    const {t} = await seed();
    expect((await get(t)).status).toBe(200);
    const {createDb} = await import('../../src/platform/db');
    await createDb(url!).board.update({where: {shareTokenHash: hash(t)}, data: {visibility: 'private'}});
    expect((await get(t)).status).toBe(404);
  });
});
