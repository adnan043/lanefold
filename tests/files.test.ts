import {env} from 'cloudflare:workers';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {allowFileUploads, completeUpload, createUpload, forwardPlatformFiles, publicFileUrl} from '../src/platform/files';
import {putFile} from '../src/platform/files-browser';

const KEY = 'stk_0123456789abcdef_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const vars = env as Record<string, string | undefined>;

afterEach(() => {
  vi.unstubAllGlobals();
  delete vars.SITE_KEY;
  delete vars.SITE_URL;
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

describe('file storage: server helpers', () => {
  it('asks the platform with the Site Key and returns the grant', async () => {
    vars.SITE_KEY = KEY;
    vars.SITE_URL = 'https://shop.example';
    const fetch = vi.fn(async () =>
      json(201, {data: {file: {id: 'file_x'}, upload: {method: 'PUT', url: '/__platform/files/uploads/t', headers: {}}}})
    );
    vi.stubGlobal('fetch', fetch);
    const res = await createUpload('https://shop.example/site-api/uploads', {
      name: 'cv.pdf',
      contentType: 'application/pdf',
      size: 10,
    });
    expect(res.ok).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://shop.example/api/site/v1/files/uploads');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('asks for a direct upload (straight to the storage)', async () => {
    vars.SITE_KEY = KEY;
    const fetch = vi.fn(async () => json(201, {data: {file: {id: 'file_x'}, upload: {}}}));
    vi.stubGlobal('fetch', fetch);
    await createUpload('https://shop.example/', {name: 'a.png', contentType: 'image/png', size: 4});
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({name: 'a.png', contentType: 'image/png', size: 4, direct: true});
  });

  it('allowFileUploads adds the storage to this page’s connect-src, once per 10 minutes', async () => {
    vars.SITE_KEY = KEY;
    const fetch = vi.fn(async () =>
      json(200, {data: {usedBytes: 0, limitBytes: null, onExceed: 'block', maxFileBytes: 1, uploadOrigin: 'https://de-s3.storage.example'}})
    );
    vi.stubGlobal('fetch', fetch);
    const directives: string[] = [];
    const csp = {insertDirective: (d: string) => directives.push(d)};
    await allowFileUploads(csp, 'https://shop.example/');
    await allowFileUploads(csp, 'https://shop.example/');
    expect(directives).toEqual([
      "connect-src 'self' https://de-s3.storage.example",
      "connect-src 'self' https://de-s3.storage.example",
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await allowFileUploads(undefined, 'https://shop.example/');
  });

  it('keeps the platform’s error code and message', async () => {
    vars.SITE_KEY = KEY;
    vi.stubGlobal('fetch', vi.fn(async () => json(402, {errors: [{code: 'E_STORAGE_LIMIT', message: 'No room.'}]})));
    const res = await createUpload('https://shop.example/', {name: 'a', contentType: 'image/png', size: 1});
    expect(res).toEqual({ok: false, status: 402, code: 'E_STORAGE_LIMIT', message: 'No room.'});
  });

  it('refuses an id that is not a file id before calling anyone', async () => {
    vars.SITE_KEY = KEY;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(completeUpload('https://shop.example/', '../../x')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('builds a public file link on the site’s own address', () => {
    expect(publicFileUrl({id: 'file_abc', name: 'menu 2026.pdf'})).toBe('/__platform/files/file_abc/menu%202026.pdf');
  });

  it('forwards uploads to the platform without cookies (Preview, own machine)', async () => {
    vars.SITE_URL = 'https://platform.example';
    const fetch = vi.fn(async () => json(200, {data: {file: {id: 'file_x'}}}));
    vi.stubGlobal('fetch', fetch);
    const req = new Request('https://preview.example/__platform/files/uploads/tok', {
      method: 'PUT',
      headers: {'content-type': 'application/octet-stream', cookie: 'session=secret'},
      body: 'abc',
    });
    const res = await forwardPlatformFiles(req, new URL(req.url));
    expect(res.status).toBe(200);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://platform.example/__platform/files/uploads/tok');
    expect(init.headers).not.toHaveProperty('cookie');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
  });
});

describe('file storage: the browser PUT', () => {
  it('direct: sends the file to the storage with the signed type; a refusal is said in words', async () => {
    const file = {id: 'file_x', status: 'pending'} as never;
    const upload = {method: 'PUT' as const, url: 'https://store.example/s1/live/x.png?sig', headers: {'Content-Type': 'image/png'}, expiresAt: '', direct: true, file};
    const fetch = vi.fn(async () => new Response('', {status: 200}));
    vi.stubGlobal('fetch', fetch);
    const ok = await putFile(upload, new Blob(['abcd'], {type: 'image/png'}));
    expect(ok).toEqual({ok: true, data: file});
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(upload.url);
    expect(init.headers).toEqual({'Content-Type': 'image/png'});

    vi.stubGlobal('fetch', vi.fn(async () => new Response('<Error/>', {status: 403})));
    const refused = await putFile(upload, new Blob(['abcdef']));
    expect(refused).toMatchObject({ok: false, status: 403, code: 'E_UPLOAD_REFUSED'});
  });

  it('returns the ready file, or the error in words', async () => {
    const upload = {method: 'PUT' as const, url: '/__platform/files/uploads/t', headers: {'Content-Type': 'application/octet-stream'}, expiresAt: ''};
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {data: {file: {id: 'file_x', status: 'ready'}}})));
    expect(await putFile(upload, new Blob(['abc']))).toMatchObject({ok: true, data: {status: 'ready'}});
    vi.stubGlobal('fetch', vi.fn(async () => json(413, {errors: [{code: 'E_BODY_TOO_LARGE', message: 'Too big.'}]})));
    expect(await putFile(upload, new Blob(['abc']))).toEqual({ok: false, status: 413, code: 'E_BODY_TOO_LARGE', message: 'Too big.'});
  });
});
