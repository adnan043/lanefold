import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {applyWorkspacePlan, recordMembership} from '../../src/server/payments-hooks';
import {cleanupOld, sweepEndedMemberships, sweepGrace} from '../../src/server/jobs/sweeps';
import {configureEnv, DATABASE_URL, db, resetDatabase} from './support/harness';

describe.skipIf(!DATABASE_URL)('scheduled sweeps (integration, real Postgres)', () => {
  beforeAll(async () => {
    configureEnv();
    await resetDatabase();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it('runs all sweeps on an empty database and repeats safely', async () => {
    expect(await sweepEndedMemberships(db)).toEqual({moved: 0});
    expect(await sweepGrace(db)).toEqual({checked: 0});
    const a = await cleanupOld(db, {});
    expect(a).toEqual({invites: 0, joinLinks: 0, notifications: 0, uploads: 0});
    expect(await cleanupOld(db, null)).toEqual(a);
  });

  const sub = (id: string, status: 'active' | 'canceled', ref: string | null, accessEndsAt: string | null = null) => ({
    id,
    price: 'pro-monthly',
    email: null,
    status,
    currentPeriodEnd: null,
    accessEndsAt,
    customerRef: ref,
    checkoutId: null,
  });
  // memberships.user_id is a real foreign key now: the buyer (user 1 in every ref below) must exist.
  const buyer = () => db.user.create({data: {id: 1, email: 'buyer@example.com', passwordHash: 'x', name: 'Buyer'}, select: {id: true}});
  const workspace = (slug: string) => db.workspace.create({data: {name: slug, slug, plan: 'pro', memberLimit: 50, createdBy: null}, select: {id: true}});

  it('matches a subscription to the workspace it paid for, not to its owner', async () => {
    await resetDatabase();
    await buyer();
    const [w1, w2] = [await workspace('sweep-w1'), await workspace('sweep-w2')];
    // The same person pays for w1 (ended) and w2 (active): only w1 falls.
    await recordMembership(sub('sub_w1', 'canceled', `1:${w1.id}`, '2020-01-01T00:00:00Z'), 'test');
    await recordMembership(sub('sub_w2', 'active', `1:${w2.id}`), 'test');
    expect((await db.membership.findUniqueOrThrow({where: {subscriptionId: 'sub_w1'}, select: {workspaceId: true}})).workspaceId).toBe(w1.id);
    expect(await sweepEndedMemberships(db)).toEqual({moved: 1});
    expect((await db.workspace.findUniqueOrThrow({where: {id: w1.id}, select: {plan: true}})).plan).toBe('free');
    expect((await db.workspace.findUniqueOrThrow({where: {id: w2.id}, select: {plan: true}})).plan).toBe('pro');
  });

  it('never downgrades through an old membership without a workspace', async () => {
    await resetDatabase();
    await buyer();
    const w = await workspace('sweep-old');
    await recordMembership(sub('sub_old', 'canceled', '1', '2020-01-01T00:00:00Z'), 'test');
    expect(await sweepEndedMemberships(db)).toEqual({moved: 0});
    expect((await db.workspace.findUniqueOrThrow({where: {id: w.id}, select: {plan: true}})).plan).toBe('pro');
  });

  it('ignores a membership event older than the last one applied', async () => {
    await resetDatabase();
    await buyer();
    const w = await workspace('order-w');
    const ref = `1:${w.id}`;
    const ended = await recordMembership(sub('sub_o', 'canceled', ref, '2020-01-01T00:00:00Z'), 'test', '2026-11-01T10:00:05Z');
    expect(ended.stale).toBe(false);
    const late = await recordMembership(sub('sub_o', 'active', ref), 'test', '2026-11-01T10:00:00Z');
    expect(late.stale).toBe(true);
    expect((await db.membership.findUniqueOrThrow({where: {subscriptionId: 'sub_o'}, select: {status: true}})).status).toBe('canceled');
    // The plan follows the applied (newer) event.
    await applyWorkspacePlan(sub('sub_o', 'canceled', ref, '2020-01-01T00:00:00Z'));
    expect((await db.workspace.findUniqueOrThrow({where: {id: w.id}, select: {plan: true}})).plan).toBe('free');
  });

  it('cleans abandoned unconfirmed uploads older than an hour (rows without a stored file)', async () => {
    await resetDatabase();
    await buyer();
    const old = new Date(Date.now() - 2 * 86_400_000);
    const w = await workspace('upload-w');
    const row = (name: string, ready: boolean, createdAt: Date) => ({workspaceId: w.id, name, ready, uploadedBy: 1, createdAt});
    await db.attachment.createMany({data: [row('old-open', false, old), row('old-ready', true, old), row('new-open', false, new Date()), row('two-hours-open', false, new Date(Date.now() - 2 * 3_600_000)), row('half-hour-open', false, new Date(Date.now() - 30 * 60_000))]});
    expect((await cleanupOld(db, undefined)).uploads).toBe(2);
    const left = await db.attachment.findMany({select: {name: true}, orderBy: {name: 'asc'}});
    expect(left.map(r => r.name)).toEqual(['half-hour-open', 'new-open', 'old-ready']);
  });
});
