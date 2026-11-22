import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {app} from '../../src/server/app';
import {getEntitlements} from '../../src/server/entitlements';
import {configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

/**
 * A workspace back under its limits with an old grace clock: the read drops the clock with one UPDATE. When its plan
 * has no plan_limits row (the fallback limits), that UPDATE can never match, so the read must not try it on every
 * request (real Postgres).
 */
describe.skipIf(!DATABASE_URL)('entitlements grace clock (integration, real Postgres)', () => {
  let ws: number;

  beforeAll(() => configureEnv());
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    const ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.71');
    ws = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
  });

  it('a plan with no plan_limits row and an old clock: no write on each read', async () => {
    const old = new Date(Date.now() - 86_400_000);
    await db.$executeRaw`UPDATE workspaces SET plan = 'retired-plan', grace_until = ${old} WHERE id = ${ws}`;
    const writes = vi.spyOn(db, '$executeRaw');
    try {
      // getEntitlements memoizes per client; a fresh object each time stands for a new request.
      for (let i = 0; i < 2; i++) {
        const ent = await getEntitlements(Object.create(db), ws);
        expect(ent).toMatchObject({overLimit: false, readOnly: false});
      }
      expect(writes).not.toHaveBeenCalled();
    } finally {
      writes.mockRestore();
    }
  });

  it('a plan with a row: the old clock is dropped once', async () => {
    const old = new Date(Date.now() - 86_400_000);
    await db.$executeRaw`UPDATE workspaces SET grace_until = ${old} WHERE id = ${ws}`;
    await getEntitlements(Object.create(db), ws);
    const row = await db.workspace.findUniqueOrThrow({where: {id: ws}, select: {graceUntil: true}});
    expect(row.graceUntil).toBeNull();
  });
});
