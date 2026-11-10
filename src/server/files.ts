import {Hono} from 'hono';

import {config} from '../platform/config';
import {completeUpload as platformComplete, createUpload as platformCreate, deleteFile as platformDelete, fileUrl as platformUrl} from '../platform/files';
import type {FileResult, StoredFile, UploadGrant} from '../platform/files';

/**
 * File storage for the card routes: the platform's (`src/platform/files.ts`), except on a dev
 * machine with no Site Key, where files live in memory so uploads can be tried. `import.meta.env.DEV`
 * is false in every build, so the stand-in cannot exist on a deployed site. Files vanish on restart.
 */
const LOCAL_MAX_BYTES = 25 * 1024 * 1024;
const LOCAL_PATH = '/site-api/dev-files/';

type LocalFile = {file: StoredFile; bytes: Uint8Array | null};
const g = globalThis as unknown as {__devFiles?: Map<string, LocalFile>};
const store = (g.__devFiles ??= new Map<string, LocalFile>());

const useLocal = () => import.meta.env.DEV && !config.siteKey;
const fail = (status: number, code: string, message: string): FileResult<never> => ({ok: false, status, code, message});
const newId = () => `file_${Array.from(crypto.getRandomValues(new Uint8Array(13)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 26)}`;

export async function createUpload(requestUrl: string | URL, input: {name: string; contentType: string; size: number}): Promise<FileResult<UploadGrant>> {
  if (!useLocal()) return platformCreate(requestUrl, input);
  if (input.size > LOCAL_MAX_BYTES) return fail(413, 'E_FILE_TOO_LARGE', 'Local test storage holds files up to 25 MB.');
  const file: StoredFile = {id: newId(), name: input.name, contentType: input.contentType, size: input.size, visibility: 'private', status: 'pending', environment: 'staging', createdAt: new Date().toISOString(), completedAt: null};
  store.set(file.id, {file, bytes: null});
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  return {ok: true, data: {file, upload: {method: 'PUT', url: `${LOCAL_PATH}${file.id}`, headers: {'content-type': input.contentType}, expiresAt}}};
}

export async function completeUpload(requestUrl: string | URL, id: string): Promise<FileResult<StoredFile>> {
  if (!useLocal()) return platformComplete(requestUrl, id);
  const entry = store.get(id);
  if (!entry?.bytes) return fail(409, 'E_NOT_UPLOADED', 'The file was not uploaded.');
  entry.file = {...entry.file, status: 'ready', completedAt: new Date().toISOString()};
  return {ok: true, data: entry.file};
}

export async function fileUrl(requestUrl: string | URL, id: string, options: {expiresIn?: number; download?: boolean} = {}): Promise<FileResult<{url: string; expiresAt: string}>> {
  if (!useLocal()) return platformUrl(requestUrl, id, options);
  const entry = store.get(id);
  if (!entry?.bytes) return fail(404, 'E_NOT_FOUND', 'That file is gone (local test files are cleared on restart).');
  return {ok: true, data: {url: `${LOCAL_PATH}${id}${options.download ? '?download=1' : ''}`, expiresAt: new Date(Date.now() + 300_000).toISOString()}};
}

export async function deleteFile(requestUrl: string | URL, id: string): Promise<FileResult<{deleted: true}>> {
  if (!useLocal()) return platformDelete(requestUrl, id);
  store.delete(id);
  return {ok: true, data: {deleted: true}};
}

/** Dev only: takes the browser's PUT and serves the bytes back. The id is the unguessable one-time secret. */
export const devFileRoutes = new Hono()
  .put('/:id', async c => {
    const entry = useLocal() ? store.get(c.req.param('id')) : undefined;
    if (!entry || entry.bytes) return c.json({errors: [{code: 'not_found', message: 'Unknown upload.'}]}, 404);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length !== entry.file.size) return c.json({errors: [{code: 'invalid_input', message: 'The file size changed.'}]}, 400);
    entry.bytes = bytes;
    return c.json({data: {file: entry.file}});
  })
  .get('/:id', c => {
    const entry = useLocal() ? store.get(c.req.param('id')) : undefined;
    if (!entry?.bytes) return c.json({error: 'not_found', message: 'No such file.'}, 404);
    const name = encodeURIComponent(entry.file.name);
    c.header('Content-Type', entry.file.contentType);
    c.header('Content-Disposition', `${c.req.query('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, no-store');
    return c.body(entry.bytes as Uint8Array<ArrayBuffer>);
  });
