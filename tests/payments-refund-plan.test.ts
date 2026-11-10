import {beforeEach, describe, expect, it, vi} from 'vitest';

let candidates: {subscriptionId: string; mode: string}[] = [];
const cancelled: string[] = [];

vi.mock('../src/platform/db', async importOriginal => {
  const original = await importOriginal<typeof import('../src/platform/db')>();
  const fake = {
    order: {
      findUnique: async () => ({id: 1, priceKey: 'pro-monthly', userId: 5, metadata: {workspaceId: '9'}}),
      updateMany: async () => ({count: 1}),
    },
    membership: {findMany: async () => candidates},
  };
  return {...original, getDb: () => fake};
});
vi.mock('../src/platform/payments', async importOriginal => {
  const original = await importOriginal<typeof import('../src/platform/payments')>();
  return {
    ...original,
    cancelMembership: async (_url: string, id: string) => {
      cancelled.push(id);
      // The platform fails, so nothing after the cancel runs: this test is about WHICH one is cancelled.
      return {ok: false, status: 404, code: 'E_NOT_FOUND', message: 'gone'};
    },
  };
});

import {paymentHooks} from '../src/server/payments-hooks';

const refund = {checkoutId: 'chk_1', full: true} as never;

describe('a refunded plan checkout', () => {
  beforeEach(() => {
    cancelled.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  it('cancels nothing when several subscriptions could be the refunded one', async () => {
    candidates = [
      {subscriptionId: 'sub_new', mode: 'test'},
      {subscriptionId: 'sub_old', mode: 'test'},
    ];
    await paymentHooks.onRefund!(refund, {} as never);
    expect(cancelled).toEqual([]);
  });
  it('cancels the one candidate', async () => {
    candidates = [{subscriptionId: 'sub_only', mode: 'test'}];
    await paymentHooks.onRefund!(refund, {} as never);
    expect(cancelled).toEqual(['sub_only']);
  });
});
