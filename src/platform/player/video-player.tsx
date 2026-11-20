import {lazy, Suspense, useSyncExternalStore} from 'react';

import type {
  Interaction,
  InteractionEvent,
  InteractionState,
  InteractionViewer,
  VideoChapter,
  VideoMark,
} from './interactions';
import type {VideoPlayerLabels} from './labels';
import type {PlaybackLink} from './link-renewal';
import type {MediaProgress, PlayerEvent, PlayerMedia} from './media-watch';
import type {PlayerConfig} from './player-config';
import type {WatermarkViewer} from './player-overlays';
import {cx, type VideoPlayerClassNames} from './player-ui';
import {wistiaEmbedUrl} from './wistia';
import type {SeekPreview} from './seek-preview';
import type {WatchedRange} from './watched-ranges';

export type VideoCaption = {
  src: string; // a WebVTT file; another origin must send CORS headers
  srclang: string;
  label: string;
  default?: boolean;
};

// VideoDrm names a license server per EME key system; the browser picks the
// system it supports, so name every one you hold. HLS sources only.
export type VideoDrm = Partial<
  Record<
    'com.apple.fps' | 'com.widevine.alpha' | 'com.microsoft.playready',
    {licenseUrl: string; serverCertificateUrl?: string}
  >
>;

export type {MediaProgress, PlayerEvent, PlayerMedia} from './media-watch';
export type {SeekPreview} from './seek-preview';
export type {PlaybackLink} from './link-renewal';
export type {WatermarkViewer} from './player-overlays';

export type VideoProgress = MediaProgress & {ranges: WatchedRange[]};

// The learner's own choices made in the player, to save as their preferences.
export type VideoPreferences = Partial<
  Pick<PlayerConfig, 'playbackRate' | 'volume' | 'muted' | 'captionsOn' | 'captionLanguage'>
>;

export type VideoPlayerProps = {
  // A file (MP4, WebM), an HLS manifest (.m3u8), or a YouTube, Vimeo or Wistia URL.
  // Wistia plays in Wistia's own iframe (wistia.ts): none of the player's
  // controls, config, tracking or renewal apply to it.
  src: string;
  // The video's name, for an embed's frame (screen readers).
  title?: string;
  // When a signed `src` stops working (ISO date or epoch ms). With renewLink,
  // the player asks for a fresh link about 2 minutes before, while it plays
  // (or on the next play), and when the stream refuses a part (401, 403,
  // 410), then plays it from the same moment (link-renewal.ts).
  expiresAt?: string | number | null;
  // Asks the page for a fresh link to the same video: {src, expiresAt}, or
  // null when there is none (onLinkLost then).
  renewLink?: () => Promise<PlaybackLink | null>;
  // Renewing failed, or was needed too often: the page shows its own problem.
  onLinkLost?: () => void;
  // MIME type, when the URL doesn't show it (an extensionless manifest).
  type?: string;
  poster?: string;
  captions?: VideoCaption[]; // files and HLS; YouTube, Vimeo and Wistia show their own
  drm?: VideoDrm;
  // What shows and what's allowed, resolved from the school, course, lesson
  // and learner layers (resolvePlayerConfig). Default: defaultPlayerConfig.
  config?: PlayerConfig;
  startAt?: number; // seconds, to resume (when config.resumePosition)
  furthestWatched?: number; // seconds already played in earlier sessions
  progressInterval?: number; // ms between reports while playing (default 10 s)
  onProgress?: (progress: VideoProgress) => void;
  onEnded?: () => void;
  // The media's length in whole seconds once known (and when it changes):
  // a host may save it for embedded videos.
  onDuration?: (seconds: number) => void;
  // The playing media (time, play, pause, events), for tools beside the
  // player such as notes and transcripts; null when the player goes.
  onMedia?: (media: PlayerMedia | null) => void;
  // What the learner did (play, pause, seek, rate, ended), for analytics.
  onPlayerEvent?: (event: PlayerEvent) => void;
  // A file's video can't be loaded or played (not HLS, YouTube, Vimeo or Wistia).
  onError?: () => void;
  onPreferencesChange?: (preferences: VideoPreferences) => void;
  // From the video editor. Chapters divide the seek bar (files and HLS).
  chapters?: VideoChapter[];
  // Dots on the seek bar at key points (a lesson's moments), files and HLS.
  marks?: VideoMark[];
  // Frames above the seek bar's pointed time, from the host's sprite sheets
  // (files and HLS). Without it the preview shows the time (and chapter).
  seekPreview?: SeekPreview;
  // An Ask AI button in the control bar, before captions: the page opens its
  // assistant. Without it there is none.
  onAskAi?: () => void;
  // The video's width ÷ height when the page knows it (the gallery's size),
  // so the box has its shape before the video loads. The player reads the
  // real one from the video (loadedmetadata, resize) and sets it on the
  // root as --player-aspect with data-aspect (portrait, square,
  // landscape); until then 16:9 is the CSS's. onAspectRatio hears each one.
  aspectRatio?: number;
  onAspectRatio?: (ratio: number) => void;
  // Interactions run as in the editor's Preview as student; pass none where
  // the place hides them.
  interactions?: Interaction[];
  viewer?: InteractionViewer;
  interactionState?: InteractionState; // the viewer's, from earlier visits
  onInteraction?: (event: InteractionEvent) => void; // to save outcomes, answers, contacts
  onSwitchVideo?: (videoId: string) => void; // "Switch video": the app swaps src
  // Language of the controls and numbers (BCP 47). Default: en.
  locale?: string;
  labels?: Partial<VideoPlayerLabels>; // over the English defaults
  classNames?: VideoPlayerClassNames; // the player ships no styles
  className?: string; // added to the root
  // Back and forward buttons by this many seconds beside play (with a seek
  // bar only). Default: none.
  skipSeconds?: number;
  // Fills a dynamic watermark's tokens ({name}, {email}…): the signed-in
  // learner and the school. Without it the tokens are left out.
  watermarkViewer?: WatermarkViewer;
};

const Engine = lazy(() =>
  import('./video-player-engine').then((x) => ({default: x.VideoPlayerEngine})),
);

// VideoPlayer is the one video player (Video.js 10). It renders only in the
// browser and loads the player on first use, so pages without video and the
// server never pay for it. Until then it renders an empty root.
export function VideoPlayer(props: VideoPlayerProps) {
  const placeholder = (
    <div data-placeholder="" className={cx(props.classNames?.root, props.className)} />
  );
  if (!useHydrated()) return placeholder;
  const wistia = wistiaEmbedUrl(props.src);
  if (wistia) {
    return (
      <div data-embed="wistia" className={cx(props.classNames?.root, props.className)}>
        <iframe
          src={props.config?.autoplay ? `${wistia}${wistia.includes('?') ? '&' : '?'}autoPlay=true` : wistia}
          title={props.title ?? ''}
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
    );
  }
  return (
    <Suspense fallback={placeholder}>
      <Engine {...props} />
    </Suspense>
  );
}

const noop = () => () => {};

// useHydrated is false on the server and in the hydrating render.
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}
