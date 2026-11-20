import {
  isMediaPauseCapable,
  isMediaPlaybackRateCapable,
  isMediaSeekCapable,
  useMedia,
} from '@videojs/react';
import {useEffect} from 'react';

import {useEffectEvent} from './use-effect-event';

import {createWatchTracker, type WatchedRange} from './watched-ranges';

// What both players report while they play: watched ranges, the length once
// known, the media itself (for notes and transcripts that read and set the
// time) and a small event log (for analytics). Shared by the video and the
// audio engine so both behave the same.

export type MediaProgress = {
  reason: 'interval' | 'pause' | 'ended' | 'leave';
  position: number; // seconds
  duration: number; // seconds, 0 while unknown
  ranges: WatchedRange[]; // watched since the last report, merged
};

// PlayerMedia is the playing media as the app may use it: read and set the
// time, play and pause, and listen to the media events (timeupdate, seeked,
// loadedmetadata…). It is the native element or Video.js's adapter for an
// engine or an embed (YouTube, Vimeo), which behave alike.
export type PlayerMedia = EventTarget & {
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  play: () => Promise<void> | void;
  pause: () => void;
};

// PlayerEvent is one thing the learner did, for analytics only (never for
// progress): `at` is the position in seconds; a seek has from and to, a
// rate change its new rate in v.
export type PlayerEvent = {
  t: 'play' | 'pause' | 'seek' | 'rate' | 'ended' | 'captions' | 'fullscreen';
  at: number;
  from?: number;
  to?: number;
  v?: number | string;
};

export type MediaWatchProps = {
  resume: boolean; // start at startAt
  startAt?: number;
  furthestWatched?: number; // seconds already played in earlier sessions
  allowSeekAhead: boolean; // false: a seek past the furthest point played is pulled back
  progressInterval?: number; // ms between reports while playing (default 10 s)
  onProgress?: (progress: MediaProgress) => void;
  onEnded?: () => void;
  onDuration?: (seconds: number) => void; // whole seconds, each time the length changes
  onMedia?: (media: PlayerMedia | null) => void; // null when the player goes
  onPlayerEvent?: (event: PlayerEvent) => void;
};

// A seek this far past the furthest point played is pulled back.
const seekSlack = 1;

// MediaWatch resumes at startAt, reports watched ranges and, unless seeking
// ahead is allowed, pulls a seek past the furthest point played back to it.
export function MediaWatch(props: MediaWatchProps) {
  const media = useMedia();
  const settings = useEffectEvent(() => {
    const startAt = props.resume ? (props.startAt ?? 0) : 0;
    return {
      startAt,
      furthest: Math.max(props.furthestWatched ?? 0, startAt),
      blockSeeking: !props.allowSeekAhead,
      interval: props.progressInterval ?? 10_000,
    };
  });
  const report = useEffectEvent((progress: MediaProgress) => props.onProgress?.(progress));
  const ended = useEffectEvent(() => props.onEnded?.());
  const length = useEffectEvent((seconds: number) => props.onDuration?.(seconds));
  const expose = useEffectEvent((m: PlayerMedia | null) => props.onMedia?.(m));
  const log = useEffectEvent((event: PlayerEvent) => props.onPlayerEvent?.(event));

  useEffect(() => {
    if (!isMediaSeekCapable(media)) return;
    const {startAt, furthest, blockSeeking, interval} = settings();
    const tracker = createWatchTracker(furthest);
    const paused = () => isMediaPauseCapable(media) && media.paused;
    // The last position the media reported: on unmount an embed's adapter
    // may already be torn down and read 0.
    let position = 0;
    let duration = 0;
    let reported = 0;
    let seekFrom: number | null = null;
    const sample = () => {
      if (!(media.duration > 0)) return;
      position = media.currentTime;
      duration = media.duration;
    };
    const send = (reason: MediaProgress['reason'], ranges = tracker.take()) =>
      report({reason, position, duration, ranges});
    const at = () => Math.floor(position);

    let resumed = startAt <= 0;
    // A source that can't seek yet (no byte ranges, or not buffered) leaves the first seek at 0:
    // try again, briefly, once the media can play or has more data. Never after the viewer moved.
    let resumeSettled = startAt <= 0;
    let resumeTries = 0;
    let resumeUntil = 0;
    const retryResume = () => {
      if (resumeSettled || !resumed || !(media.duration > 0)) return;
      const target = Math.min(startAt, media.duration);
      if (media.currentTime >= target - 1) {
        resumeSettled = true;
        return;
      }
      if (resumeTries >= 3 || performance.now() > resumeUntil || media.currentTime > 2) {
        resumeSettled = true;
        return;
      }
      resumeTries++;
      seek(media, target);
    };
    const resume = () => {
      sample();
      const whole = Number.isFinite(media.duration) ? Math.round(media.duration) : 0;
      if (whole > 0 && whole !== reported) {
        reported = whole;
        length(whole);
      }
      if (resumed || !(media.duration > 0)) return;
      resumed = true;
      resumeTries = 1;
      resumeUntil = performance.now() + 5000;
      seek(media, Math.min(startAt, media.duration));
    };
    const onTime = () => {
      sample();
      if (paused() || media.seeking) return;
      const rate = isMediaPlaybackRateCapable(media) ? media.playbackRate : 1;
      tracker.observe(media.currentTime, rate, performance.now());
    };
    const onSeeking = () => {
      if (seekFrom === null) seekFrom = position;
      sample();
      tracker.interrupt();
      if (blockSeeking && media.currentTime > tracker.furthest() + seekSlack) {
        seek(media, tracker.furthest());
      }
    };
    const onSeeked = () => {
      sample();
      if (seekFrom !== null && Math.abs(position - seekFrom) >= 1) {
        log({t: 'seek', at: at(), from: Math.floor(seekFrom), to: at()});
      }
      seekFrom = null;
    };
    const onPlay = () => {
      sample();
      log({t: 'play', at: at()});
    };
    const onPause = () => {
      sample();
      tracker.interrupt();
      if (!(isMediaPauseCapable(media) && media.ended)) {
        send('pause');
        log({t: 'pause', at: at()});
      }
    };
    const onEnded = () => {
      sample();
      tracker.interrupt();
      send('ended');
      log({t: 'ended', at: at()});
      ended();
    };
    const onRate = () => {
      if (isMediaPlaybackRateCapable(media)) {
        log({t: 'rate', at: at(), v: media.playbackRate});
      }
    };
    const onLeave = () => {
      sample();
      send('leave');
    };
    const timer = setInterval(() => {
      if (paused()) return;
      const ranges = tracker.take();
      if (ranges.length > 0) send('interval', ranges);
    }, interval);

    const cleanups = Object.entries({
      loadedmetadata: resume,
      durationchange: resume,
      canplay: retryResume,
      progress: retryResume,
      playing: onTime,
      timeupdate: onTime,
      seeking: onSeeking,
      seeked: onSeeked,
      play: onPlay,
      pause: onPause,
      ended: onEnded,
      ratechange: onRate,
    }).map(([name, fn]) => listen(media, name, fn));
    cleanups.push(listen(window, 'pagehide', onLeave));
    resume();
    expose(media as unknown as PlayerMedia);
    return () => {
      clearInterval(timer);
      for (const cleanup of cleanups) cleanup();
      tracker.interrupt();
      send('leave');
      expose(null);
    };
  }, [media]);

  return null;
}

export function listen(target: unknown, name: string, fn: () => void): () => void {
  // Media types only the events every media has; seek-, rate- and
  // volume-capable media (the native element and the engine and embed
  // adapters) fire the matching events as well.
  const events = target as EventTarget;
  events.addEventListener(name, fn);
  return () => events.removeEventListener(name, fn);
}

// The media is not React state: this writes it outside the components.
function seek(media: {currentTime: number}, time: number) {
  media.currentTime = time;
}
