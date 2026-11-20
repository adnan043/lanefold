import {env} from 'cloudflare:workers';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {allowVideo, confirm, createUpload, getVideos, listVideos, playback, video} from '../src/platform/video';
import {
  attachVideo,
  linkExpired,
  resumableUpload,
  uploadVideo,
  videoProblem,
  type VideoUploadGrant,
} from '../src/platform/video-browser';

const KEY = 'stk_0123456789abcdef_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const ID = 'vid_abcdefghijklmnopqrstuvwx';
const vars = env as Record<string, string | undefined>;

afterEach(() => {
  vi.unstubAllGlobals();
  delete vars.SITE_KEY;
  delete vars.SITE_URL;
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});

const lastCall = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.at(-1) as unknown as [string, RequestInit];

describe('video: server helper', () => {
  it('asks for an upload with the Site Key, on the platform origin', async () => {
    vars.SITE_KEY = KEY;
    vars.SITE_URL = 'https://shop.example';
    const fetch = vi.fn(async () =>
      json(201, {data: {video: {id: ID}, upload: {protocol: 'tus', endpoint: 'https://up.example/tus', headers: {}, expiresAt: 'x'}}})
    );
    vi.stubGlobal('fetch', fetch);
    const res = await createUpload('https://shop.example/site-api/videos/uploads', {
      name: '  Welcome.mp4 ',
      size: 1000,
      contentType: 'video/mp4',
      declaredSeconds: 61.2,
    });
    expect(res.ok).toBe(true);
    const [url, init] = lastCall(fetch);
    expect(url).toBe('https://shop.example/api/site/v1/videos/uploads');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({title: 'Welcome.mp4', size: 1000, contentType: 'video/mp4', lengthSeconds: 62});
  });

  it('refuses a bad video id before calling', async () => {
    vars.SITE_KEY = KEY;
    vi.stubGlobal('fetch', vi.fn());
    await expect(confirm('https://shop.example/', '../files')).rejects.toThrow('Not a video id.');
  });

  it('confirm returns the video', async () => {
    vars.SITE_KEY = KEY;
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {data: {video: {id: ID, status: 'processing'}}})));
    const res = await confirm('https://shop.example/', ID);
    expect(res).toEqual({ok: true, data: {id: ID, status: 'processing'}});
  });

  it('lists with a bounded limit', async () => {
    vars.SITE_KEY = KEY;
    const fetch = vi.fn(async () => json(200, {data: {videos: [], next: null}}));
    vi.stubGlobal('fetch', fetch);
    await listVideos('https://shop.example/', {before: 'c1', limit: 500});
    expect(lastCall(fetch)[0]).toBe('https://shop.example/api/site/v1/videos?before=c1&limit=100');
  });

  it('playback sends the viewer and reads an HLS link', async () => {
    vars.SITE_KEY = KEY;
    const fetch = vi.fn(async () =>
      json(200, {data: {url: 'https://watch.example/t/v/playlist.m3u8', expiresAt: '2030-01-01T00:00:00Z', kind: 'hls'}})
    );
    vi.stubGlobal('fetch', fetch);
    const res = await video.playback('https://shop.example/', ID, {viewerId: '42', ip: '203.0.113.9'});
    expect(res).toEqual({ok: true, data: {url: 'https://watch.example/t/v/playlist.m3u8', expiresAt: '2030-01-01T00:00:00Z', kind: 'hls'}});
    const [url, init] = lastCall(fetch);
    expect(url).toBe(`https://shop.example/api/site/v1/videos/${ID}/playback`);
    expect(JSON.parse(String(init.body))).toEqual({viewer: {id: '42', ip: '203.0.113.9'}});
  });

  it('playback treats an mp4 link as a plain file (the local sample)', async () => {
    vars.SITE_KEY = KEY;
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {data: {url: 'https://api.example/s/sample.mp4?t=1', expiresAt: 'x', type: 'application/x-mpegURL'}})));
    const res = await playback('https://shop.example/', ID, {viewerId: 's_1'});
    expect(res.ok && res.data.kind).toBe('file');
  });

  it('playback never sends an email as the viewer, nor a bad IP', async () => {
    vars.SITE_KEY = KEY;
    const fetch = vi.fn(async () => json(200, {data: {url: 'https://w.example/p.m3u8', expiresAt: 'x'}}));
    vi.stubGlobal('fetch', fetch);
    const bad = await playback('https://shop.example/', ID, {viewerId: 'maya@example.com'});
    expect(bad.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect((await playback('https://shop.example/', ID, {viewerId: ''})).ok).toBe(false);
    await playback('https://shop.example/', ID, {viewerId: '7', ip: '<script>'});
    expect(JSON.parse(String(lastCall(fetch)[1].body))).toEqual({viewer: {id: '7'}});
  });

  it('playback sends a guest as one, and never without the visitor IP', async () => {
    vars.SITE_KEY = KEY;
    const fetch = vi.fn(async () => json(200, {data: {url: 'https://w.example/p.m3u8', expiresAt: 'x'}}));
    vi.stubGlobal('fetch', fetch);
    const none = await playback('https://shop.example/', ID, {viewerId: 'guest:abc', guest: true});
    expect(none).toMatchObject({ok: false, status: 422, code: 'E_VIDEO_GUEST_IP_REQUIRED'});
    expect(fetch).not.toHaveBeenCalled();
    await playback('https://shop.example/', ID, {viewerId: 'guest:abc', guest: true, ip: '198.51.100.4'});
    expect(JSON.parse(String(lastCall(fetch)[1].body))).toEqual({
      viewer: {id: 'guest:abc', ip: '198.51.100.4', guest: true},
    });
  });

  it('carries the error code and retryAfter', async () => {
    vars.SITE_KEY = KEY;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(429, {errors: [{code: 'E_VIDEO_RATE_LIMITED', message: 'Slow down.', payload: {retryAfter: 12.2}}]}))
    );
    expect(await playback('https://shop.example/', ID, {viewerId: '1'})).toEqual({
      ok: false,
      status: 429,
      code: 'E_VIDEO_RATE_LIMITED',
      message: 'Slow down.',
      retryAfter: 13,
    });
    vi.stubGlobal('fetch', vi.fn(async () => json(429, {errors: [{code: 'E_VIDEO_RATE_LIMITED'}]}, {'retry-after': '30'})));
    const res = await playback('https://shop.example/', ID, {viewerId: '1'});
    expect(!res.ok && res.retryAfter).toBe(30);
  });

  it('never throws on a network failure', async () => {
    vars.SITE_KEY = KEY;
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('down'))));
    const res = await playback('https://shop.example/', ID, {viewerId: '1'});
    expect(!res.ok && res.code).toBe('E_PLATFORM_UNREACHABLE');
  });

  it('allowVideo adds the upload and playback hosts to connect-src, and links it was given', async () => {
    vars.SITE_KEY = KEY;
    const fetch = vi.fn(async () => json(200, {data: {uploadOrigin: 'https://up.example', playbackOrigin: 'https://watch.example'}}));
    vi.stubGlobal('fetch', fetch);
    const directives: string[] = [];
    await allowVideo({insertDirective: d => directives.push(d)}, 'https://shop.example/', [{url: 'https://cdn2.example/a/playlist.m3u8'}]);
    expect(directives).toEqual(["connect-src 'self' https://up.example https://watch.example https://cdn2.example"]);
    expect(lastCall(fetch)[0]).toMatch(/\/api\/site\/v1\/videos\/origins$/); // the static call, never /usage
    await allowVideo({insertDirective: d => directives.push(d)}, 'https://shop.example/');
    expect(fetch).toHaveBeenCalledTimes(1); // remembered
  });

  it('allowVideo: a local platform only on a local page; https-only everywhere else', async () => {
    vars.SITE_KEY = KEY;
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(Date.now() + 11 * 60_000); // past the earlier tests' cache
    const fetch = vi.fn(async () =>
      json(200, {data: {uploadOrigin: 'http://localhost:3340', playbackOrigin: 'http://localhost:3340'}})
    );
    vi.stubGlobal('fetch', fetch);
    const local: string[] = [];
    await allowVideo({insertDirective: d => local.push(d)}, 'http://localhost:4321/videos/');
    expect(local).toEqual([
      "connect-src 'self' http://localhost:3340",
      "media-src 'self' https: blob: http://localhost:3340",
      "img-src 'self' https: data: http://localhost:3340",
    ]);
    const live: string[] = [];
    await allowVideo({insertDirective: d => live.push(d)}, 'https://shop.example/videos/', [
      {url: 'http://127.0.0.1:3340/x/playlist.m3u8'},
      {url: 'https://cdn.example/x/playlist.m3u8'},
    ]);
    // A page not served locally never gets an http host, from the platform or a link.
    expect(live).toEqual(["connect-src 'self' https://cdn.example"]);
    const local127: string[] = [];
    await allowVideo({insertDirective: d => local127.push(d)}, 'http://127.0.0.1:4321/', [{url: 'http://127.0.0.1:3340/a.mp4'}]);
    expect(local127[0]).toBe("connect-src 'self' http://localhost:3340 http://127.0.0.1:3340");
    // Never another plain-http host, even on a local page.
    const other: string[] = [];
    await allowVideo({insertDirective: d => other.push(d)}, 'http://localhost:4321/', [{url: 'http://evil.example/x.m3u8'}]);
    expect(other[0]).toBe("connect-src 'self' http://localhost:3340");
    vi.useRealTimers();
  });

  it('allowVideo asks once for concurrent views, and remembers a failure for a minute', async () => {
    vars.SITE_KEY = KEY;
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(Date.now() + 30 * 60_000); // past the earlier tests' 10 minutes
    const fresh = {allowVideo};
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const fetch = vi.fn(async () => {
      await gate;
      return json(503, {errors: [{code: 'E_DOWN'}]});
    });
    vi.stubGlobal('fetch', fetch);
    const csp = {insertDirective: () => undefined};
    const views = [1, 2, 3].map(() => fresh.allowVideo(csp, 'https://shop.example/'));
    release();
    await Promise.all(views);
    expect(fetch).toHaveBeenCalledTimes(1); // one ask for three views
    await fresh.allowVideo(csp, 'https://shop.example/');
    expect(fetch).toHaveBeenCalledTimes(1); // the failure is remembered
    vi.setSystemTime(Date.now() + 61_000);
    await fresh.allowVideo(csp, 'https://shop.example/');
    vi.useRealTimers();
    expect(fetch).toHaveBeenCalledTimes(2); // asked again after a minute
  });

  it('getVideos asks for several videos in one call', async () => {
    vars.SITE_KEY = KEY;
    const fetch = vi.fn(async () => json(200, {data: {videos: [{id: ID}], next: null}}));
    vi.stubGlobal('fetch', fetch);
    const res = await getVideos('https://shop.example/', [ID, ID, 'not-an-id']);
    expect(res.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lastCall(fetch)[0]).toMatch(new RegExp(`/api/site/v1/videos\\?ids=${ID}$`));
  });
});

/* ------------------------------ browser upload ------------------------------ */

interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Blob | null;
}

/** A stand-in XMLHttpRequest: `answer` decides each response. */
function fakeXhr(answer: (req: FakeRequest) => {status: number; headers?: Record<string, string | undefined>} | 'network-error') {
  const log: FakeRequest[] = [];
  class FakeXhr {
    status = 0;
    upload: {onprogress?: (e: {loaded: number}) => void} = {};
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;
    private req: FakeRequest = {method: '', url: '', headers: {}, body: null};
    private answerHeaders: Record<string, string | undefined> = {};
    open(method: string, url: string) {
      this.req = {method, url, headers: {}, body: null};
    }
    setRequestHeader(name: string, value: string) {
      this.req.headers[name] = value;
    }
    getResponseHeader(name: string) {
      return this.answerHeaders[name] ?? null;
    }
    abort() {
      queueMicrotask(() => this.onabort?.());
    }
    send(body: Blob | null) {
      this.req.body = body;
      log.push(this.req);
      const out = answer(this.req);
      queueMicrotask(() => {
        if (out === 'network-error') return this.onerror?.();
        this.status = out.status;
        this.answerHeaders = out.headers ?? {};
        if (body) this.upload.onprogress?.({loaded: body.size});
        this.onload?.();
      });
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  return log;
}

function memoryStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

const grant = (): VideoUploadGrant => ({
  video: {id: ID, title: 'Welcome', status: 'uploading', lengthSeconds: null, sizeBytes: null, createdAt: '', readyAt: null, deletesAt: null},
  upload: {
    protocol: 'tus',
    endpoint: 'https://up.example/tus',
    headers: {AuthorizationSignature: 'sig', VideoId: 'v1'},
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  },
});

const file = (size: number) => Object.assign(new Blob([new Uint8Array(size)], {type: 'video/mp4'}), {name: 'welcome.mp4', lastModified: 1});

describe('video: browser upload (tus)', () => {
  it('creates the upload, sends it in parts with the signed headers, reports progress', async () => {
    memoryStorage();
    let offset = 0;
    const log = fakeXhr(req => {
      if (req.method === 'POST') return {status: 201, headers: {Location: '/tus/abc'}};
      offset += req.body!.size;
      return {status: 204, headers: {'Upload-Offset': String(offset)}};
    });
    const progress: number[] = [];
    const res = await uploadVideo(grant(), file(25), {chunkBytes: 10, onProgress: p => progress.push(p.sentBytes)});
    expect(res.ok).toBe(true);
    expect(log.map(r => `${r.method} ${r.url} ${r.headers['Upload-Offset'] ?? ''}`.trim())).toEqual([
      'POST https://up.example/tus',
      'PATCH https://up.example/tus/abc 0',
      'PATCH https://up.example/tus/abc 10',
      'PATCH https://up.example/tus/abc 20',
    ]);
    expect(log[0].headers).toMatchObject({'Tus-Resumable': '1.0.0', 'Upload-Length': '25', AuthorizationSignature: 'sig', VideoId: 'v1'});
    expect(log[0].headers['Upload-Metadata']).toContain(`title ${btoa('Welcome')}`);
    expect(log[1].headers['Content-Type']).toBe('application/offset+octet-stream');
    expect(progress.at(-1)).toBe(25);
  });

  it('retries a dropped part, and resends from the offset the service has after a conflict', async () => {
    memoryStorage();
    let offset = 0;
    let dropped = false;
    let conflicted = false;
    const log = fakeXhr(req => {
      if (req.method === 'POST') return {status: 201, headers: {Location: 'https://up.example/tus/abc'}};
      if (req.method === 'HEAD') return {status: 200, headers: {'Upload-Offset': String(offset)}};
      if (!dropped) {
        dropped = true;
        return 'network-error';
      }
      if (offset === 10 && !conflicted) {
        conflicted = true;
        offset = 15; // a part landed but its answer was lost
        return {status: 409};
      }
      expect(req.headers['Upload-Offset']).toBe(String(offset));
      offset += req.body!.size;
      return {status: 204, headers: {'Upload-Offset': String(offset)}};
    });
    const res = await uploadVideo(grant(), file(20), {chunkBytes: 10, retryDelaysMs: [0, 0, 0, 0]});
    expect(res.ok).toBe(true);
    expect(offset).toBe(20);
    expect(log.some(r => r.method === 'HEAD')).toBe(true);
  });

  it('resumes after a reload: the same file carries on from the saved upload', async () => {
    memoryStorage();
    let offset = 0;
    fakeXhr(req => {
      if (req.method === 'POST') return {status: 201, headers: {Location: '/tus/abc'}};
      if (offset >= 10) return 'network-error';
      offset += req.body!.size;
      return {status: 204, headers: {'Upload-Offset': String(offset)}};
    });
    const first = await uploadVideo(grant(), file(20), {chunkBytes: 10, retryDelaysMs: []});
    expect(!first.ok && first.code).toBe('E_UPLOAD_FAILED');

    const saved = resumableUpload(file(20));
    expect(saved?.video.id).toBe(ID);
    const log = fakeXhr(req => {
      if (req.method === 'HEAD') return {status: 200, headers: {'Upload-Offset': '10'}};
      return {status: 204, headers: {'Upload-Offset': '20'}};
    });
    const second = await uploadVideo(saved!, file(20), {chunkBytes: 10});
    expect(second.ok).toBe(true);
    expect(log.map(r => r.method)).toEqual(['HEAD', 'PATCH']);
    expect(log[1].headers['Upload-Offset']).toBe('10');
    expect(resumableUpload(file(20))).toBeNull(); // done: forgotten
  });

  it('cancels', async () => {
    memoryStorage();
    fakeXhr(() => ({status: 201, headers: {Location: '/tus/abc'}}));
    const controller = new AbortController();
    controller.abort();
    const res = await uploadVideo(grant(), file(5), {signal: controller.signal, retryDelaysMs: [0]});
    expect(!res.ok && res.code).toBe('E_UPLOAD_CANCELED');
  });

  it('refuses an expired grant without sending anything', async () => {
    memoryStorage();
    const log = fakeXhr(() => ({status: 201}));
    const old = grant();
    old.upload.expiresAt = new Date(Date.now() - 1000).toISOString();
    const res = await uploadVideo(old, file(5));
    expect(!res.ok && res.code).toBe('E_UPLOAD_EXPIRED');
    expect(log).toHaveLength(0);
  });
});

/* -------------------------------- playback -------------------------------- */

describe('video: player helpers', () => {
  it('words for viewers never mention the plan', () => {
    for (const code of ['E_VIDEO_OVER_LIMIT', 'E_VIDEO_PAUSED', 'E_VIDEO_UNAVAILABLE']) {
      expect(videoProblem(code)).toMatchObject({screen: 'unavailable', title: 'This video can’t play right now'});
    }
    expect(videoProblem('E_VIDEO_PROCESSING').screen).toBe('processing');
    expect(videoProblem('E_VIDEO_NOT_READY').screen).toBe('processing');
    expect(videoProblem('E_VIDEO_RATE_LIMITED').screen).toBe('rate_limited');
  });

  it('a link is expired 30 seconds before its end', () => {
    const now = Date.parse('2030-01-01T00:00:00Z');
    expect(linkExpired({expiresAt: '2030-01-01T00:00:20Z'}, now)).toBe(true);
    expect(linkExpired({expiresAt: '2030-01-01T00:05:00Z'}, now)).toBe(false);
  });

  const element = (nativeHls: boolean) => {
    const listeners: Record<string, () => void> = {};
    return {
      src: '',
      currentTime: 0,
      paused: true,
      canPlayType: () => (nativeHls ? 'maybe' : ''),
      addEventListener: (name: string, fn: () => void) => (listeners[name] = fn),
      removeEventListener: () => {},
      removeAttribute: () => {},
      load: () => {},
      play: async () => {},
      listeners,
    };
  };
  const link = {url: 'https://watch.example/p.m3u8', expiresAt: new Date(Date.now() + 3600_000).toISOString(), kind: 'hls' as const};

  it('Safari plays HLS natively and never loads hls.js', async () => {
    const el = element(true);
    const loadHls = vi.fn();
    const res = await attachVideo(el as unknown as HTMLVideoElement, link, {loadHls});
    expect(res.ok).toBe(true);
    expect(el.src).toBe(link.url);
    expect(loadHls).not.toHaveBeenCalled();
  });

  it('elsewhere loads hls.js lazily, without a worker, and asks for a fresh link on a refused segment', async () => {
    const el = element(false);
    const made: Array<{config: Record<string, unknown>; source?: string; handler?: (e: string, d: object) => void}> = [];
    class FakeHls {
      static isSupported = () => true;
      static Events = {ERROR: 'hlsError'};
      static ErrorTypes = {NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError'};
      entry: (typeof made)[number];
      constructor(config: Record<string, unknown>) {
        this.entry = {config};
        made.push(this.entry);
      }
      on(_event: string, handler: (e: string, d: object) => void) {
        this.entry.handler = handler;
      }
      loadSource(url: string) {
        this.entry.source = url;
      }
      attachMedia() {}
      startLoad() {}
      destroy() {}
    }
    const onExpired = vi.fn();
    const res = await attachVideo(el as unknown as HTMLVideoElement, link, {
      loadHls: async () => ({default: FakeHls}),
      onExpired,
    });
    expect(res.ok).toBe(true);
    expect(made[0].config.enableWorker).toBe(false);
    made[0].handler!('hlsError', {fatal: true, type: 'networkError', response: {code: 403}});
    expect(onExpired).toHaveBeenCalledOnce();
    el.currentTime = 42;
    if (res.ok) res.data.swap({...link, url: 'https://watch.example/fresh.m3u8'});
    expect(made[1].source).toBe('https://watch.example/fresh.m3u8');
    expect(made[1].config.startPosition).toBe(42);
  });
});
