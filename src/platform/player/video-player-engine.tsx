import {
  isMediaPlaybackRateCapable,
  isMediaTextTrackCapable,
  isMediaVolumeCapable,
  resolveAdapterType,
  useMedia,
} from '@videojs/react';
import {I18nProvider} from '@videojs/react/i18n';
import {Video, VideoPlayer as Player} from '@videojs/react/video';
import {lazy, Suspense, useEffect, useState} from 'react';

import {useEffectEvent} from './use-effect-event';

import {useChaptersTrack} from './chapters-track';
import {InteractionLayer} from './interaction-layer';
import {chaptersVtt} from './interactions';
import {createLinkRenewal, type PlaybackLink} from './link-renewal';
import {englishLabels} from './labels';
import {listen, MediaWatch} from './media-watch';
import {defaultPlayerConfig, nearest, type PlayerConfig} from './player-config';
import {PlayerUiContext} from './player-ui';
import {seekPreviewOf} from './seek-preview';
import type {VideoCaption, VideoPlayerProps, VideoPreferences} from './video-player';
import {VideoPlayerSkin} from './video-player-skin';

// Each engine is its own chunk: a page loads only the one its source needs.
const HlsJsVideo = lazy(() =>
  import('@videojs/react/media/hlsjs-video').then((x) => ({default: x.HlsJsVideo})),
);
const YouTubeVideo = lazy(() =>
  import('@videojs/react/media/youtube-video').then((x) => ({default: x.YouTubeVideo})),
);
// YouTube refuses to play in a frame whose request carries no Referer (error 153). Video.js builds
// that frame itself, so it takes the page's referrer policy; this sends the site's origin, as
// YouTube's own IFrame API does.
const YOUTUBE_ENGINE = {referrerPolicy: 'strict-origin-when-cross-origin'} as const;

const VimeoVideo = lazy(() =>
  import('@videojs/react/media/vimeo-video').then((x) => ({default: x.VimeoVideo})),
);

// hls.js runs on the page, without a worker: sites' and the dashboard's
// Content-Security-Policy allow no blob: worker.
const hlsEngine = {hlsJs: {enableWorker: false}};

// VideoPlayerEngine is the player itself; load it through VideoPlayer.
export function VideoPlayerEngine(props: VideoPlayerProps) {
  const {
    src: givenSrc,
    type,
    poster,
    captions = [],
    chapters = [],
    interactions = [],
    drm,
    className,
  } = props;
  // The link playing: the given one, or a fresh one renewLink swapped in
  // (same video, same player). A new src is a new video.
  const [renewed, setRenewed] = useState<(PlaybackLink & {of: string}) | null>(null);
  const link: PlaybackLink =
    renewed && renewed.of === givenSrc ? renewed : {src: givenSrc, expiresAt: props.expiresAt};
  const src = link.src;
  const config = props.config ?? defaultPlayerConfig;
  const locale = props.locale ?? 'en';
  const labels = {...englishLabels, ...props.labels};
  // Cross-origin caption files need a CORS request for the media as well; a
  // relative one (the page's own host) needs none, so the media isn't asked
  // for CORS it may not send.
  const crossOrigin = captions.some((c) => absoluteUrl(c.src)) ? 'anonymous' : undefined;
  const shown = shownCaption(captions, config);
  const tracks = captions.map((c) => (
    <track
      key={c.src}
      kind="captions"
      src={c.src}
      srcLang={c.srclang}
      label={c.label}
      default={c === shown}
    />
  ));
  // A new set of chapters is a new track element: a track loads its src once.
  const vtt = chapters.length > 0 ? chaptersVtt(chapters) : '';
  const chaptersTrack = useChaptersTrack(vtt);
  if (vtt) {
    tracks.push(<track key={`chapters:${vtt}`} ref={chaptersTrack} kind="chapters" default />);
  }
  const autoPlay = config.autoplay;
  // The video's own shape once it is known, else the page's.
  const [measured, setMeasured] = useState<{src: string; ratio: number} | null>(null);
  const aspectRatio =
    (measured?.src === givenSrc ? measured.ratio : undefined) ?? validRatio(props.aspectRatio);

  const kind = resolveAdapterType(src, type);
  // YouTube and Vimeo show their own captions, on their own terms. (Wistia
  // never reaches the engine: VideoPlayer frames it, wistia.ts.)
  const embed = kind === 'youtube' || kind === 'vimeo';
  let media;
  switch (kind) {
    case 'youtube':
      media = (
        <YouTubeVideo
          src={src}
          source={{src, engine: {youtube: YOUTUBE_ENGINE}}}
          autoPlay={autoPlay}
          loop={config.loop}
          onError={props.onError}
        />
      );
      break;
    case 'vimeo':
      media = <VimeoVideo src={src} autoPlay={autoPlay} loop={config.loop} onError={props.onError} />;
      break;
    case 'hls':
    case 'mux': // a Mux stream URL is HLS
      media = (
        <HlsJsVideo
          source={{src, type, drm, engine: hlsEngine}}
          autoPlay={autoPlay}
          loop={config.loop}
          playsInline
          crossOrigin={crossOrigin}
        >
          {tracks}
        </HlsJsVideo>
      );
      break;
    default:
      media = (
        <Video
          src={src}
          autoPlay={autoPlay}
          loop={config.loop}
          playsInline
          crossOrigin={crossOrigin}
          onError={props.onError}
        >
          {tracks}
        </Video>
      );
  }

  return (
    <PlayerUiContext.Provider value={{classNames: props.classNames ?? {}, labels, locale}}>
      <I18nProvider locale={locale} translations={labels.player}>
        {/* A new source starts a new player: no state or ranges carry over. */}
        <Player key={givenSrc} poster={poster}>
          <VideoPlayerSkin
            config={config}
            skipSeconds={props.skipSeconds ?? config.skipSeconds}
            watermarkViewer={props.watermarkViewer}
            chapters={embed ? [] : chapters}
            marks={embed ? [] : (props.marks ?? [])}
            seekPreview={embed ? undefined : seekPreviewOf(props.seekPreview)}
            onAskAi={props.onAskAi}
            furthestWatched={props.furthestWatched}
            aspectRatio={aspectRatio}
            className={className}
            overlay={
              interactions.length > 0 && (
                <InteractionLayer
                  interactions={interactions}
                  viewer={props.viewer}
                  interactionState={props.interactionState}
                  onInteraction={props.onInteraction}
                  onSwitchVideo={props.onSwitchVideo}
                />
              )
            }
          >
            <Suspense>{media}</Suspense>
          </VideoPlayerSkin>
          <MediaWatch
            resume={config.resumePosition}
            startAt={props.startAt}
            furthestWatched={props.furthestWatched}
            allowSeekAhead={config.allowSeekAhead}
            progressInterval={props.progressInterval}
            onProgress={props.onProgress}
            onEnded={props.onEnded}
            onDuration={props.onDuration}
            onMedia={props.onMedia}
            onPlayerEvent={props.onPlayerEvent}
          />
          {!embed && (
            <AspectWatch
              onRatio={(ratio) => {
                setMeasured((m) =>
                  m?.src === givenSrc && m.ratio === ratio ? m : {src: givenSrc, ratio},
                );
                props.onAspectRatio?.(ratio);
              }}
            />
          )}
          {props.renewLink && (
            <LinkKeeper
              link={link}
              renewLink={props.renewLink}
              onRenewed={(next) => setRenewed({...next, of: givenSrc})}
              onLinkLost={props.onLinkLost}
            />
          )}
          <PreferenceKeeper
            config={config}
            captionLanguage={shown?.srclang ?? null}
            trackCaptions={!embed}
            onChange={props.onPreferencesChange}
          />
        </Player>
      </I18nProvider>
    </PlayerUiContext.Provider>
  );
}

// LinkKeeper keeps a signed link fresh (link-renewal.ts): ahead of its
// expiry while it plays, and when the stream refuses it. The fresh link plays
// from the same moment, playing or paused as before.
function LinkKeeper({
  link,
  renewLink,
  onRenewed,
  onLinkLost,
}: {
  link: PlaybackLink;
  renewLink: NonNullable<VideoPlayerProps['renewLink']>;
  onRenewed: (link: PlaybackLink) => void;
  onLinkLost?: () => void;
}) {
  const media = useMedia() as unknown as
    | (EventTarget & {currentTime: number; paused: boolean; error?: unknown; play?: () => unknown})
    | null;
  const first = useEffectEvent(() => link);
  const renew = useEffectEvent(() => renewLink());
  const renewed = useEffectEvent((next: PlaybackLink) => onRenewed(next));
  const lost = useEffectEvent(() => onLinkLost?.());

  useEffect(() => {
    if (!media) return;
    // Where the old link was, put back once the fresh one has loaded. `wanted`
    // is the viewer's last play or pause: a refused part stalls the media
    // without pausing it, and the fresh link carries on playing.
    let restore: {time: number; playing: boolean} | null = null;
    let wanted = !media.paused;
    const keeper = createLinkRenewal({
      link: first(),
      renew,
      isPlaying: () => !media.paused,
      swap: (next) => {
        restore = {time: media.currentTime, playing: wanted || !media.paused};
        renewed(next);
      },
      onGiveUp: lost,
    });
    const onLoaded = () => {
      if (!restore) return;
      const {time, playing} = restore;
      restore = null;
      if (time > 0) media.currentTime = time;
      if (playing) void Promise.resolve(media.play?.()).catch(() => {});
    };
    const onPlay = () => {
      wanted = true;
      keeper.played();
    };
    const onPause = () => {
      wanted = false;
    };
    const onError = (event: Event) => {
      keeper.failed((event as ErrorEvent).error ?? media.error);
    };
    const off = [
      listen(media, 'play', onPlay),
      listen(media, 'pause', onPause),
      listen(media, 'loadedmetadata', onLoaded),
      listenEvent(media, 'error', onError),
    ];
    return () => {
      keeper.stop();
      off.forEach((f) => f());
    };
  }, [media]);
  return null;
}

function listenEvent(target: EventTarget, name: string, fn: (event: Event) => void) {
  target.addEventListener(name, fn);
  return () => target.removeEventListener(name, fn);
}

// AspectWatch reports the video's width ÷ height when its size is known or
// changes (an HLS rendition of another shape fires resize).
function AspectWatch({onRatio}: {onRatio: (ratio: number) => void}) {
  const media = useMedia();
  const read = useEffectEvent(() => {
    const m = media as unknown as {videoWidth?: number; videoHeight?: number} | null;
    const ratio = validRatio((m?.videoWidth ?? 0) / (m?.videoHeight || 1));
    if (ratio && m?.videoHeight) onRatio(Math.round(ratio * 10000) / 10000);
  });
  useEffect(() => {
    if (!media) return;
    read();
    const off = [listen(media, 'loadedmetadata', read), listen(media, 'resize', read)];
    return () => off.forEach((f) => f());
  }, [media]);
  return null;
}

// validRatio is r when it is a usable width ÷ height (1:4 to 4:1), else undefined.
export function validRatio(r: number | undefined): number | undefined {
  return typeof r === 'number' && Number.isFinite(r) && r >= 0.25 && r <= 4 ? r : undefined;
}

// absoluteUrl: a URL with its own scheme (another host, maybe), not a path
// on the page's host (nor a data: or blob: URL, which are the page's own).
function absoluteUrl(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) && !/^(data|blob):/i.test(src);
}

// shownCaption is the track to show first: none with captions off, else the
// config's language, else the track marked default, else the first.
function shownCaption(captions: VideoCaption[], config: PlayerConfig): VideoCaption | undefined {
  if (!config.captionsOn) return undefined;
  const lang = config.captionLanguage?.toLowerCase();
  return (
    captions.find((c) => lang && c.srclang.toLowerCase() === lang) ??
    captions.find((c) => c.default) ??
    captions[0]
  );
}

// PreferenceKeeper starts the media at the config's speed and volume, keeps
// the speed to the config's rates (keys and other controls included) and
// reports what the learner changes, for their preferences: only what differs
// from what the player started with or last reported.
function PreferenceKeeper({
  config,
  captionLanguage,
  trackCaptions,
  onChange,
}: {
  config: PlayerConfig;
  captionLanguage: string | null;
  trackCaptions: boolean;
  onChange?: (preferences: VideoPreferences) => void;
}) {
  const media = useMedia();
  const settings = useEffectEvent(() => ({config, captionLanguage, trackCaptions}));
  const changed = useEffectEvent((p: VideoPreferences) => onChange?.(p));

  useEffect(() => {
    const {config: c, captionLanguage: language, trackCaptions: withCaptions} = settings();
    const {playbackRate, playbackRates, volume, muted} = c;
    let last: VideoPreferences = {
      playbackRate,
      volume,
      muted,
      captionsOn: c.captionsOn,
      captionLanguage: c.captionsOn ? language : null,
    };
    const report = (p: VideoPreferences) => {
      const diff = Object.fromEntries(
        Object.entries(p).filter(([k, v]) => last[k as keyof VideoPreferences] !== v),
      );
      if (Object.keys(diff).length === 0) return;
      last = {...last, ...diff};
      changed(diff);
    };
    const cleanups: (() => void)[] = [];
    if (isMediaPlaybackRateCapable(media)) {
      setRate(media, playbackRate);
      const onRate = () => {
        const allowed = nearest(playbackRates, media.playbackRate);
        if (allowed !== media.playbackRate) setRate(media, allowed);
        else report({playbackRate: allowed});
      };
      cleanups.push(listen(media, 'ratechange', onRate));
    }
    if (isMediaVolumeCapable(media)) {
      setVolume(media, volume, muted);
      cleanups.push(
        listen(media, 'volumechange', () => report({volume: media.volume, muted: media.muted})),
      );
    }
    if (withCaptions && isMediaTextTrackCapable(media)) {
      const onTracks = () => {
        const showing = [...media.textTracks].find(
          (t) => (t.kind === 'captions' || t.kind === 'subtitles') && t.mode === 'showing',
        );
        // Turning captions off keeps the language for next time.
        report(
          showing
            ? {captionsOn: true, captionLanguage: showing.language || null}
            : {captionsOn: false},
        );
      };
      cleanups.push(listen(media.textTracks, 'change', onTracks));
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [media]);

  return null;
}

// The media is not React state: these write it outside the components.
function setRate(media: {playbackRate: number}, rate: number) {
  media.playbackRate = rate;
}

function setVolume(media: {volume: number; muted: boolean}, volume: number, muted: boolean) {
  media.volume = volume;
  media.muted = muted;
}
