import {beforeEach, describe, expect, it, vi} from 'vitest';

const state = {plan: 'team', others: [] as {plan: string; storage: bigint}[], updates: [] as unknown[]};

vi.mock('../src/server/entitlements', () => ({startGraceForOverLimit: async () => undefined, startGraceForWorkspaces: async () => undefined}));
vi.mock('../src/platform/auth', () => ({audit: async () => undefined}));
vi.mock('../src/platform/db', async importOriginal => {
  const original = await importOriginal<typeof import('../src/platform/db')>();
  const fake = {
    planLimit: {
      findFirst: async () => ({plan: 'pro', storageQuotaBytes: 10n}),
      findUnique: async () => ({maxMembers: 50}),
    },
    workspace: {
      findUnique: async () => ({plan: state.plan}),
      updateMany: async (args: unknown) => {
        state.updates.push(args);
        return {count: 1};
      },
    },
    $queryRaw: async () => state.others,
  };
  return {...original, getDb: () => fake};
});

import {applyWorkspacePlan} from '../src/server/payments-hooks';

const ended = {
  id: 'sub_old',
  price: 'pro-monthly',
  email: null,
  status: 'ended' as never,
  currentPeriodEnd: null,
  accessEndsAt: null,
  customerRef: '1:7',
  checkoutId: null,
};

describe('a late ended subscription event', () => {
  beforeEach(() => {
    state.updates = [];
    state.plan = 'team';
  });

  it('never downgrades a workspace that has a newer active subscription', async () => {
    state.others = [{plan: 'team', storage: 100n}];
    expect((await applyWorkspacePlan(ended)).changed).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it('keeps a plan that was not the ended subscription\'s own', async () => {
    state.others = [];
    expect((await applyWorkspacePlan(ended)).changed).toBe(false);
    expect(state.updates).toHaveLength(0);
  });

  it('falls to free only when nothing else grants access and the plan was the ended one', async () => {
    state.others = [];
    state.plan = 'pro';
    expect((await applyWorkspacePlan(ended)).changed).toBe(true);
    expect(state.updates).toHaveLength(1);
  });
});
