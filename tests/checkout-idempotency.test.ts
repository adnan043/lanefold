import {readFileSync} from 'node:fs';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ALREADY_PAID_CODE, CheckoutError, CheckoutSession, type CheckoutTransport, notifyPaymentOpener} from '../src/lib/checkout-session';
import {attemptKey, forgetAttempt, forgetAttempts} from '../src/lib/idempotency';
import {checkoutAttemptKey} from '../src/platform/payments';

const step = {kind: 'element', gateway: 'stripe', clientSecret: 's', publishableKey: 'p'} as const;

function transport(create: CheckoutTransport['createCheckout']): CheckoutTransport {
  return {listGateways: async () => [], getStatus: async () => null, createCheckout: create};
}
const init = {price: 'pro', quantity: 1, successPath: '/thanks/', cancelPath: '/', gateway: 'stripe'};

describe('one key per purchase attempt', () => {
  const assign = vi.fn();
  const place = {search: '', assign};
  beforeEach(() => {
    vi.stubGlobal('window', {location: place, name: ''});
    place.search = '';
    assign.mockClear();
    forgetAttempts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a key across calls, a different purchase has its own, and it runs out', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    const first = attemptKey(['pro', 1]);
    expect(first).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(attemptKey(['pro', 1])).toBe(first);
    expect(attemptKey(['pro', 2])).not.toBe(first);
    now.mockReturnValue(1_000_000 + 16 * 60_000);
    expect(attemptKey(['pro', 1])).not.toBe(first);
    now.mockRestore();
    const kept = attemptKey(['x']);
    forgetAttempt(['x']);
    expect(attemptKey(['x'])).not.toBe(kept);
  });

  it('a retry after a lost answer sends the same key; a refusal gets a new one', async () => {
    const sent: string[] = [];
    let answer: () => never = () => {
      throw new CheckoutError('Lost', 'checkout_failed', 0);
    };
    const session = new CheckoutSession(
      transport(async request => {
        sent.push(request.idempotencyKey!);
        return answer();
      }),
      {...init, autoOpen: false}
    );
    await session.continue().catch(() => {});
    await session.continue().catch(() => {});
    expect(sent[1]).toBe(sent[0]);
    answer = () => {
      throw new CheckoutError('Still starting', 'E_SITE_PAYMENTS_IN_PROGRESS', 409);
    };
    await session.continue().catch(() => {});
    expect(sent[2]).toBe(sent[0]);
    answer = () => {
      throw new CheckoutError('Refused', 'gateway_unavailable', 422);
    };
    await session.continue().catch(() => {});
    expect(sent[3]).toBe(sent[0]);
    await session.continue().catch(() => {});
    expect(sent[4]).not.toBe(sent[0]);
  });

  it('coming back from paying starts a new attempt', () => {
    const before = attemptKey(['pro', 1]);
    place.search = '?checkout=pcs_123';
    notifyPaymentOpener();
    expect(attemptKey(['pro', 1])).not.toBe(before);
  });

  it('an already paid attempt goes to the thanks page and starts nothing', async () => {
    const session = new CheckoutSession(
      transport(async () => {
        throw new CheckoutError('Paid', ALREADY_PAID_CODE, 200, 'pcs_abc');
      }),
      {...init, autoOpen: false}
    );
    await session.continue().catch(() => {});
    expect(assign).toHaveBeenCalledWith('/thanks/?checkout=pcs_abc');
    expect(session.getState().status).toBe('redirecting');
  });

  it('the key sent with no script: the same for 2 minutes, then new; per purchase and buyer', async () => {
    const at = 240_000_000;
    const key = await checkoutAttemptKey(['u1', 'pro', 1], at);
    expect(key).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(await checkoutAttemptKey(['u1', 'pro', 1], at + 60_000)).toBe(key);
    expect(await checkoutAttemptKey(['u1', 'pro', 1], at + 120_000)).not.toBe(key);
    expect(await checkoutAttemptKey(['u2', 'pro', 1], at)).not.toBe(key);
    expect(await checkoutAttemptKey(['u1', 'pro', 2], at)).not.toBe(key);
  });

  it('a site route asks for a key, and the owner email is never sent empty', () => {
    const route = readFileSync(new URL('../src/server/routes/checkout.ts', import.meta.url), 'utf8');
    expect(route).toContain('idempotencyKey');
    expect(route).toContain('viewer.email || undefined');
  });
});
