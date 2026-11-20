import {lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {siteFetch} from '../../platform/browser';
import type {VideoChapter} from '../../platform/player/interactions';
import {resolvePlayerConfig, type PlayerConfig} from '../../platform/player/player-config';
import type {PlayerMedia, VideoCaption, VideoProgress, WatermarkViewer} from '../../platform/player/video-player';
import {type PlaybackLink, type VideoErrorCode, videoProblem} from '../../platform/video-browser';
import './video.css';

/**
 * BROWSER: plays one video (`docs/agent/video.md`): the platform's own (`videoId`) or an embed of a
 * YouTube, Vimeo or Wistia video (`embedUrl`). Nothing loads until the viewer presses play. Then,
 * for a platform video, it asks YOUR route (`linkPath`, POST) for a link for this viewer (your route
 * checks they may watch first), and the player (`src/platform/player/`, Video.js) loads and plays it.
 *
 * Shows a plain screen for every state: getting ready, can't play right now, too many plays, not
 * here, stopped. A link runs out (`expiresAt`): the player asks your route for a fresh one about
 * 2 minutes before, and when the stream refuses a part, and carries on from the same moment.
 *
 * On a page: `<VideoPlayer client:visible videoId={id} title={title} poster={poster} />`, and
 * `await allowVideo(Astro.csp, Astro.url)` in that page's frontmatter (an embed:
 * `allowVideoEmbeds(Astro.csp)`). In the portal: import it.
 */
export interface VideoPlayerProps {
  /** A platform video (`vid_…`). Give this or `embedUrl`. */
  videoId?: string;
  /** A YouTube, Vimeo or Wistia link (a watch, share or embed URL). Never a direct video file. */
  embedUrl?: string;
  /** For screen readers and the play button: "Play Welcome to the course". */
  title: string;
  /** An image shown before playing (your own, or the video's `thumbnailUrl`). */
  poster?: string | null;
  /** Your route that answers a playback link (default `/site-api/videos/<id>/play`). */
  linkPath?: string;
  /**
   * Your app lets guests watch this video: sends a random id for this browser session as
   * `x-viewer-session`, which your route passes on with `guest: true` and the viewer's IP.
   * Never a way in: the route still decides who may watch.
   */
  guest?: boolean;
  /** WebVTT files (this site's own public files): the viewer turns them on with the CC button. Platform video only. */
  captions?: VideoCaption[];
  /** Key moments: `[{start: 0, title: 'Intro'}, {start: 95, title: 'Setting up'}]` (seconds). Platform video only. */
  chapters?: VideoChapter[];
  /** Text over the video, moving slowly so it can't be cropped out: `'{name} · {email}'`. Filled from `viewer`. */
  watermark?: string;
  /** The signed-in viewer, for the watermark's `{name}`, `{email}` and `{userId}`. Never for a guest. */
  viewer?: WatermarkViewer;
  /** Seconds to start from (where this viewer left off; save it from `onProgress`). */
  startAt?: number;
  /** Every 10 s while playing, and on pause, end and leaving: the position and the ranges watched. */
  onProgress?: (progress: VideoProgress) => void;
  onEnded?: () => void;
  /** The player's look and controls over the defaults (`src/platform/player/player-config.ts`). */
  config?: Partial<PlayerConfig>;
  /**
   * Start as if play was pressed, once, when it mounts (the watch page's
   * "Play next" and a chapter picked before playing). The browser may still wait for a click.
   */
  autoStart?: boolean;
  /** The playing media (seek, play) for controls beside the player; null when it goes. */
  onMedia?: (media: PlayerMedia | null) => void;
}

// The player and its look load on the first play, never with the page.
const Player = lazy(async () => {
  const [player, classes] = await Promise.all([
    import('../../platform/player/video-player'),
    import('../../platform/player/player-classes'),
    import('../../platform/player/player.css'),
  ]);
  const classNames = classes.playerClasses;
  return {
    default: (props: Parameters<typeof player.VideoPlayer>[0]) => (
      <player.VideoPlayer {...props} classNames={classNames} className="video-player-live" />
    ),
  };
});

const SESSION_KEY = 'video-viewer-session';

/** A random id for this browser tab's session (not a sign-in, not stored on the server). */
function viewerSession(): string {
  try {
    const known = sessionStorage.getItem(SESSION_KEY);
    if (known) return known;
    const made = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, made);
    return made;
  } catch {
    return crypto.randomUUID();
  }
}

type Phase =
  | {name: 'idle'}
  | {name: 'loading'}
  | {name: 'playing'; link: PlaybackLink | null}
  | {name: 'problem'; code: VideoErrorCode; retryAt?: number};

type Asked = {ok: true; link: PlaybackLink} | {ok: false; code: VideoErrorCode; retryAfter?: number};

async function askForLink(path: string, guest: boolean): Promise<Asked> {
  let res: Response;
  try {
    const headers: Record<string, string> = {'content-type': 'application/json'};
    if (guest) headers['x-viewer-session'] = viewerSession();
    res = await siteFetch(path, {method: 'POST', headers, body: '{}'});
  } catch {
    return {ok: false, code: 'E_PLATFORM_UNREACHABLE'};
  }
  const body = (await res.json().catch(() => null)) as
    | (Partial<PlaybackLink> & {error?: string; retryAfter?: number})
    | null;
  if (res.ok && body?.url && body.expiresAt) {
    return {ok: true, link: {url: body.url, expiresAt: body.expiresAt, kind: body.kind === 'file' ? 'file' : 'hls'}};
  }
  if (res.status === 404) return {ok: false, code: 'E_VIDEO_NOT_FOUND'};
  return {ok: false, code: body?.error ?? 'E_VIDEO_UNAVAILABLE', retryAfter: body?.retryAfter};
}

/** The embed hosts this player takes: YouTube, Vimeo and Wistia. */
const EMBED_HOSTS = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|wistia\.com|wistia\.net|wi\.st)$/i;

/** `url` when it is an https link to one of the embed hosts, else null. */
export function embedSource(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && EMBED_HOSTS.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

export default function VideoPlayer(props: VideoPlayerProps) {
  const {videoId, title, poster, guest = false} = props;
  const embed = embedSource(props.embedUrl);
  const path = props.linkPath ?? `/site-api/videos/${encodeURIComponent(videoId ?? '')}/play`;
  const [phase, setPhase] = useState<Phase>({name: 'idle'});
  const [now, setNow] = useState(() => Date.now());
  const retriedOnce = useRef(false);

  const showProblem = useCallback((code: VideoErrorCode, retryAfter?: number) => {
    setPhase({name: 'problem', code, retryAt: retryAfter ? Date.now() + retryAfter * 1000 : undefined});
  }, []);

  const play = useCallback(async () => {
    if (embed) return setPhase({name: 'playing', link: null});
    if (!videoId) return showProblem('E_VIDEO_NOT_FOUND');
    setPhase({name: 'loading'});
    const got = await askForLink(path, guest);
    if (!got.ok) return showProblem(got.code, got.retryAfter);
    retriedOnce.current = false;
    setPhase({name: 'playing', link: got.link});
  }, [embed, videoId, path, guest, showProblem]);

  /** The player asks for a fresh link before this one ends, or when the stream refuses it. */
  const renewLink = useCallback(async () => {
    const got = await askForLink(path, guest);
    if (!got.ok) {
      showProblem(got.code, got.retryAfter);
      return null;
    }
    return {src: got.link.url, expiresAt: got.link.expiresAt};
  }, [path, guest, showProblem]);
  // Started without a click (autoStart), once.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!props.autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void play();
  }, [props.autoStart, play]);

  // "Too many plays": a countdown, then ONE automatic try; after that the button.
  const retryAt = phase.name === 'problem' ? phase.retryAt : undefined;
  const rateLimited = phase.name === 'problem' && phase.code === 'E_VIDEO_RATE_LIMITED';
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() < retryAt) return;
      clearInterval(timer);
      if (rateLimited && !retriedOnce.current) {
        retriedOnce.current = true;
        void play();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [retryAt, rateLimited, play]);

  // Pressing play started it: the player plays at once, with the site's look over the defaults.
  const config = useMemo(() => {
    const values: Partial<PlayerConfig> = {autoplay: true, ...props.config};
    if (props.watermark) {
      values.watermark = {
        enabled: true,
        text: props.watermark,
        position: 'center',
        opacity: 0.3,
        fontSize: 14,
        color: null,
        tiled: false,
        animation: 'drift',
        intervalSeconds: 10,
        ...props.config?.watermark,
      };
    }
    return resolvePlayerConfig({school: {values}}).config;
  }, [props.config, props.watermark]);

  if (phase.name === 'playing') {
    const src = phase.link ? phase.link.url : embed;
    if (!src) return null;
    return (
      <div className="video-player video-player-on" aria-label={title} role="region">
        <Suspense fallback={<span className="video-spinner video-spinner-centre" aria-hidden="true" />}>
          <Player
            src={src}
            title={title}
            type={phase.link?.kind === 'hls' ? 'application/x-mpegurl' : undefined}
            expiresAt={phase.link?.expiresAt}
            renewLink={phase.link ? renewLink : undefined}
            onLinkLost={() => showProblem('E_PLAYER_FAILED')}
            onError={() => showProblem('E_PLAYER_FAILED')}
            poster={poster ?? undefined}
            config={config}
            captions={phase.link ? props.captions : undefined}
            chapters={phase.link ? props.chapters : undefined}
            watermarkViewer={props.viewer}
            startAt={props.startAt}
            onProgress={props.onProgress}
            onEnded={props.onEnded}
            onMedia={props.onMedia}
          />
        </Suspense>
      </div>
    );
  }

  if (phase.name === 'problem') {
    const words = videoProblem(phase.code);
    const wait = phase.retryAt ? Math.max(0, Math.ceil((phase.retryAt - now) / 1000)) : 0;
    const canRetry = words.screen === 'rate_limited' || words.screen === 'failed' || words.screen === 'processing';
    return (
      <div className="video-player video-screen" role="status" data-screen={words.screen}>
        <p className="video-screen-title">{words.title}</p>
        <p className="video-screen-text">{words.message}</p>
        {canRetry && (
          <button type="button" className="video-retry" disabled={wait > 0} onClick={() => void play()}>
            {wait > 0 ? `Try again in ${wait} s` : 'Try again'}
          </button>
        )}
      </div>
    );
  }

  const loading = phase.name === 'loading';
  return (
    <div className="video-player">
      {poster && <img className="video-poster" src={poster} alt="" loading="lazy" decoding="async" />}
      <button
        type="button"
        className="video-play"
        onClick={() => void play()}
        disabled={loading}
        aria-busy={loading || undefined}
        aria-label={loading ? `Loading ${title}…` : `Play ${title}`}>
        {loading ? (
          <span className="video-spinner" aria-hidden="true" />
        ) : (
          <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
            <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
          </svg>
        )}
      </button>
    </div>
  );
}
