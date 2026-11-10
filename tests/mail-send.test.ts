import {afterEach, describe, expect, it, vi} from 'vitest';

import {mailCredentials, sendMail} from '../src/server/mail/send';

const CREDS = {apiKey: 're_secret_key_12345', from: 'Lanefold <no-reply@example.com>'};
const MSG = {to: 'ana@example.org', subject: 'Hi', text: 'Body https://x', html: '<p>Body</p>', idempotencyKey: 'invite-1-abc'};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const stub = (impl: (url: string, init: RequestInit) => Promise<Response>) => {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
};

describe('mail sender', () => {
  it('sends to the fixed origin with the key, a timeout signal and no redirects', async () => {
    const fn = stub(async () => new Response(JSON.stringify({id: 'msg_1'}), {status: 200}));
    const result = await sendMail(MSG, CREDS);
    expect(result).toEqual({kind: 'sent', id: 'msg_1'});
    const [url, init] = fn.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CREDS.apiKey}`);
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('invite-1-abc');
    expect(JSON.parse(init.body as string)).toMatchObject({from: CREDS.from, to: ['ana@example.org'], subject: 'Hi'});
  });

  it('a 4xx is a final failure (no retry)', async () => {
    stub(async () => new Response('{"message":"bad"}', {status: 422}));
    expect(await sendMail(MSG, CREDS)).toEqual({kind: 'failed', status: 422});
  });

  it('a redirect is a final failure and is never followed', async () => {
    stub(async () => new Response(null, {status: 302, headers: {location: 'https://evil.example'}}));
    expect(await sendMail(MSG, CREDS)).toEqual({kind: 'failed', status: 302});
  });

  it('5xx and 429 ask for a retry', async () => {
    stub(async () => new Response('', {status: 503}));
    expect(await sendMail(MSG, CREDS)).toEqual({kind: 'retry', status: 503});
    stub(async () => new Response('', {status: 429}));
    expect(await sendMail(MSG, CREDS)).toEqual({kind: 'retry', status: 429});
  });

  it('a timeout or network error asks for a retry', async () => {
    stub(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect(await sendMail(MSG, CREDS)).toEqual({kind: 'retry', status: null});
  });

  it('without owner secrets nothing is attempted', async () => {
    const fn = stub(async () => new Response('', {status: 200}));
    expect(await sendMail(MSG, null)).toEqual({kind: 'not_configured'});
    expect(fn).not.toHaveBeenCalled();
    expect(mailCredentials()).toBeNull();
  });

  it('refuses a header-injecting subject or address before any request', async () => {
    const fn = stub(async () => new Response('', {status: 200}));
    expect((await sendMail({...MSG, subject: 'a\r\nBcc: x'}, CREDS)).kind).toBe('failed');
    expect((await sendMail({...MSG, to: 'a@b.c, d@e.f'}, CREDS)).kind).toBe('failed');
    expect(fn).not.toHaveBeenCalled();
  });

  it('never writes the key, the address or the body to the logs or the result', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => {}));
    stub(async () => {
      throw new Error(`boom ${CREDS.apiKey} ${MSG.to}`);
    });
    const failed = await sendMail(MSG, CREDS);
    stub(async () => new Response(`echo ${CREDS.apiKey} ${MSG.to}`, {status: 400}));
    const refused = await sendMail(MSG, CREDS);
    const text = JSON.stringify([failed, refused, ...spies.map(s => s.mock.calls)]);
    expect(text).not.toContain(CREDS.apiKey);
    expect(text).not.toContain('ana@example.org');
  });
});
