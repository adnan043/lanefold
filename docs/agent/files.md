---
title: File storage: uploads, private files and links
read-when: before anything that stores a file a person picks (photos, documents, attachments, avatars, audio, video) or shows one back
---
The platform stores this site's files: photos, PDFs, documents, audio and video that visitors or
staff upload. Nothing to install, no bucket, key or secret to ask for. Storage is an add-on the
owner adds in the dashboard (the app's Storage tab: a storage pack, then "Turn on"); without a pack
calls answer `E_STORAGE_NEEDS_PACK`, while it is off `E_STORAGE_OFF`. Files count against the
storage the owner has (their packs); at that limit uploads stop with `E_STORAGE_LIMIT`.

Not for: the site's own images (commit them in `src/assets/`), blog covers (Markdown), or data
(use the Site Database: store the FILE ID there, never the bytes).

## How an upload works (three steps, one file each)
```
browser ──1. POST /site-api/uploads {name,type,size}──► your route: YOUR limits, then createUpload()──► platform
browser ◄──────────── {fileId, upload} ──────────────── your route   (platform checks: type, 5 GB, room)
browser ──2. putFile(upload, file) ── PUT upload.url (straight to the storage) ──► stored, not readable yet
browser ──3. POST /site-api/uploads/:id/complete ─────► your route ──completeUpload()──► ready
```
- Step 1 and 3 run in YOUR Site API route, server side: they carry the Site Key
  (`{{SITE_KEY_ENV}}`), which never goes to the browser.
- Step 2 is the browser: `upload.url` goes straight to the storage, signed for exactly this file's
  size and type, and must be started within 15 minutes. The storage refuses anything else. The
  bytes never pass through `/site-api` (its 64 KB body limit stays) or through the platform.
- The page that uploads adds the storage to ITS Content-Security-Policy, in its frontmatter:
  `await allowFileUploads(Astro.csp, Astro.url);` (from `src/platform/files.ts`). Without it the
  browser blocks the PUT (`putFile` answers `E_UPLOAD_FAILED`). A portal screen: call it in the
  portal page's frontmatter. Same page as a checkout too: call both helpers.
- Step 3 is required: the platform checks the stored size and type, and only then is the file
  `ready`. Until then nobody can read it (no link is made for it) and it still counts against the
  room; a file never completed is deleted after an hour or so (longer for a very large file).

## Your own limits (always set them)
The platform's limits (5 GB a file, the allowed types, the room) are a ceiling for everything, not
a fit for any one feature. For EACH kind of upload, decide and enforce in your route, before
`createUpload()`:
- **Types**: only what this feature needs (an avatar: `image/png`, `image/jpeg`, `image/webp`).
- **Max size**: what this feature needs (avatar 5 MB, documents 25 MB, video 1 GB…). Say it in the
  picker's help text, check it in the browser for a quick message, and check it again in the
  route: the browser check is only for comfort.
- **Who and how many**: signed in, the right role, a count per person or per record if it matters.
Keep these numbers in one place in your code (a small `UPLOAD_RULES` object), so the route, the
browser check and the help text agree.

| Helper | Where | Use |
| --- | --- | --- |
| `createUpload`, `completeUpload`, `fileUrl`, `deleteFile`, `getFile`, `listFiles`, `storageUsage`, `publicFileUrl` | `src/platform/files.ts` | server code (routes, pages) |
| `putFile` | `src/platform/files-browser.ts` | the browser (portal, page script) |
Both are MANAGED: never edit them. Every server helper resolves to `{ok: true, data}` or
`{ok: false, status, code, message}`: show `message` to people, branch on `code`.

## Private or public (decide per kind of file)
| The file is… | `visibility` | Show it with |
| --- | --- | --- |
| Personal or business documents: IDs, CVs, invoices, medical forms, anything for some people only | `private` (default) | a short-lived link from YOUR route, after your permission check |
| Meant for everyone: product photos, a menu PDF, a team photo, a public podcast episode | `public` | `publicFileUrl(file)`: a stable link on this site, no call needed |
When unsure, private. A public file's link works for anyone who has it.

## Recipe: attachments a signed-in person uploads
A table owns the files (who uploaded what, for which record). `prisma/schema.prisma`
(`database.md`: migration, `npx prisma generate`):
```prisma
model Attachment {
  id          Int      @id @default(autoincrement())
  fileId      String   @unique @map("file_id") @db.VarChar(32)
  ownerId     Int      @map("owner_id")
  name        String   @db.VarChar(200)
  contentType String   @map("content_type") @db.VarChar(127)
  size        Int
  ready       Boolean  @default(false)
  createdAt   DateTime @default(now()) @map("created_at")

  @@index([ownerId, id])
  @@map("attachments")
}
```
The route (`src/server/routes/uploads.ts`, then `.route('/uploads', uploadRoutes)` in `app.ts`):
```ts
import {Hono} from 'hono';
import {validator} from 'hono/validator';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {completeUpload, createUpload, deleteFile, fileUrl} from '../../platform/files';

const ATTACHMENT_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

const uploadBody = validator('json', (value, c) => {
  const v = (value ?? {}) as {name?: unknown; contentType?: unknown; size?: unknown};
  const name = typeof v.name === 'string' ? v.name.trim().slice(0, 200) : '';
  const contentType = typeof v.contentType === 'string' ? v.contentType : '';
  const size = typeof v.size === 'number' ? v.size : 0;
  // THIS feature's limits (see "Your own limits"), well inside the platform's ALLOWED_FILE_TYPES / MAX_FILE_BYTES.
  if (!name || !ATTACHMENT_TYPES.includes(contentType) || size < 1 || size > ATTACHMENT_MAX_BYTES) {
    return c.json(problem('invalid_input', 'Pick an image or PDF up to 25 MB.'), 422);
  }
  return {name, contentType, size};
});

export const uploadRoutes = new Hono()
  // 1. ask for an upload URL
  .post('/', uploadBody, withViewer, requireAuth, withDb, async c => {
    const input = c.req.valid('json');
    const grant = await createUpload(c.req.url, input); // private by default
    if (!grant.ok) return c.json(problem(grant.code, grant.message), grant.status === 402 ? 402 : 400);
    await c.var.db.attachment.create({
      data: {fileId: grant.data.file.id, ownerId: c.var.viewer.id!, ...input},
    });
    return c.json({fileId: grant.data.file.id, upload: grant.data.upload}, 201);
  })
  // 3. confirm after the browser's PUT
  .post('/:fileId/complete', withViewer, requireAuth, withDb, async c => {
    const fileId = c.req.param('fileId');
    const mine = await c.var.db.attachment.findFirst({where: {fileId, ownerId: c.var.viewer.id!}, select: {id: true}});
    if (!mine) return c.json(problem('not_found', 'No such file.'), 404);
    const done = await completeUpload(c.req.url, fileId);
    if (!done.ok) return c.json(problem(done.code, done.message), 400);
    await c.var.db.attachment.update({where: {id: mine.id}, data: {ready: true}});
    return c.json({ok: true});
  })
  // show / download: check access, then redirect to a 5-minute link
  .get('/:fileId/view', withViewer, requireAuth, withDb, async c => {
    const fileId = c.req.param('fileId');
    const mine = await c.var.db.attachment.findFirst({where: {fileId, ownerId: c.var.viewer.id!, ready: true}, select: {id: true}});
    if (!mine) return c.json(problem('not_found', 'No such file.'), 404);
    const link = await fileUrl(c.req.url, fileId, {expiresIn: 300, download: c.req.query('download') === '1'});
    if (!link.ok) return c.json(problem(link.code, link.message), 400);
    c.header('Cache-Control', 'private, no-store');
    return c.redirect(link.data.url, 302);
  })
  .delete('/:fileId', withViewer, requireAuth, withDb, async c => {
    const fileId = c.req.param('fileId');
    const {count} = await c.var.db.attachment.deleteMany({where: {fileId, ownerId: c.var.viewer.id!}});
    if (!count) return c.json(problem('not_found', 'No such file.'), 404);
    await deleteFile(c.req.url, fileId);
    return c.json({ok: true});
  });
```
Staff who see other people's files: gate with `requirePermission(PERMISSIONS.X)` instead of the
`ownerId` filter (`roles-and-permissions.md`). Never trust a file id from the browser without
looking it up in YOUR table first.

The page that uploads (frontmatter):
```astro
---
import {allowFileUploads} from '../platform/files';
await allowFileUploads(Astro.csp, Astro.url); // lets this page's browser code reach the storage
---
```
The browser (portal screen or page script):
```ts
import {putFile} from '../../platform/files-browser'; // portal: from '../platform/files-browser'

async function upload(file: File) {
  const res = await siteFetch('/site-api/uploads', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({name: file.name, contentType: file.type, size: file.size}),
  });
  const body = await res.json();
  if (!res.ok) return showError(body.message);           // E_STORAGE_LIMIT, wrong type…
  const put = await putFile(body.upload, file);          // the bytes, straight to storage
  if (!put.ok) return showError(put.message);            // E_UPLOAD_REFUSED: wrong size/type or too late
  const done = await siteFetch(`/site-api/uploads/${body.fileId}/complete`, {method: 'POST'});
  if (!done.ok) return showError((await done.json()).message); // the platform didn't accept the stored file
}
```
- Check type and size in the browser first (same rules as the server) and say what is allowed
  before the upload starts. Show progress state on the button (`Uploading…`, disabled).
- `<input type="file" accept="image/*,application/pdf">` narrows the picker; it is not a check.
- Show a private file with `<img src="/site-api/uploads/<fileId>/view">` or a link with
  `?download=1`: every view checks access and gets a fresh short link.

## Public files (no route needed to show them)
`createUpload(c.req.url, {..., visibility: 'public'})`, then link `publicFileUrl(file)`
(`/__platform/files/<id>/<name>` on this site; it redirects to storage). Use it for images on
public pages. Still keep the file id in your table, and still delete through your route.

## Limits and errors
- One file: 1 byte to 5 GB (the platform's ceiling: set your own per feature). Types: images (PNG, JPEG, WebP, GIF, AVIF, SVG), PDF, plain text,
  CSV, JSON, ZIP, audio (MP3, WAV, OGG, M4A), video (MP4, WebM, MOV), Word, Excel, PowerPoint.
  Never HTML or JavaScript. SVG and documents always download; images, PDF, audio, video show.
- An upload URL must be started within 15 minutes; it only takes exactly the size and type asked
  for. A file not completed is removed after about an hour (a very large one gets longer to arrive).
- Links from `fileUrl()` last `expiresIn` seconds (60 to 604800, default 3600). Make them per
  view; never save a link in the database.
- `storageUsage(c.req.url)` gives used and limit for the whole account (all its apps): show "space
  left" before a big upload.
- Live and the Preview keep separate files (the Preview's are staging). The editor key works.

| `code` | Means | Do |
| --- | --- | --- |
| `E_STORAGE_NEEDS_PACK` (402) | the owner has no storage pack | tell the owner: add storage in the app's Storage tab |
| `E_STORAGE_OFF` | the owner hasn't turned Storage on for this app | tell the owner: the app's Storage tab |
| `E_STORAGE_UNAVAILABLE` | this account has no storage | tell the owner |
| `E_STORAGE_LIMIT` (402) | the file doesn't fit in the storage left | say so; the owner deletes files or adds a bigger pack |
| `E_FILE_TYPE`, `E_FILE_EMPTY`, `E_FILE_TOO_LARGE` | not allowed, 0 bytes, over 5 GB | say what is allowed |
| `E_UPLOAD_REFUSED` (403, at the PUT, `putFile`) | the storage refused: another size or type than asked for, or started too late | ask for a new upload with the file's real size and type |
| `E_UPLOAD_FAILED` (at the PUT) | the upload stopped, or this page's CSP blocks the storage | check `allowFileUploads()` is on the page; try again |
| `E_FILE_SIZE_MISMATCH`, `E_FILE_TYPE_MISMATCH` (at complete) | what was stored isn't what was asked for; nothing kept | ask for a new upload |
| `E_BODY_TOO_LARGE` (413, at the PUT) | an older upload URL on this site's address got more bytes than `size` | send the real size |
| `E_UPLOAD_TOKEN`, `E_UPLOAD_EXPIRED` | the upload URL was used or is too old | ask for a new upload |
| `E_FILE_NOT_UPLOADED` | complete before the PUT finished | PUT first |
| `E_FILE_NOT_FOUND`, `E_FILE_NOT_READY` | wrong id, or not completed | check your table |

## Never
- Send `{{SITE_KEY_ENV}}` (or any platform call) from the browser; the browser only calls
  `/site-api/*` and `upload.url`.
- Store file bytes in the database, in `public/`, or as base64 in JSON.
- Build a storage link yourself, or save a `fileUrl()` link: links expire.
- Accept a file id from the browser without checking it is in YOUR table and theirs to see.
- Make personal documents `public`.
- Proxy file bytes through `/site-api` (body limit 64 KB, Worker memory 128 MB).
- Skip `completeUpload()`, or treat a file as there before it answers `ok`.
- Rely on the platform's 5 GB ceiling as your feature's limit.
