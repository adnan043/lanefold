import {env} from 'cloudflare:workers';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {cookieName, CSRF_COOKIE} from '../src/platform/auth/cookies';
import {checkoutRoutes} from '../src/server/routes/checkout';

const ORIGIN = 'https://shop.example.test';
const BUY = {price: 'pro', gateway: 'stripe', successPath: '/thanks/', cancelPath: '/'};
const STEP = {kind: 'element', gateway: 'stripe', clientSecret: 's', publishableKey: 'p'};

describe('POST /site-api/checkout sends one key per attempt', () => {
  let sent: Array<Record<string, unknown>>;
  let answer: () => Response;

  beforeEach(() => {
    sent = [];
    answer = () => Response.json({data: {id: 'pcs_abcdefgh12345678', mode: 'test', embedded: STEP}}, {status: 201});
    Object.assign(env, {SITE_KEY: 'stk_test', SITE_URL: ORIGIN});
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return answer();
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (body: Record<string, unknown>) =>
    checkoutRoutes.request(`${ORIGIN}/`, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-csrf-token': 'tok', cookie: `${cookieName(CSRF_COOKIE, ORIGIN)}=tok`},
      body: JSON.stringify(body),
    });
  const form = (fields: Record<string, string>, visitor = 'visitor-a') =>
    checkoutRoutes.request(`${ORIGIN}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'same-origin',
        cookie: `${cookieName(CSRF_COOKIE, ORIGIN)}=${visitor}`,
      },
      body: new URLSearchParams(fields).toString(),
    });

  it("passes the browser's key on", async () => {
    const res = await json({...BUY, idempotencyKey: 'attempt_0123456789abcdef'});
    expect(res.status).toBe(200);
    expect(sent.at(-1)!.idempotencyKey).toBe('attempt_0123456789abcdef');
  });

  it('refuses a malformed key', async () => {
    expect((await json({...BUY, idempotencyKey: 'short'})).status).toBe(422);
    expect(sent).toHaveLength(0);
  });

  it('a plain form post gets a key per visitor and purchase', async () => {
    await form(BUY);
    const first = sent.at(-1)!.idempotencyKey as string;
    expect(first).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    await form(BUY, 'visitor-b');
    expect(sent.at(-1)!.idempotencyKey).not.toBe(first);
    await form({...BUY, quantity: '2'});
    expect(sent.at(-1)!.idempotencyKey).not.toBe(first);
  });

  it('an attempt already paid goes to the thanks page', async () => {
    answer = () => Response.json({data: {id: 'pcs_abcdefgh12345678', mode: 'test', embedded: null, paid: true}}, {status: 201});
    const res = await json({...BUY, idempotencyKey: 'attempt_0123456789abcdef'});
    expect(await res.json()).toEqual({
      redirectUrl: '/thanks/?checkout=pcs_abcdefgh12345678',
      id: 'pcs_abcdefgh12345678',
      mode: 'test',
      paid: true,
    });
  });

  it('a request still starting stays a 409, so the browser keeps its key', async () => {
    answer = () => Response.json({errors: [{code: 'E_SITE_PAYMENTS_IN_PROGRESS', message: 'Still starting.'}]}, {status: 409});
    expect((await json({...BUY, idempotencyKey: 'attempt_0123456789abcdef'})).status).toBe(409);
  });
});
