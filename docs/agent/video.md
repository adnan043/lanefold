---
title: Video: uploading, playing, who may watch
read-when: before anything that adds, lists or plays a video the owner or their staff upload (lessons, courses, a video library, product videos, members' videos)
---
The platform hosts this site's videos: it converts each one for every screen (adaptive streaming, smooth on a
slow phone) and plays it from short-lived links, so only this app's viewers can watch. Nothing to install, no
key or secret to ask for. Helpers: `src/platform/video.ts` (server) and `src/platform/video-browser.ts` (browser),
both managed, and the player itself, `src/platform/player/` (managed: Video.js, never edit it). Ready-made pieces
this site owns: `src/components/video/VideoPlayer.tsx` (plays a video on top of the player, "The player" below) and
`src/portal/video/VideoUpload.tsx` (the dashboard's upload box).

## Always platform video (or an embed)
Video people watch is the platform's built-in video, by default, every time. The only other source an app may offer
is an **embed** of a video already on YouTube, Vimeo, Wistia or another service that gives an embed link. Never:
- offer, suggest or scaffold the owner's own bucket, S3, R2, a video host's account (Bunny, Mux, Cloudflare Stream…)
  or Vimeo used as storage;
- play a direct link to a video file (`<video src="https://…/clip.mp4">`), or upload video anywhere but here.
No video plan on the account (`E_VIDEO_NEEDS_PLAN`, `E_VIDEO_NOT_INCLUDED`): tell the owner in one plain line to
add one on the dashboard's **Storage** page (Video on demand), and don't build a way around it.
Only if the OWNER asks in so many words to host video themselves: build it, and tell them plainly that the platform
doesn't support or watch over it, that its cost and risk are theirs, and that it doesn't count toward their plan.

## What video is for
The platform's video is for teaching and sharing what you know: courses, coaching, lessons, talks, workshops, Q&A,
and group or business video (updates, product videos, members' videos). A **series** is a learning or coaching
show released over time, never a TV drama. It is NOT for movies or films, TV dramas, music videos, or anything with
nudity or sexual or indecent content. Video that breaks this can be taken
down and the account closed.
- Never build movie, film, TV-drama or music-video features on the platform's video (a film catalogue,
  "watch movies", episodes of a drama, a music-video channel, a streaming service for shows).
- Asked for one: refuse in one plain line, e.g. "The platform's video is for teaching, coaching, talks and
  group or business video, so I can't build a movie or TV-drama library on it." Then offer what fits (a
  course, a coaching series, a talk library).
- Words in the app follow it too: "lessons", "sessions", "episodes of a coaching series", never "movies", "films" or
  "shows" for what plays.

## Platform video, or an embed?
| The video is… | Use |
| --- | --- |
| For some viewers only: paid lessons, members, a course, staff training, a client's private footage | **platform video** |
| The owner's own, and they don't want it on another service or its ads and suggestions next to it | **platform video** |
| Already public on YouTube, Vimeo or Wistia, for everyone (a promo, a talk) | an embed: `<VideoPlayer client:visible embedUrl="https://www.youtube.com/watch?v=<id>" title="…" />` (or a `vimeo.com/<id>` or Wistia link) and `allowVideoEmbeds(Astro.csp)` in the page's frontmatter. A plain `<iframe>` of `https://www.youtube-nocookie.com/embed/<id>`, `https://player.vimeo.com/video/<id>` or `https://fast.wistia.net/embed/iframe/<id>` works too (in blog HTML); another service's embed host goes in `frame-src` by exact origin, `security.md` |
| A short clip a visitor attaches to a form (a support request, a review) | a file (`files.md`), not video |

When the owner asks for "videos" and doesn't say, ask one plain question: "Should only your members see them, or
is it fine if they are public on YouTube?"

## Tell the owner: video uses their plan's hours
Video needs a video plan, which the owner adds in their dashboard: **Storage → Video on demand**. A plan gives two
amounts of **hours**:
- **hours kept**: the total length of all the videos they keep (a 30-minute video keeps 0.5 hours, whatever its
  size). At the limit, new uploads stop; videos already there keep playing.
- **hours watched a month**: the time people spend watching. One viewer watching a 30-minute video to the end is
  0.5 hours; 100 viewers watching it is 50 hours. It starts again each month. Well past the limit, new plays stop
  until they top up, move to a bigger plan, or the month restarts.

Say this in one or two plain lines when you add video, before they upload: "Videos use your video plan's hours:
how long your videos are (hours kept) and how long people watch them each month (hours watched). Your dashboard
shows both under Storage → Video on demand." Never name the provider behind it; it is "video" or "the platform".
`videoUsage()` gives the numbers for the OWNER's screens; never show them to viewers.

## How it works
```
UPLOAD (the owner or staff, in /dashboard)
browser ──1. POST /site-api/videos/uploads {name,size,contentType,declaredSeconds}──► your route: YOUR check, createUpload() ──► platform
browser ◄─────────────── the grant (where to send it, signed headers, expiry) ───────── your route
browser ──2. uploadVideo(grant, file) ── straight to the video service, in parts, resumable ──► stored
browser ──3. POST /site-api/videos/:id/complete ──► your route: confirm(), keep the id in YOUR table ──► processing → ready

PLAY (any viewer the app allows, every page view)
browser ──press play── POST /site-api/videos/:id/play ──► your route: may THIS viewer watch? then playback(id, {viewerId, ip, guest}) ──► platform
browser ◄──── {url, expiresAt, kind} for this viewer only ──── your route   (no-store)
browser ──VideoPlayer plays it (the player loads only now; it plays HLS on every browser)
```
- Steps that carry the Site Key (`{{SITE_KEY_ENV}}`) run in YOUR Site API route, server side. The key never goes
  to the browser.
- The bytes go from the browser straight to the video service. They never pass through `/site-api` (its 64 KB body
  limit stays) or through this site's server. There is no other way to upload.
- A video is `uploading`, then `processing` (being converted: a few minutes, longer for a long video), then `ready`.
  Only `ready` plays. `failed`: the file couldn't be converted (ask for another file). `over_limit`: it arrived but
  doesn't fit in the hours kept: it doesn't play and is deleted on `deletesAt` unless the owner makes room.
- Live and the Preview are the same app's videos; plays in the Preview count too.

## The page's Content-Security-Policy
Every page that uploads or plays video (a page, or the portal page that hosts a video screen,
`src/pages/dashboard/[...path].astro`) adds the video service to ITS policy, in its frontmatter:
```astro
---
import {allowVideo} from '../platform/video'; // the portal page: '../../platform/video'
await allowVideo(Astro.csp, Astro.url);
---
```
Without it the browser blocks the upload and the player (`E_UPLOAD_FAILED`, "The video stopped"). With an upload
page that also takes files, call `allowFileUploads` too. The rest of the site keeps `connect-src 'self'`.

**Local development** (a copy on your own computer linked to a platform running there, `SITE_URL=http://localhost:…`):
`allowVideo` accepts an `http://localhost` or `http://127.0.0.1` platform ONLY when the page itself is served from
localhost or 127.0.0.1, and adds it to `connect-src`, `media-src` and `img-src`. Everywhere else (the Preview, live)
it stays https-only. Never loosen the CSP yourself for this.

## Recipe: a video library the owner fills and members watch
A table owns the videos (what the app shows, and who may watch). `prisma/schema.prisma` (`database.md`: migration,
`npx prisma generate`):
```prisma
model Video {
  id          Int      @id @default(autoincrement())
  videoId     String   @unique @map("video_id") @db.VarChar(40)
  title       String   @db.VarChar(200)
  ready       Boolean  @default(false)
  membersOnly Boolean  @default(true) @map("members_only")
  posterFileId String? @map("poster_file_id") @db.VarChar(32)
  createdById Int      @map("created_by_id")
  createdAt   DateTime @default(now()) @map("created_at")

  @@index([ready, id])
  @@map("videos")
}
```
A permission for who may add videos: one `CATALOGUE` entry (`roles-and-permissions.md`), e.g. `VIDEO_MANAGE`,
codename `site:video:manage`, ability `manageVideos`, roles `['admin']`, and its line in `tests/permissions.test.ts`.

The route (`src/server/routes/videos.ts`, then `.route('/videos', videoRoutes)` in `app.ts`):
```ts
import {Hono} from 'hono';
import {validator} from 'hono/validator';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {confirm, createUpload, isVideoId, playback, viewerIp} from '../../platform/video';
import {PERMISSIONS} from '../permissions';

// THIS feature's limits, well inside the platform's (VIDEO_TYPES, MAX_VIDEO_SECONDS).
const VIDEO_RULES = {types: ['video/mp4', 'video/quicktime', 'video/webm'], maxBytes: 2 * 1024 ** 3, maxSeconds: 3 * 3600};

const uploadBody = validator('json', (value, c) => {
  const v = (value ?? {}) as {name?: unknown; size?: unknown; contentType?: unknown; declaredSeconds?: unknown};
  const name = typeof v.name === 'string' ? v.name.trim().slice(0, 200) : '';
  const contentType = typeof v.contentType === 'string' ? v.contentType : '';
  const size = typeof v.size === 'number' ? v.size : 0;
  const declaredSeconds = typeof v.declaredSeconds === 'number' && v.declaredSeconds > 0 ? v.declaredSeconds : undefined;
  if (!name || !VIDEO_RULES.types.includes(contentType) || size < 1 || size > VIDEO_RULES.maxBytes) {
    return c.json(problem('invalid_input', 'Pick an MP4, MOV or WebM video up to 2 GB.'), 422);
  }
  if (declaredSeconds && declaredSeconds > VIDEO_RULES.maxSeconds) {
    return c.json(problem('invalid_input', 'Pick a video up to 3 hours long.'), 422);
  }
  return {name, contentType, size, declaredSeconds};
});

/** A guest's id for one browser session, when your app lets guests watch (sent by your page, never trusted for access). */
const guestId = (header: string | undefined) => (header && /^[A-Za-z0-9-]{16,64}$/.test(header) ? `guest:${header}` : null);

/** The platform's status for people, or 503 when it failed (never pass its 5xx or 0 through). */
const answer = (status: number) => ([402, 403, 404, 409, 429].includes(status) ? status : 503) as 402 | 403 | 404 | 409 | 429 | 503;

export const videoRoutes = new Hono()
  // 1. the owner or staff ask for an upload
  .post('/uploads', uploadBody, withViewer, requireAuth, requirePermission(PERMISSIONS.VIDEO_MANAGE), withDb, async c => {
    const input = c.req.valid('json');
    const grant = await createUpload(c.req.url, input);
    if (!grant.ok) return c.json(problem(grant.code, grant.message), answer(grant.status));
    await c.var.db.video.create({
      data: {videoId: grant.data.video.id, title: input.name, createdById: c.var.viewer.id!},
    });
    c.header('Cache-Control', 'private, no-store');
    return c.json(grant.data, 201); // {video, upload}: VideoUpload sends the bytes with it
  })
  // 3. confirm after the browser's upload
  .post('/:videoId/complete', withViewer, requireAuth, requirePermission(PERMISSIONS.VIDEO_MANAGE), withDb, async c => {
    const videoId = c.req.param('videoId');
    if (!isVideoId(videoId)) return c.json(problem('not_found', 'No such video.'), 404);
    const mine = await c.var.db.video.findFirst({where: {videoId}, select: {id: true}});
    if (!mine) return c.json(problem('not_found', 'No such video.'), 404);
    const done = await confirm(c.req.url, videoId);
    if (!done.ok) return c.json(problem(done.code, done.message), answer(done.status));
    if (done.data.status === 'ready') await c.var.db.video.update({where: {id: mine.id}, data: {ready: true}});
    return c.json({video: done.data});
  })
  // play: YOUR rule first, then a fresh link for this viewer
  .post('/:videoId/play', withViewer, withDb, async c => {
    const videoId = c.req.param('videoId');
    c.header('Cache-Control', 'private, no-store');
    if (!isVideoId(videoId)) return c.json(problem('not_found', 'No such video.'), 404);
    const row = await c.var.db.video.findFirst({where: {videoId}, select: {membersOnly: true}});
    if (!row) return c.json(problem('not_found', 'No such video.'), 404);
    const viewer = c.var.viewer;
    // Who may watch is THIS app's decision: signed in, a member, bought the course, enrolled…
    if (row.membersOnly && viewer.state !== 'user') return c.json(problem('sign_in', 'Sign in to watch.'), 401);
    const guest = !viewer.id;
    const viewerId = guest ? guestId(c.req.header('x-viewer-session')) : `user:${viewer.id}`;
    if (!viewerId) return c.json(problem('sign_in', 'Sign in to watch.'), 401);
    // A guest is sent as one, with the visitor's IP (CF-Connecting-IP): the platform requires it.
    const link = await playback(c.req.url, videoId, {viewerId, ip: viewerIp(c.req.raw), guest});
    if (!link.ok) {
      return c.json({...problem(link.code, link.message), retryAfter: link.retryAfter}, answer(link.status));
    }
    return c.json(link.data); // {url, expiresAt, kind}
  });
```
A paid video: put the membership check in the play route (`payments.md`: `requireMembership([...])` before
`withDb`, or your own lookup of what they bought), and return 403 when they may not watch. A video that belongs to a
course or a lesson: look up THAT record (and the viewer's enrolment) in the same query that finds the video.

Mark the row `ready` when it is: the admin list asks `getVideos(ids)` (up to 50 in ONE call) for rows still not ready
(on that screen only), or `listVideos()` for the newest; never one `getVideo()` call per row, and never poll from a
public page.

The dashboard screen (`src/portal/screens/videos.tsx`, the portal recipe in `AGENTS.md`), gated by the ability:
```tsx
import {VideoUpload} from '../video/VideoUpload';
// in a Drawer "Add a video": defaults post to /site-api/videos/uploads and /site-api/videos/<id>/complete
<VideoUpload maxBytes={2 * 1024 ** 3} onDone={() => queryClient.invalidateQueries({queryKey: ['videos']})} />
```
A page that plays one (`src/pages/videos/[slug].astro`, `export const prerender = false`):
```astro
---
import VideoPlayer from '../../components/video/VideoPlayer';
import {allowVideo} from '../../platform/video';
await allowVideo(Astro.csp, Astro.url);
// …read the video row and its poster for this page; never a playback link here
---
<VideoPlayer client:visible videoId={row.videoId} title={row.title} poster={posterUrl} />
```
`VideoPlayer` asks `/site-api/videos/<id>/play` when the viewer presses play (`linkPath` to change it), so the page
itself stays the same for everyone and holds no link. A video your app lets guests watch: `<VideoPlayer guest … />`
sends a random id for the browser session as `x-viewer-session`, which the route above passes on (`guestId`) with
`guest: true` and the visitor's IP.

## Uploading
- Every upload is three steps: your route asks (`createUpload`), the browser sends (`uploadVideo`), your route
  confirms (`confirm`). Never skip `confirm`, and never treat a video as there before it answers.
- Check, in your route before `createUpload()`: who may add videos (a permission), the types and the max size and
  length for THIS feature. The browser checks the same for a quick message; the route is the check.
- Send `declaredSeconds` when the browser knows it (`VideoUpload` reads it from the file): the upload then holds
  only that much of the hours kept, instead of 30 minutes.
- At most 5 uploads at once per account (`E_VIDEO_TOO_MANY_UPLOADS`). An upload grant lasts an hour; one never
  confirmed is removed by the platform.
- `uploadVideo()` sends in parts, retries a dropped connection, resumes after a reload (the same file picked again:
  `resumableUpload(file)` hands back its grant), and cancels with an `AbortSignal`. Show progress and a Cancel
  button; keep the page open while it uploads (say so).

## A fresh link per viewer, every page view
- Ask for a playback link in YOUR route, for the viewer asking, when they press play (or when the page loads for a
  page that is only the video). Each viewer, each view, its own link.
- **Never** cache a link (`cache.md`, module memory, the database), share one between viewers, put one in static
  HTML or a prerendered page, in a public cache (`Cache-Control: public`), in a URL others see, or in a log. The
  route answers `Cache-Control: private, no-store`.
- **One link per viewer per page view.** Never ask in a loop, never ahead of time for a list of videos (a course
  page asks for the one being played, when it's played), never on a timer. The platform allows 30 links a minute and
  300 an hour per viewer, 60 a minute and 600 an hour per network address (the viewer's `ip`), and 2,000 a minute
  for the whole app; past that it answers 429 `E_VIDEO_RATE_LIMITED`.
- A link lasts 1.2 × the video's length plus 10 minutes, at least 30 minutes and at most 4 hours (`expiresAt`).
  `VideoPlayer` asks your route for a fresh one about 2 minutes before it ends while the video plays (a paused video:
  on its next play), and when a part of the video is refused (403), and carries on from the same moment, playing or
  paused as it was. Never renew a link any other way.
- Pass `viewerId`: `user:<users.id>` for a signed-in viewer (opaque: never an email or a name, 1 to 128 characters),
  or a session id for a guest your app lets watch. **Always pass `ip`** when you have it: `viewerIp(c.req.raw)` (the
  viewer's address as this server saw it). The platform may bind the link to that address, and then a link only
  plays from it. The platform uses them to count plays and viewers and to stop link sharing; it never shows them.
- **A guest's play route always sends `guest: true` and `ip`** (`viewerIp(c.req.raw)`, the `CF-Connecting-IP`
  header). A guest's session id is picked by the browser, so it proves nothing: the platform holds guests to a fair
  share by their network address, and refuses a guest link without one (422 `E_VIDEO_GUEST_IP_REQUIRED`). Never
  send a guest as a signed-in viewer, and never leave `ip` out of a guest's request.

## Who may watch: the app decides, first
The platform plays to whoever holds a link; it doesn't know this app's members, courses or orders. So the play
route checks the viewer against the app's OWN rules BEFORE it asks for a link, in the same query that finds the
video (`roles-and-permissions.md`): signed in, a member (`payments.md`), bought or enrolled, staff. Not allowed →
401 (sign in) or 403, and no link. Never trust a video id from the browser without finding it in YOUR table first.
Add an integration test that a viewer without access gets no link.

## The player
`VideoPlayer` is the only player: never a bare `<video>`, hls.js of your own or another player library. It shows a
poster and a play button, loads nothing until play, then plays with the player in `src/platform/player/` (controls,
speed, quality, captions, key moments, keyboard, picture in picture, full screen). Its props:
```tsx
<VideoPlayer
  client:visible
  videoId={row.videoId}                 // or embedUrl="https://vimeo.com/<id>" (YouTube, Vimeo, Wistia)
  title={row.title}                     // the play button's label for screen readers
  poster={posterUrl}                    // always give one
  captions={[{src: '/captions/intro-en.vtt', srclang: 'en', label: 'English', default: true}]}
  chapters={[{start: 0, title: 'Intro'}, {start: 95, title: 'Setting up'}]}
  watermark="{name} · {email}"           // paid or private lessons: text that moves slowly over the video
  viewer={{name: viewer.name, email: viewer.email, userId: String(viewer.id)}}
  startAt={progress?.seconds}           // resume where this viewer left off
  onProgress={p => save(p.position)}    // every 10 s while playing, and on pause, end and leaving
/>
```
- **Captions**: WebVTT files (`.vtt`) this site serves itself (`public/`, or a `public` file from `files.md`), one per
  language; the viewer turns them on with the CC button or `c`. Platform video only (embeds show their own).
- **Key moments** (`chapters`, seconds from the start): the seek bar splits at them and a "Key moments" list opens
  from the bar. Platform video only.
- **Watermark**: tokens `{name}`, `{email}`, `{userId}`, `{date}`, `{time}`, filled from `viewer` (the signed-in
  viewer, from YOUR session; never ask the browser for it, never for a guest). It discourages screen recording; it
  is not a lock: who may watch is still your route's check.
- **Resume**: save the position from `onProgress` in YOUR table (one row per viewer and video, at most every 10 s,
  `database.md`), and pass it back as `startAt`. `onEnded` marks a lesson done.
- **Up next and chapter lists beside the player**: `autoStart` starts it without a click once it mounts ("Play next",
  a chapter picked before playing; the browser may still ask for one), and `onMedia` hands you the playing media to seek
  or play from your own buttons.
- `config` changes the look and the controls (`src/platform/player/player-config.ts`: `skin`, `accentColor`,
  `seekBar`, `allowSeekAhead: false` so a lesson can't be skipped, `playbackRates`, `endScreen`…). The player takes
  the site's colours from `src/styles/global.css` through `video.css`; restyle it there, never in `src/platform/`.
- Embeds (`embedUrl`) cost no hours and need `allowVideoEmbeds(Astro.csp, ['youtube'])` (the kinds the page plays)
  in the frontmatter. YouTube and Vimeo play in the player (its controls, `onProgress`, `startAt`); a Wistia link
  plays in Wistia's own iframe in the same box, with Wistia's controls and none of the props above. Only YouTube,
  Vimeo and Wistia; any other link shows nothing.

## Each state, its screen
`VideoPlayer` shows these (`videoProblem(code)` has the words). Viewers never see the owner's plan or limits.

| `code` | Means | Viewers see | The owner's screens |
| --- | --- | --- | --- |
| `E_VIDEO_PROCESSING` (403), `E_VIDEO_NOT_READY` (409) | still being converted | "Getting this video ready" + Try again | "Getting it ready to play on every screen" |
| `E_VIDEO_OVER_LIMIT` (403) | doesn't fit in the hours kept | "This video can't play right now" | "Over your hours kept: delete videos or add hours by `deletesAt`" |
| `E_VIDEO_PAUSED`, `E_VIDEO_UNAVAILABLE` (403) | the month's hours watched are used up, or video isn't available to this app | "This video can't play right now" | `PAUSED`: "New plays are paused: top up or move to a bigger video plan in Storage → Video on demand". `UNAVAILABLE`: only "This video can't play right now. Check Storage → Video on demand", never a reason (it may be someone else's plan) |
| `E_VIDEO_RATE_LIMITED` (429, `retryAfter` seconds) | too many links asked for | "Too many plays at once", a countdown, then ONE try by itself | the same; then look for a loop asking for links |
| `E_VIDEO_NOT_FOUND` (404) | gone | "This video isn't here" | remove it from your table |
| `E_VIDEO_NEEDS_PLAN`, `E_VIDEO_NOT_INCLUDED`, `E_VIDEO_TRIAL` (402, at upload) | no video plan, a plan without apps, or a trial | — | "Add a video plan in Storage → Video on demand" (a trial: once the paid plan starts) |
| `E_VIDEO_KEPT_LIMIT` (402, at upload) | no hours kept left | — | "Your videos use all your hours kept: delete some or add hours" |
| `E_VIDEO_TOO_MANY_UPLOADS` (429), `E_VIDEO_BUSY` (409) | 5 uploads already running, or another step on this video | — | "Wait for an upload to finish, then try again" |
| `E_UPLOAD_EXPIRED`, `E_UPLOAD_FAILED`, `E_UPLOAD_CANCELED` (browser) | the grant ran out, the connection dropped, canceled | — | "Pick the file again" / "Try again: it carries on" |
| `E_PLATFORM_UNREACHABLE` | the platform didn't answer | "The video stopped" + Try again | "Try again" |

## Posters, thumbnails and captions
- **Poster**: always give the player one (`poster`), so the page shows an image and nothing loads until play: the
  owner's own image (`files.md`, a `public` file), or the video's `thumbnailUrl` when the platform gives one. That one
  is a signed link for that one image (it opens nothing else): never build a thumbnail address yourself, and never store
  it in the database. You may cache it for up to 1 hour (`cache.md`) with the page's data; past that, ask again.
- A video plays at 240p to 720p, picked by the player for the screen and the connection.
- **Captions**: the platform doesn't make captions. The owner can give a WebVTT file per language: pass them as
  `captions` ("The player"). A caption track that is part of a video's stream shows in the player's menu by itself.

## No delete from the app
Sites never delete videos. There is no delete in `src/platform/video.ts` or the platform's site API, and never
build one. Only the account owner deletes videos, in their dashboard (Storage → Video on demand). An app's
"remove" hides it: delete or flag YOUR row, and tell the owner the video still counts in their hours kept until they
delete it there. Never promise that removing it in the app frees hours.

## Performance
- One player per video, each loading nothing until play (`client:visible`, a poster). The player (about 75 KB
  compressed) and, for a platform video, its HLS engine (about 190 KB) download when someone presses play; an
  embed's own player likewise. Never import `src/platform/player/` at the top of a page or island.
- Never autoplay several videos, never autoplay with sound, and never start a video a viewer didn't ask for:
  every play uses the owner's hours watched. A list page shows posters and titles, then one player on the video's
  own page (or in a dialog).
- The play route is one indexed lookup and one platform call; nothing else.

## Security
- Never send `{{SITE_KEY_ENV}}` (or any platform call) from the browser. The browser only calls `/site-api/*`, the
  upload grant's endpoint, and the playback link.
- Never proxy video bytes through `/site-api` or the Worker, never store video in the database, `public/`,
  `src/assets/` or file storage, and never serve a video file yourself.
- Never build a playback link yourself or change one. Never log links, grants or their headers.
- The upload grant is for one video and expires: give it only to the person who asked, behind the permission.

## Older sites without the helper
A site on an older template has no `src/platform/video.ts`. The required version in `AGENTS.md` comes first:
upgrade, and it arrives. If this site can't upgrade now, call the platform from YOUR server code
(`src/server/video.ts`, never `src/platform/`) with `fetch`, the same way:
```ts
import {config} from '../platform/config';

/** POST/GET the platform's video API for this app. Server only. */
async function videoApi(path: string, init: {method?: 'GET' | 'POST'; body?: unknown} = {}) {
  if (!config.siteKey || !config.siteUrl) return {ok: false, status: 503, code: 'E_VIDEO_UNAVAILABLE'} as const;
  const method = init.method ?? 'GET';
  try {
    const res = await fetch(`${config.siteUrl.replace(/\/$/, '')}/api/site/v1/videos${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0 (compatible; Site/1.0)',
        authorization: `Bearer ${config.siteKey}`,
        ...(method === 'POST' ? {'content-type': 'application/json'} : {}),
      },
      ...(method === 'POST' ? {body: JSON.stringify(init.body ?? {})} : {}),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => null)) as {data?: any; errors?: {code?: string; payload?: {retryAfter?: number}}[]} | null;
    if (res.ok && json?.data) return {ok: true, data: json.data} as const;
    const e = json?.errors?.[0];
    const retryAfter = e?.payload?.retryAfter ?? (Number(res.headers.get('retry-after')) || undefined);
    return {ok: false, status: res.status, code: e?.code ?? `HTTP_${res.status}`, retryAfter} as const;
  } catch {
    return {ok: false, status: 0, code: 'E_PLATFORM_UNREACHABLE'} as const;
  }
}
// upload:   videoApi('/uploads', {method: 'POST', body: {title, size, contentType, lengthSeconds}})  → {video, upload}
// confirm:  videoApi(`/${id}/complete`, {method: 'POST'})                                        → {video}
// one:      videoApi(`/${id}`)                                                                   → {video}
// list:     videoApi('?limit=50')                                                                → {videos, next}
// several: videoApi(`?ids=${ids.join(',')}`)  (up to 50)                                     → {videos, next: null}
// usage:    videoApi('/usage')                                                                   → kept, watched
// origins:  videoApi('/origins')  (static: the hosts for the CSP; 1.5 s timeout, remember 10 min) → {uploadOrigin, playbackOrigin}
// play:     videoApi(`/${id}/playback`, {method: 'POST', body: {viewer: {id: viewerId, ip}}})   → {url, expiresAt, kind: 'hls'}
//           a guest (not signed in): {viewer: {id: sessionId, ip, guest: true}}; ip = request.headers.get('cf-connecting-ip'), required
//           429: wait errors[0].payload.retryAfter seconds (or the Retry-After header), then try once more
```
Check the id with `/^vid_[a-z2-7]{6,40}$/` before it goes in a path. In the browser, send the bytes with the
resumable-upload ("tus") protocol to `upload.endpoint` with `upload.headers` (a small tus client, or copy
`uploadVideo` from the template's `src/platform/video-browser.ts` into `src/lib/`), and play the link with hls.js
(`npm install hls.js`, the light build `import('hls.js/light')` only when someone presses play, `new Hls({enableWorker: false})`:
the worker is off because the site's CSP allows no blob worker; Safari plays
`url` natively in a `<video>`). The page's CSP: add the upload endpoint's and the link's hosts to `connect-src`
with `Astro.csp.insertDirective("connect-src 'self' https://…")` from the hosts `/origins` answered (one request at
a time per Worker, a failure remembered for a minute so a page never waits on it again). Every rule
above holds the same.

## Never
- Store or serve video files yourself, or send their bytes through this site's server.
- Request a playback link before checking that this viewer may watch, or reuse one for another viewer or view.
- Ask for a guest's link without `guest: true` and the visitor's IP.
- Ask for links in a loop, on a timer, or ahead of time for a list of videos.
- Delete a video from the app, or build a way to.
- Cache a link, put it in static HTML, a public cache, the database or a log.
- Show viewers the owner's plan, hours or limits; name the provider behind video.
- Autoplay many videos, or load the player before someone presses play.
- Play video with a bare `<video>`, your own hls.js or another player library instead of `VideoPlayer`.
- Promise that removing a video in the app deletes it or frees hours.
- Build movie, film, TV-drama or music-video features on the platform's video ("What video is for").
