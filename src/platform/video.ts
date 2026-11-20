import {PLATFORM_HEADERS, platformOrigin, SiteKeyMissing} from './api';
import {config} from './config';
import type {PlaybackLink, Video, VideoErrorCode, VideoResult, VideoStatus, VideoUploadGrant} from './video-browser';

/**
 * Video on demand: videos the owner (or their staff) adds, played to the app's viewers with
 * adaptive streaming on every screen (`docs/agent/video.md`). Server code only: every call
 * carries the Site Key, which never reaches the browser. The owner adds a video plan in the
 * dashboard; videos use its hours (kept, and watched each month).
 *
 *   createUpload()   your route (after YOUR check of who may add videos) asks for a direct upload
 *                    for ONE video. The browser sends the bytes straight to the video service
 *                    with `uploadVideo()` (`./video-browser`), never through this site.
 *   confirm()        your route, when the browser's upload ended: the video is `processing`
 *                    until it is converted for every screen, then `ready`.
 *   playback()       your route, per viewer per page view, AFTER your own check that this viewer
 *                    may watch: a short-lived link for that viewer only. Never cache, store or
 *                    share it, never in static HTML.
 *   getVideo(), getVideos(ids), listVideos(), videoUsage()   one video, several in one call, the
 *                    app's videos, the plan's hours. videoOrigins(): the hosts for the page's CSP.
 *
 * There is no delete here: the owner deletes videos in the dashboard.
 *
 * Every function resolves to `{ok: true, data}` or `{ok: false, status, code, message}`; it never
 * throws into a page (except SiteKeyMissing: no Site Key on this machine). Branch on `code`.
 */

export type {
  PlaybackLink,
  Video,
  VideoErrorCode,
  VideoResult,
  VideoStatus,
  VideoUploadGrant,
} from './video-browser';

export interface VideoUsage {
  /** false = video isn't available to this app (no video plan, a trial, or not offered). */
  available: boolean;
  kept: {limitMinutes: number | null; usedMinutes: number; full: boolean | null};
  watched: {
    limitMinutes: number | null;
    usedMinutes: number;
    /** Share of the month's hours used, as told to the owner: 0, 80, 100, 120 (null = no limit shown). */
    stage: number | null;
    resetsAt: string | null;
  };
  /** Where the browser uploads (scheme + host), when the platform says. */
  uploadOrigin?: string | null;
  /** Where playback links point (scheme + host), when the platform says. */
  playbackOrigin?: string | null;
}

/** Types a video upload may be (the video service converts them all). */
export const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/x-msvideo'] as const;

/** The platform's ceiling for one video's length. Set your OWN, lower one per feature. */
export const MAX_VIDEO_SECONDS = 24 * 3600;

const TIMEOUT_MS = 8000;
const VIDEO_ID = /^vid_[a-z2-7]{6,40}$/;
const VIEWER_ID = /^[\x21-\x7e]{1,128}$/;
const IP = /^[0-9a-f.:]{2,45}$/i;

export const isVideoId = (id: unknown): id is string => typeof id === 'string' && VIDEO_ID.test(id);

async function call<T>(
  requestUrl: string | URL,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = TIMEOUT_MS
): Promise<VideoResult<T>> {
  const key = config.siteKey;
  if (!key) throw new SiteKeyMissing();
  let res: Response;
  try {
    res = await fetch(`${platformOrigin(requestUrl)}/api/site/v1/videos${path}`, {
      method,
      headers: {
        ...PLATFORM_HEADERS,
        authorization: `Bearer ${key}`,
        ...(method === 'POST' ? {'content-type': 'application/json'} : {}),
      },
      ...(method === 'POST' ? {body: JSON.stringify(body ?? {})} : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {ok: false, status: 0, code: 'E_PLATFORM_UNREACHABLE', message: 'Video did not answer. Try again.'};
  }
  const answer = (await res.json().catch(() => null)) as
    | {data?: T; errors?: Array<{code?: string; message?: string; retryAfter?: number; payload?: {retryAfter?: number}}>}
    | null;
  if (res.ok && answer?.data !== undefined) return {ok: true, data: answer.data};
  const error = answer?.errors?.[0];
  const header = Number(res.headers.get('retry-after'));
  const given = error?.payload?.retryAfter ?? error?.retryAfter;
  const retryAfter =
    typeof given === 'number' && given > 0
      ? Math.ceil(given)
      : Number.isFinite(header) && header > 0
        ? Math.ceil(header)
        : undefined;
  return {
    ok: false,
    status: res.status,
    code: error?.code ?? `HTTP_${res.status}`,
    message: error?.message ?? 'Video could not do that. Try again.',
    ...(retryAfter ? {retryAfter} : {}),
  };
}

const idPath = (id: string) => {
  if (!isVideoId(id)) throw new Error('Not a video id.');
  return `/${id}`;
};

export interface CreateVideoUploadInput {
  /** The title people see (the file's name is fine). 1 to 200 characters. */
  name: string;
  /** The file's exact size in bytes. */
  size: number;
  contentType: string;
  /** The video's length if the browser knows it: the upload holds only that much of the plan's kept hours. */
  declaredSeconds?: number;
}

/** Step 1: a direct upload for one video (give the browser the whole answer, keep `video.id`). */
export function createUpload(requestUrl: string | URL, input: CreateVideoUploadInput) {
  const title = String(input.name ?? '').trim().slice(0, 200) || 'Video';
  const seconds =
    typeof input.declaredSeconds === 'number' && input.declaredSeconds > 0
      ? Math.min(MAX_VIDEO_SECONDS, Math.ceil(input.declaredSeconds))
      : undefined;
  return call<VideoUploadGrant>(requestUrl, 'POST', '/uploads', {
    title,
    size: input.size,
    contentType: input.contentType,
    ...(seconds ? {lengthSeconds: seconds} : {}),
  });
}

/** Step 3: after the browser's upload. The video is `processing` (or `ready`, or `failed`). */
export async function confirm(requestUrl: string | URL, id: string): Promise<VideoResult<Video>> {
  const res = await call<{video: Video}>(requestUrl, 'POST', `${idPath(id)}/complete`);
  return res.ok ? {ok: true, data: res.data.video} : res;
}

export async function getVideo(requestUrl: string | URL, id: string): Promise<VideoResult<Video>> {
  const res = await call<{video: Video}>(requestUrl, 'GET', idPath(id));
  return res.ok ? {ok: true, data: res.data.video} : res;
}

/** This app's videos, newest first. `before` = the `next` of the previous page. */
export function listVideos(requestUrl: string | URL, options: {before?: string; limit?: number} = {}) {
  const query = new URLSearchParams();
  if (options.before) query.set('before', options.before);
  if (options.limit) query.set('limit', String(Math.min(100, Math.max(1, Math.floor(options.limit)))));
  const qs = query.toString();
  return call<{videos: Video[]; next: string | null}>(requestUrl, 'GET', qs ? `?${qs}` : '');
}

/**
 * Several of this app's videos in ONE call (up to 50 ids, in that order; unknown ids are left out).
 * Use it for a page that shows a few videos instead of one `video()` call each.
 */
export function getVideos(requestUrl: string | URL, ids: string[]) {
  const wanted = [...new Set(ids)].filter(isVideoId).slice(0, 50);
  if (!wanted.length) return Promise.resolve({ok: true, data: {videos: [] as Video[], next: null}} as VideoResult<{videos: Video[]; next: string | null}>);
  return call<{videos: Video[]; next: string | null}>(requestUrl, 'GET', `?ids=${wanted.join(',')}`);
}

/** The plan's hours for this app: kept and watched this month. For the OWNER's screens only. */
export function videoUsage(requestUrl: string | URL) {
  return call<VideoUsage>(requestUrl, 'GET', '/usage');
}

/** Where the browser uploads and plays (scheme + host). Static and cheap: what `allowVideo` asks. */
export function videoOrigins(requestUrl: string | URL) {
  return call<{uploadOrigin: string | null; playbackOrigin: string | null}>(requestUrl, 'GET', '/origins', undefined, ORIGIN_TIMEOUT_MS);
}

export interface PlaybackViewer {
  /** Who watches: your user's id, or a session id for a guest your app lets watch. Opaque, 1 to 128 characters; never an email. */
  viewerId: string;
  /** The viewer's IP as this server saw it: `viewerIp(c.req.raw)` (the `CF-Connecting-IP` header). Required for a guest. */
  ip?: string | null;
  /** True for a viewer who isn't signed in (a session id your page picked): `ip` must be sent too. */
  guest?: boolean;
}

/**
 * A fresh playback link for ONE viewer, for this page view. Call it only AFTER your own check that
 * this viewer may watch this video, ONCE per page view (never in a loop, never ahead for many videos:
 * 30 links a minute and 300 an hour per viewer, 60 a minute and 600 an hour per network address).
 * Always pass `ip` when known: the platform limits links per network with it and may bind the link to
 * it. A guest (`guest: true`, not signed in) MUST send `ip`: without it the platform answers 422
 * E_VIDEO_GUEST_IP_REQUIRED (checked here first). Errors: 403 E_VIDEO_PROCESSING (still being converted), E_VIDEO_OVER_LIMIT,
 * E_VIDEO_PAUSED, E_VIDEO_UNAVAILABLE (can't play right now); 404 E_VIDEO_NOT_FOUND;
 * 429 E_VIDEO_RATE_LIMITED (wait `retryAfter` seconds, then try once more).
 */
export async function playback(
  requestUrl: string | URL,
  id: string,
  viewer: PlaybackViewer
): Promise<VideoResult<PlaybackLink>> {
  const viewerId = String(viewer?.viewerId ?? '');
  if (!VIEWER_ID.test(viewerId) || viewerId.includes('@')) {
    return {ok: false, status: 422, code: 'E_VIEWER_ID', message: 'A viewer id is 1 to 128 characters, not an email.'};
  }
  const ip = typeof viewer.ip === 'string' && IP.test(viewer.ip) ? viewer.ip : undefined;
  const guest = viewer.guest === true;
  if (guest && !ip) {
    return {ok: false, status: 422, code: 'E_VIDEO_GUEST_IP_REQUIRED', message: "A guest's playback needs their IP: pass viewerIp(c.req.raw)."};
  }
  const res = await call<{url: string; expiresAt: string; kind?: string; type?: string}>(
    requestUrl,
    'POST',
    `${idPath(id)}/playback`,
    {viewer: {id: viewerId, ...(ip ? {ip} : {}), ...(guest ? {guest: true} : {})}}
  );
  if (!res.ok) return res;
  const {url, expiresAt} = res.data;
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    return {ok: false, status: 502, code: 'E_PLAYER_FAILED', message: 'Video gave no link. Try again.'};
  }
  const kind = res.data.kind === 'file' || /\.mp4$/i.test(path) ? 'file' : 'hls';
  return {ok: true, data: {url, expiresAt, kind}};
}

/** The viewer's IP on this request, for playback(). */
export const viewerIp = (request: Request): string | undefined =>
  request.headers.get('cf-connecting-ip') ?? undefined;

/** The same helpers as one object: `video.playback(c.req.url, id, {...})`. */
export const video = {
  createUpload,
  confirm,
  get: getVideo,
  getMany: getVideos,
  list: listVideos,
  usage: videoUsage,
  playback,
  allowEmbeds: allowVideoEmbeds,
} as const;

interface CspApi {
  insertDirective: (directive: string) => void;
}

const ORIGIN_TTL_MS = 10 * 60 * 1000;
/** A failed or slow answer is remembered for a minute: a page never waits on it again and again. */
const ORIGIN_FAIL_MS = 60 * 1000;
const ORIGIN_TIMEOUT_MS = 1500;
let originCache: {origins: string[]; until: number} | null = null;
/** One request at a time: concurrent page views wait for the same answer. */
let originPending: Promise<void> | null = null;
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;
/** Local development only: the platform on this machine (accepted only when the page is local too). */
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

/** Is this page served from this machine (`npm run dev` against a local platform)? */
const isLocalPage = (requestUrl: string | URL) => {
  try {
    const host = new URL(requestUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
};

/** An https origin; also http://localhost / 127.0.0.1 when `local` (the page itself is local). */
const originOf = (url: string | null | undefined, local = false): string | null => {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return HTTPS_ORIGIN.test(origin) || (local && LOCAL_ORIGIN.test(origin)) ? origin : null;
  } catch {
    return null;
  }
};

/**
 * Call in the frontmatter of EVERY page that uploads or plays video (a public page, or the
 * portal page that hosts a video screen): adds the video service's upload and playback addresses
 * to that page's `connect-src` (the rest of the site keeps `'self'`). Asks `/origins` (static, 1.5 s
 * at most), remembered for 10 minutes per Worker (a failure for 1 minute); concurrent views share
 * one ask. `links` are playback links this page already has (their host is added too).
 * Only https hosts, except in local development: a page served from localhost/127.0.0.1 also
 * accepts a platform on http://localhost or 127.0.0.1, and then adds it to `media-src` and
 * `img-src` too (the site-wide policy there is `'self' https:`).
 * `await allowVideo(Astro.csp, Astro.url)`
 */
export async function allowVideo(
  csp: CspApi | undefined,
  requestUrl: string | URL,
  links: Array<Pick<PlaybackLink, 'url'>> = []
): Promise<void> {
  if (!csp) return;
  if (!originCache || originCache.until < Date.now()) {
    originPending ??= (async () => {
      const res = await videoOrigins(requestUrl).catch(() => null);
      if (res?.ok) {
        // Kept as answered (https or local); which ones a page may use is decided per page below.
        const origins = [res.data.uploadOrigin, res.data.playbackOrigin]
          .map(o => originOf(o, true))
          .filter((o): o is string => !!o);
        originCache = {origins, until: Date.now() + ORIGIN_TTL_MS};
      } else {
        // Unreachable, slow (1.5 s) or refused: no video hosts for a minute, then ask again.
        originCache = {origins: originCache?.origins ?? [], until: Date.now() + ORIGIN_FAIL_MS};
      }
    })().finally(() => {
      originPending = null;
    });
    await originPending;
  }
  const local = isLocalPage(requestUrl);
  const all = new Set(
    [...(originCache?.origins ?? []), ...links.map(link => link.url)]
      .map(o => originOf(o, local))
      .filter((o): o is string => !!o)
  );
  if (!all.size) return;
  csp.insertDirective(`connect-src 'self' ${[...all].join(' ')}`);
  // Local development: the http platform isn't covered by the site's `https:` media and image rules.
  const plain = [...all].filter(o => o.startsWith('http:'));
  if (plain.length) {
    csp.insertDirective(`media-src 'self' https: blob: ${plain.join(' ')}`);
    csp.insertDirective(`img-src 'self' https: data: ${plain.join(' ')}`);
  }
}

interface EmbedCspApi extends CspApi {
  insertScriptResource?: (resource: string) => void;
}

/**
 * What each embed needs on the page's CSP. YouTube and Vimeo play through the player, which loads
 * their player API; Wistia plays in its own iframe, so it needs only `frame-src`.
 */
const EMBED_CSP: Record<'youtube' | 'vimeo' | 'wistia', {script: readonly string[]; connect: readonly string[]; frame: readonly string[]}> = {
  youtube: {script: ['https://www.youtube.com'], connect: [], frame: ['https://www.youtube.com', 'https://www.youtube-nocookie.com']},
  vimeo: {script: [], connect: ['https://vimeo.com'], frame: ['https://player.vimeo.com']},
  wistia: {script: [], connect: [], frame: ['https://fast.wistia.net', 'https://fast.wistia.com']},
};

export type VideoEmbedKind = keyof typeof EMBED_CSP;

/**
 * A page that plays a YouTube, Vimeo or Wistia video in `VideoPlayer` (`embedUrl`): lets that
 * page's CSP load the embed's own player, for the kinds it plays (all three by default). Wistia is
 * an iframe only (`frame-src`), never a script. Call it in
 * the page's frontmatter, like `allowVideo`: `allowVideoEmbeds(Astro.csp, ['youtube'])`. Every
 * other page keeps the site's policy.
 */
export function allowVideoEmbeds(
  csp: EmbedCspApi | undefined,
  kinds: readonly VideoEmbedKind[] = ['youtube', 'vimeo', 'wistia']
): void {
  if (!csp) return;
  const script = new Set<string>();
  const connect = new Set<string>();
  const frame = new Set<string>();
  for (const kind of kinds) {
    for (const s of EMBED_CSP[kind]?.script ?? []) script.add(s);
    for (const c of EMBED_CSP[kind]?.connect ?? []) connect.add(c);
    for (const f of EMBED_CSP[kind]?.frame ?? []) frame.add(f);
  }
  for (const s of script) csp.insertScriptResource?.(s);
  if (connect.size) csp.insertDirective(`connect-src 'self' ${[...connect].join(' ')}`);
  if (frame.size) csp.insertDirective(`frame-src ${[...frame].join(' ')}`);
}
