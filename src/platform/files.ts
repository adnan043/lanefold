import {PLATFORM_HEADERS, platformOrigin, SiteKeyMissing} from './api';
import {config} from './config';
import type {FileResult, FileVisibility, StoredFile, UploadGrant} from './files-browser';

/**
 * File storage: photos, documents and other files the site's visitors or staff upload
 * (`docs/agent/files.md`). Server code only: every call carries the Site Key, which never reaches
 * the browser. The owner turns Storage on in the dashboard (the app's Storage tab).
 *
 * An upload is three steps:
 *
 *   1. createUpload()   your route asks the platform for a one-time upload URL for ONE file
 *                       (name, type, exact size). It checks Storage is on, the type, the size and
 *                       the room left.
 *   2. the BROWSER PUTs the file's bytes to `upload.url` with `upload.headers`: `putFile()` from
 *      `./files-browser`. The URL goes straight to the storage, signed for exactly this size and
 *      type (anything else is refused), so the page that uploads calls `allowFileUploads()` in
 *      its frontmatter: it adds the storage to that page's CSP only.
 *   3. completeUpload() your route confirms it (the platform checks the stored size and type)
 *      before your table treats the file as there. Nothing can be read before this step.
 *
 * Files are private: fileUrl() makes a link that works for a while (default 1 hour), then stops.
 * A file uploaded with `visibility: 'public'` also has a stable link, publicFileUrl().
 *
 * Every function resolves to `{ok: true, data}` or `{ok: false, status, code, message}`; it never
 * throws into a page (except SiteKeyMissing: no Site Key on this machine). Show `message` to
 * people; branch on `code` (E_STORAGE_OFF, E_STORAGE_LIMIT, E_FILE_TYPE, E_FILE_TOO_LARGE, …).
 */

export type {FileResult, FileVisibility, StoredFile, UploadGrant} from './files-browser';

export interface StorageUsage {
  usedBytes: number;
  /** null = no limit. */
  limitBytes: number | null;
  /** `block` = uploads stop at the limit; `bill` = extra storage is billed to the owner. */
  onExceed: 'block' | 'bill';
  maxFileBytes: number;
  /** Where the browser sends uploads (scheme + host); null = this site's own address. */
  uploadOrigin?: string | null;
}

/**
 * The platform's largest single file. A ceiling, not a target: set your OWN, lower limit for each
 * kind of upload (an avatar is not a video), check it in your route before createUpload().
 */
export const MAX_FILE_BYTES = 5 * 1024 ** 3;

/** Types storage accepts (the platform checks too). Never HTML or JavaScript. */
export const ALLOWED_FILE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'application/zip',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

const TIMEOUT_MS = 8000;
const FILE_ID = /^file_[0-9a-z]{26}$/;

async function call<T>(
  requestUrl: string | URL,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<FileResult<T>> {
  const key = config.siteKey;
  if (!key) throw new SiteKeyMissing();
  let res: Response;
  try {
    res = await fetch(`${platformOrigin(requestUrl)}/api/site/v1/files${path}`, {
      method,
      headers: {
        ...PLATFORM_HEADERS,
        authorization: `Bearer ${key}`,
        ...(method === 'POST' ? {'content-type': 'application/json'} : {}),
      },
      ...(method === 'POST' ? {body: JSON.stringify(body ?? {})} : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return {ok: false, status: 0, code: 'E_PLATFORM_UNREACHABLE', message: 'Storage did not answer. Try again.'};
  }
  const answer = (await res.json().catch(() => null)) as
    | {data?: T; errors?: Array<{code?: string; message?: string}>}
    | null;
  if (res.ok && answer?.data !== undefined) return {ok: true, data: answer.data};
  const error = answer?.errors?.[0];
  return {
    ok: false,
    status: res.status,
    code: error?.code ?? `HTTP_${res.status}`,
    message: error?.message ?? 'Storage could not do that. Try again.',
  };
}

const idPath = (id: string) => {
  if (!FILE_ID.test(id)) throw new Error('Not a file id.');
  return `/${id}`;
};

/** Step 1: a one-time upload URL for one file (give the browser `upload`, keep `file.id`). */
export function createUpload(
  requestUrl: string | URL,
  input: {name: string; contentType: string; size: number; visibility?: FileVisibility}
) {
  // `direct`: straight to the storage (the page allows it with allowFileUploads()).
  return call<UploadGrant>(requestUrl, 'POST', '/uploads', {...input, direct: true});
}

interface CspApi {
  insertDirective: (directive: string) => void;
}

const ORIGIN_TTL_MS = 10 * 60 * 1000;
let uploadOriginCache: {origin: string | null; until: number} | null = null;

/**
 * Call in the frontmatter of EVERY page whose browser code uploads (`putFile`): adds the storage's
 * upload address to that page's `connect-src` (the rest of the site keeps `'self'`). Remembered
 * for 10 minutes per Worker, so it costs one platform call now and then, not one per view.
 * `await allowFileUploads(Astro.csp, Astro.url)`
 */
export async function allowFileUploads(csp: CspApi | undefined, requestUrl: string | URL): Promise<void> {
  if (!csp) return;
  if (!uploadOriginCache || uploadOriginCache.until < Date.now()) {
    const res = await storageUsage(requestUrl).catch(() => null);
    // Storage off or unreachable: leave the CSP alone (the upload route says why) and ask again soon.
    if (!res?.ok) return;
    uploadOriginCache = {origin: res.data.uploadOrigin ?? null, until: Date.now() + ORIGIN_TTL_MS};
  }
  const origin = uploadOriginCache.origin;
  if (origin && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
    csp.insertDirective(`connect-src 'self' ${origin}`);
  }
}

/** Step 3: after the browser's PUT. The file is `ready` (or the error says why not). */
export async function completeUpload(requestUrl: string | URL, id: string) {
  const res = await call<{file: StoredFile}>(requestUrl, 'POST', `${idPath(id)}/complete`);
  return res.ok ? ({ok: true, data: res.data.file} as const) : res;
}

/** A link to a ready file that stops working after `expiresIn` seconds (60 to 604800; default 3600). */
export function fileUrl(
  requestUrl: string | URL,
  id: string,
  options: {expiresIn?: number; download?: boolean} = {}
) {
  return call<{url: string; expiresAt: string}>(requestUrl, 'POST', `${idPath(id)}/url`, options);
}

/**
 * A PUBLIC file's stable link on this site's own address (it redirects to a fresh short-lived
 * link). Private files have none: use fileUrl().
 */
export function publicFileUrl(file: Pick<StoredFile, 'id' | 'name'>): string {
  return `/__platform/files/${file.id}/${encodeURIComponent(file.name)}`;
}

export async function deleteFile(requestUrl: string | URL, id: string) {
  return call<{deleted: true}>(requestUrl, 'POST', `${idPath(id)}/delete`);
}

export async function getFile(requestUrl: string | URL, id: string) {
  const res = await call<{file: StoredFile}>(requestUrl, 'GET', idPath(id));
  return res.ok ? ({ok: true, data: res.data.file} as const) : res;
}

/** Ready files, newest first. `before` = the `next` of the previous page. */
export function listFiles(requestUrl: string | URL, options: {before?: string; limit?: number} = {}) {
  const query = new URLSearchParams();
  if (options.before) query.set('before', options.before);
  if (options.limit) query.set('limit', String(options.limit));
  const qs = query.toString();
  return call<{files: StoredFile[]; next: string | null}>(requestUrl, 'GET', qs ? `?${qs}` : '');
}

/** Used and limit for the whole account (all its apps), for a "space left" hint. */
export function storageUsage(requestUrl: string | URL) {
  return call<StorageUsage>(requestUrl, 'GET', '/usage');
}

/** Paths the platform answers on this site's address: upload URLs and public file links. */
export const PLATFORM_FILES_PREFIX = '/__platform/files/';

/**
 * Deployed, the platform answers `/__platform/files/*` on this site's address before this Worker
 * sees it. In the editor Preview and on your own machine nothing does, so the middleware hands
 * those requests to the platform (`config.siteUrl`) here: the same upload URL works everywhere.
 * Only the body and its type go through, never cookies.
 */
export async function forwardPlatformFiles(request: Request, url: URL): Promise<Response> {
  if (!config.siteUrl) {
    return new Response(JSON.stringify({errors: [{code: 'E_NO_PLATFORM', message: 'No platform here.'}]}), {
      status: 503,
      headers: {'content-type': 'application/json'},
    });
  }
  const headers: Record<string, string> = {'user-agent': PLATFORM_HEADERS['user-agent']};
  for (const name of ['content-type', 'content-length', 'accept']) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  const hasBody = request.method === 'PUT' || request.method === 'POST';
  const res = await fetch(`${config.siteUrl.replace(/\/$/, '')}${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    redirect: 'manual',
    ...(hasBody ? {body: request.body, duplex: 'half'} : {}),
  } as RequestInit);
  const out = new Headers();
  for (const name of ['content-type', 'location', 'cache-control']) {
    const value = res.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(res.body, {status: res.status, headers: out});
}
