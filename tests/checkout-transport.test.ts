import {beforeEach, describe, expect, it, vi} from 'vitest';

const siteFetch = vi.fn();
vi.mock('../src/platform/browser', () => ({siteFetch: (...a: unknown[]) => siteFetch(...a)}));

import {CheckoutError, TRIAL_USED_CODE} from '../src/lib/checkout-session';
import {siteCheckoutTransport as t} from '../src/lib/checkout-transport';

const res = (status: number, body: unknown, rawText?: string) =>
  ({status, ok: status >= 200 && status < 300, json: async () => (rawText !== undefined ? JSON.parse(rawText) : body)}) as Response;

beforeEach(() => siteFetch.mockReset());

describe('siteCheckoutTransport', () => {
  it('encodes the price key in the gateways URL and tolerates a non-array answer', async () => {
    siteFetch.mockResolvedValueOnce(res(200, {gateways: 'nope'}));
    expect(await t.listGateways('a b&c')).toEqual([]);
    expect(siteFetch.mock.calls[0]![0]).toBe('/site-api/checkout/gateways?price=a%20b%26c');
  });

  it('turns a refused gateways call into a CheckoutError with the server code', async () => {
    siteFetch.mockResolvedValueOnce(res(502, {code: 'E_X', message: 'Nope'}));
    await expect(t.listGateways('p')).rejects.toMatchObject({name: 'CheckoutError', code: 'E_X', status: 502, message: 'Nope'});
  });

  it('survives a non-JSON error body (falls back to http_<status>)', async () => {
    siteFetch.mockResolvedValueOnce(res(500, null, '<html'));
    const err = await t.listGateways('p').catch(e => e);
    expect(err).toBeInstanceOf(CheckoutError);
    expect(err.code).toBe('http_500');
    expect(err.message).toMatch(/Try again/);
  });

  it('createCheckout posts JSON and returns id, mode, embedded', async () => {
    siteFetch.mockResolvedValueOnce(res(200, {id: 'c1', mode: 'payment', embedded: {kind: 'x'}}));
    const out = await t.createCheckout({price: 'p'} as never);
    expect(out).toEqual({id: 'c1', mode: 'payment', embedded: {kind: 'x'}});
    const [url, init] = siteFetch.mock.calls[0]!;
    expect(url).toBe('/site-api/checkout');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({price: 'p'});
  });

  it('rejects a 200 that lacks an id or embedded payload', async () => {
    siteFetch.mockResolvedValueOnce(res(200, {id: 'c1'}));
    await expect(t.createCheckout({} as never)).rejects.toBeInstanceOf(CheckoutError);
    siteFetch.mockResolvedValueOnce(res(200, {id: 5, embedded: {}}));
    await expect(t.createCheckout({} as never)).rejects.toBeInstanceOf(CheckoutError);
  });

  it('surfaces the used-trial 409 with its code', async () => {
    siteFetch.mockResolvedValueOnce(res(409, {code: TRIAL_USED_CODE, message: 'Trial used'}));
    await expect(t.createCheckout({} as never)).rejects.toMatchObject({code: TRIAL_USED_CODE, status: 409});
  });

  it('getStatus is null on failure and when the status is missing, encodes the id', async () => {
    siteFetch.mockResolvedValueOnce(res(404, {}));
    expect(await t.getStatus('x')).toBeNull();
    siteFetch.mockResolvedValueOnce(res(200, {checkout: {}}));
    expect(await t.getStatus('x')).toBeNull();
    siteFetch.mockResolvedValueOnce(res(200, {checkout: {status: 'paid'}}));
    expect(await t.getStatus('a/b')).toBe('paid');
    expect(siteFetch.mock.calls[2]![0]).toBe('/site-api/checkout/a%2Fb');
  });
});
