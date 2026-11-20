/**
 * Video, the BROWSER's half (`docs/agent/video.md`). No secrets here: the server's helper
 * (`src/platform/video.ts`) asks the platform with the Site Key; the browser only gets what that
 * answered for ONE video:
 *
 *   uploadVideo(grant, file)     sends the bytes straight to the video service (resumable uploads,
 *                                the "tus" protocol), with progress, retry, resume and cancel.
 *                                The bytes never pass through this site's server.
 *   attachVideo(el, link)        plays a playback link in a <video> element: HLS natively (Safari)
 *                                or with hls.js, which the CALLER loads lazily (`loadHls`), so a
 *                                page without video never downloads it. Kept for sites whose own
 *                                player uses it; `VideoPlayer` plays with `./player/` instead.
 *   videoProblem(code)           the plain words for a state a player shows.
 *
 * Everything here resolves to `{ok: true, data}` or `{ok: false, status, code, message}`, like the
 * server helper; it never throws into a page and never shows anything itself.
 */

/** Where a video is. Only `ready` plays. */
export type VideoStatus = 'uploading' | 'processing' | 'ready' | 'failed' | 'over_limit';

export interface Video {
  /** `vid_…`: keep this in your own table, never the video. */
  id: string;
  title: string;
  status: VideoStatus;
  lengthSeconds: number | null;
  sizeBytes: number | null;
  createdAt: string;
  readyAt: string | null;
  /** `over_limit`: when it is deleted unless the owner makes room. */
  deletesAt: string | null;
  /** A signed still from the video, when the platform gives one (never build one; use your own poster otherwise). */
  thumbnailUrl?: string | null;
}

/** The direct upload for ONE video, as the server's createUpload() answered. */
export interface VideoUploadGrant {
  video: Video;
  upload: {
    protocol: 'tus';
    /** Where the browser creates the upload. */
    endpoint: string;
    /** Signed for this one video only, until `expiresAt`. Not the Site Key. */
    headers: Record<string, string>;
    expiresAt: string;
  };
}

/** A playback link for ONE viewer. Short-lived: never store, cache or share it. */
export interface PlaybackLink {
  url: string;
  expiresAt: string;
  /** `hls` = an adaptive playlist; `file` = a plain video file (the local sample). */
  kind: 'hls' | 'file';
}

export type VideoErrorCode =
  | 'E_VIDEO_PROCESSING'
  | 'E_VIDEO_NOT_READY'
  | 'E_VIDEO_OVER_LIMIT'
  | 'E_VIDEO_PAUSED'
  | 'E_VIDEO_UNAVAILABLE'
  | 'E_VIDEO_RATE_LIMITED'
  | 'E_VIDEO_GUEST_IP_REQUIRED'
  | 'E_VIDEO_NOT_FOUND'
  | 'E_VIDEO_NEEDS_PLAN'
  | 'E_VIDEO_NOT_INCLUDED'
  | 'E_VIDEO_TRIAL'
  | 'E_VIDEO_KEPT_LIMIT'
  | 'E_VIDEO_TOO_MANY_UPLOADS'
  | 'E_VIDEO_BUSY'
  | 'E_NOT_APP'
  | 'E_PLATFORM_UNREACHABLE'
  | 'E_UPLOAD_FAILED'
  | 'E_UPLOAD_EXPIRED'
  | 'E_UPLOAD_CANCELED'
  | 'E_PLAYER_UNSUPPORTED'
  | 'E_PLAYER_FAILED'
  | (string & {});

export type VideoResult<T> =
  | {ok: true; data: T}
  | {ok: false; status: number; code: VideoErrorCode; message: string; retryAfter?: number};

/** What a player shows instead of the video. */
export type VideoScreen = 'processing' | 'unavailable' | 'rate_limited' | 'not_found' | 'failed';

/**
 * The screen and words for a code, for VIEWERS. Over the limit, paused and unavailable all read
 * "This video can't play right now": a viewer never sees the owner's plan. The owner's admin
 * screens may say more (`docs/agent/video.md`, "Each state").
 */
export function videoProblem(code: VideoErrorCode): {screen: VideoScreen; title: string; message: string} {
  switch (code) {
    case 'E_VIDEO_PROCESSING':
    case 'E_VIDEO_NOT_READY':
      return {
        screen: 'processing',
        title: 'Getting this video ready',
        message: 'It will play in a few minutes. Check back soon.',
      };
    case 'E_VIDEO_RATE_LIMITED':
      return {screen: 'rate_limited', title: 'Too many plays at once', message: 'Wait a moment, then try again.'};
    case 'E_VIDEO_NOT_FOUND':
      return {screen: 'not_found', title: 'This video isn’t here', message: 'It may have been removed.'};
    case 'E_PLAYER_UNSUPPORTED':
      return {screen: 'failed', title: 'This browser can’t play it', message: 'Try another browser, or update this one.'};
    case 'E_PLATFORM_UNREACHABLE':
    case 'E_PLAYER_FAILED':
      return {screen: 'failed', title: 'The video stopped', message: 'Check your connection, then try again.'};
    default:
      return {screen: 'unavailable', title: 'This video can’t play right now', message: 'Try again later.'};
  }
}

/* --------------------------------- upload --------------------------------- */

const TUS_VERSION = '1.0.0';
/** Sent in parts this big, so a dropped connection loses one part, not the whole file. */
export const VIDEO_CHUNK_BYTES = 32 * 1024 * 1024;
const RETRY_DELAYS_MS = [1000, 3000, 6000, 12000];
const RESUME_PREFIX = 'video-upload:';

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
  /** 0 to 1. */
  share: number;
}

export interface UploadVideoOptions {
  onProgress?: (progress: UploadProgress) => void;
  /** Abort to cancel: resolves `E_UPLOAD_CANCELED`. The platform removes an upload never confirmed. */
  signal?: AbortSignal;
  /** Part size (tests); default VIDEO_CHUNK_BYTES. */
  chunkBytes?: number;
  /** Delays between retries of one part (tests); default 1, 3, 6, 12 seconds. */
  retryDelaysMs?: number[];
}

interface Sent {
  status: number;
  header: (name: string) => string | null;
}

/** One request with upload progress (fetch has none). XMLHttpRequest exists in every browser. */
function send(
  method: 'POST' | 'HEAD' | 'PATCH',
  url: string,
  headers: Record<string, string>,
  body: Blob | null,
  signal: AbortSignal | undefined,
  onSent?: (bytes: number) => void
): Promise<Sent> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    if (onSent && xhr.upload) xhr.upload.onprogress = event => onSent(event.loaded);
    const abort = () => xhr.abort();
    signal?.addEventListener('abort', abort, {once: true});
    const done = () => signal?.removeEventListener('abort', abort);
    xhr.onload = () => {
      done();
      resolve({status: xhr.status, header: name => xhr.getResponseHeader(name)});
    };
    xhr.onerror = () => {
      done();
      reject(new Error('network'));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    xhr.send(body);
  });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      {once: true}
    );
  });

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

/** The same picked file, across a reload: name, size, last change. */
export function fileFingerprint(file: Blob & {name?: string; lastModified?: number}): string {
  return `${file.name ?? 'video'}:${file.size}:${file.lastModified ?? 0}`;
}

interface Saved {
  grant: VideoUploadGrant;
  location: string;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * An unfinished upload of this same file, kept in this browser until its grant expires: pass its
 * grant to uploadVideo() instead of asking the server for a new one, and it carries on where it
 * stopped. Null when there is none, or it expired.
 */
export function resumableUpload(file: Blob & {name?: string; lastModified?: number}): VideoUploadGrant | null {
  const store = storage();
  const key = RESUME_PREFIX + fileFingerprint(file);
  try {
    const saved = JSON.parse(store?.getItem(key) ?? 'null') as Saved | null;
    if (!saved?.grant?.upload?.expiresAt) return null;
    if (Date.parse(saved.grant.upload.expiresAt) - Date.now() < 60_000) {
      store?.removeItem(key);
      return null;
    }
    return saved.grant;
  } catch {
    return null;
  }
}

function savedLocation(file: Blob & {name?: string}, grant: VideoUploadGrant): string | null {
  try {
    const saved = JSON.parse(storage()?.getItem(RESUME_PREFIX + fileFingerprint(file)) ?? 'null') as Saved | null;
    return saved?.grant?.video?.id === grant.video.id ? saved.location : null;
  } catch {
    return null;
  }
}

function remember(file: Blob & {name?: string}, grant: VideoUploadGrant, location: string) {
  try {
    storage()?.setItem(RESUME_PREFIX + fileFingerprint(file), JSON.stringify({grant, location} satisfies Saved));
  } catch {
    // Private window or full storage: the upload still works, it just can't resume after a reload.
  }
}

function forget(file: Blob & {name?: string}) {
  try {
    storage()?.removeItem(RESUME_PREFIX + fileFingerprint(file));
  } catch {
    // nothing to forget
  }
}

const fail = (status: number, code: VideoErrorCode, message: string) =>
  ({ok: false, status, code, message}) as const;

/**
 * Sends `file` straight to the video service with the grant your route got from createUpload().
 * Resolves to the video (still `uploading`: then call your route's confirm step) or an error with
 * words for people. A dropped connection is retried; a grant this browser started before (see
 * resumableUpload) continues from where it stopped.
 */
export async function uploadVideo(
  grant: VideoUploadGrant,
  file: Blob & {name?: string; type?: string; lastModified?: number},
  options: UploadVideoOptions = {}
): Promise<VideoResult<Video>> {
  const {signal, onProgress} = options;
  const chunk = Math.max(1, options.chunkBytes ?? VIDEO_CHUNK_BYTES);
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const total = file.size;
  const base = {...grant.upload.headers, 'Tus-Resumable': TUS_VERSION};
  const report = (sent: number) =>
    onProgress?.({sentBytes: sent, totalBytes: total, share: total ? Math.min(1, sent / total) : 1});

  if (Date.parse(grant.upload.expiresAt) <= Date.now()) {
    forget(file);
    return fail(0, 'E_UPLOAD_EXPIRED', 'This upload took too long to start. Pick the file again.');
  }

  let attempt = 0;
  /** Runs `step`, retrying a dropped connection or a busy server with growing waits. */
  async function retrying<T>(step: () => Promise<T | 'retry'>): Promise<T> {
    for (;;) {
      let out: T | 'retry';
      try {
        out = await step();
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') throw error;
        out = 'retry';
      }
      if (out !== 'retry') {
        attempt = 0;
        return out;
      }
      if (attempt >= delays.length) throw new Error('gave_up');
      await sleep(delays[attempt++], signal);
    }
  }

  try {
    // 1. Where the bytes go: an upload this browser started, or a new one.
    let location = savedLocation(file, grant);
    let offset = 0;
    if (location) {
      const head = await retrying(async () => {
        const res = await send('HEAD', location!, base, null, signal);
        if (res.status >= 500 || res.status === 423) return 'retry';
        return res;
      });
      const at = Number(head.header('Upload-Offset'));
      if (head.status >= 200 && head.status < 300 && Number.isFinite(at)) offset = at;
      else location = null; // gone or expired at the service: start again
    }
    if (!location) {
      const metadata = [`filetype ${b64(file.type || 'video/mp4')}`, `title ${b64(grant.video.title || file.name || 'video')}`];
      const created = await retrying(async () => {
        const res = await send(
          'POST',
          grant.upload.endpoint,
          {...base, 'Upload-Length': String(total), 'Upload-Metadata': metadata.join(',')},
          null,
          signal
        );
        if (res.status >= 500 || res.status === 423) return 'retry';
        return res;
      });
      const where = created.header('Location');
      if (created.status !== 201 || !where) {
        return created.status === 401 || created.status === 403
          ? fail(created.status, 'E_UPLOAD_EXPIRED', 'This upload is no longer allowed. Pick the file again.')
          : fail(created.status, 'E_UPLOAD_FAILED', 'The upload didn’t start. Try again.');
      }
      location = new URL(where, grant.upload.endpoint).toString();
      offset = 0;
      remember(file, grant, location);
    }
    report(offset);

    // 2. The bytes, one part at a time, each from the offset the service confirmed.
    while (offset < total) {
      const res = await retrying(async () => {
        const from = offset;
        const part = file.slice(from, Math.min(total, from + chunk));
        const sent = await send(
          'PATCH',
          location!,
          {...base, 'Upload-Offset': String(from), 'Content-Type': 'application/offset+octet-stream'},
          part,
          signal,
          bytes => report(from + bytes)
        );
        if (sent.status === 409) {
          // The service has another offset (a part landed but its answer was lost): ask it, resend from there.
          const head = await send('HEAD', location!, base, null, signal);
          const at = Number(head.header('Upload-Offset'));
          if (Number.isFinite(at)) offset = at;
          return 'retry';
        }
        if (sent.status >= 500 || sent.status === 423) return 'retry';
        return {sent, end: from + part.size};
      });
      const {sent, end} = res;
      if (sent.status === 404 || sent.status === 410 || sent.status === 401 || sent.status === 403) {
        forget(file);
        return fail(sent.status, 'E_UPLOAD_EXPIRED', 'This upload is no longer allowed. Pick the file again.');
      }
      if (sent.status < 200 || sent.status >= 300) {
        return fail(sent.status, 'E_UPLOAD_FAILED', 'The upload didn’t work. Try again.');
      }
      const at = Number(sent.header('Upload-Offset'));
      offset = sent.header('Upload-Offset') !== null && Number.isFinite(at) ? at : end;
      report(offset);
    }
    forget(file);
    return {ok: true, data: grant.video};
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      return fail(0, 'E_UPLOAD_CANCELED', 'Upload canceled.');
    }
    return fail(0, 'E_UPLOAD_FAILED', 'The upload stopped. Check your connection, then try again: it carries on where it stopped.');
  }
}

/* --------------------------------- playback -------------------------------- */

/** The part of hls.js this uses; `loadHls` resolves to its module (`() => import('hls.js/light')`). */
interface HlsInstance {
  loadSource(url: string): void;
  attachMedia(el: HTMLMediaElement): void;
  startLoad(at?: number): void;
  destroy(): void;
  on(event: string, handler: (event: string, data: {fatal?: boolean; type?: string; response?: {code?: number}}) => void): void;
}
interface HlsClass {
  new (config?: Record<string, unknown>): HlsInstance;
  isSupported(): boolean;
  Events: {ERROR: string};
  ErrorTypes: {NETWORK_ERROR: string; MEDIA_ERROR: string};
}
export type LoadHls = () => Promise<{default: unknown}>;

export interface AttachedVideo {
  /** Plays a fresh link for the same video from where it was (after the old one expired). */
  swap(link: PlaybackLink): void;
  destroy(): void;
}

export interface AttachOptions {
  loadHls: LoadHls;
  /** The link stopped working (expired or refused): get a fresh one and call `swap`. */
  onExpired?: () => void;
  /** Anything else that stops playback. */
  onError?: (code: VideoErrorCode) => void;
}

/** A link this close to its end is treated as expired. */
const EXPIRY_MARGIN_MS = 30_000;

export function linkExpired(link: Pick<PlaybackLink, 'expiresAt'>, now = Date.now()): boolean {
  return Date.parse(link.expiresAt) - EXPIRY_MARGIN_MS <= now;
}

/**
 * Plays `link` in `el`. HLS: Safari plays it natively; elsewhere hls.js (loaded by `loadHls` only
 * now, with no worker so the page's CSP needs nothing more). Resolves to a handle, or an error
 * when this browser can't play HLS at all.
 */
export async function attachVideo(
  el: HTMLVideoElement,
  link: PlaybackLink,
  options: AttachOptions
): Promise<VideoResult<AttachedVideo>> {
  const {onExpired, onError} = options;
  let current = link;
  const expiredOrFailed = (status?: number) => {
    if (status === 401 || status === 403 || status === 410 || linkExpired(current)) onExpired?.();
    else onError?.('E_PLAYER_FAILED');
  };

  const native = link.kind === 'file' || el.canPlayType('application/vnd.apple.mpegurl') !== '';
  if (native) {
    const onMediaError = () => expiredOrFailed();
    el.addEventListener('error', onMediaError);
    el.src = link.url;
    return {
      ok: true,
      data: {
        swap(next) {
          const at = el.currentTime;
          const playing = !el.paused;
          current = next;
          el.src = next.url;
          el.addEventListener(
            'loadedmetadata',
            () => {
              el.currentTime = at;
              if (playing) void el.play().catch(() => {});
            },
            {once: true}
          );
        },
        destroy() {
          el.removeEventListener('error', onMediaError);
          el.removeAttribute('src');
          el.load();
        },
      },
    };
  }

  let Hls: HlsClass;
  try {
    Hls = (await options.loadHls()).default as HlsClass;
  } catch {
    return {ok: false, status: 0, code: 'E_PLAYER_FAILED', message: 'The player didn’t load. Try again.'};
  }
  if (!Hls.isSupported()) {
    return {ok: false, status: 0, code: 'E_PLAYER_UNSUPPORTED', message: 'This browser can’t play this video.'};
  }
  const make = (url: string, startAt = -1) => {
    const hls = new Hls({enableWorker: false, capLevelToPlayerSize: true, startPosition: startAt});
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) expiredOrFailed(data.response?.code);
      else onError?.('E_PLAYER_FAILED');
    });
    hls.loadSource(url);
    hls.attachMedia(el);
    return hls;
  };
  let hls = make(link.url);
  return {
    ok: true,
    data: {
      swap(next) {
        const at = el.currentTime;
        const playing = !el.paused;
        current = next;
        hls.destroy();
        hls = make(next.url, at);
        if (playing) void el.play().catch(() => {});
      },
      destroy() {
        hls.destroy();
      },
    },
  };
}
