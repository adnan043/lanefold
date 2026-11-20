import {lazy, Suspense} from 'react';

import type {VideoChapter} from './interactions';
import type {AudioPlayerLabels} from './labels';
import type {MediaProgress, PlayerEvent, PlayerMedia} from './media-watch';
import {cx} from './player-ui';
import {useHydrated} from './video-player';

// The audio player ships no styles either. Every element takes a class from
// `classNames` by slot and shows its state in data attributes (Video.js's,
// such as data-paused, data-ended and data-pointing, and data-control on
// buttons), so any CSS can style it.
export type AudioPlayerSlot =
  | 'root'
  | 'controls'
  | 'button' // the play and mute buttons; data-control names it
  | 'icon'
  | 'seek'
  | 'seekChapters' // with chapters: the seek bar's segments
  | 'seekChapter'
  | 'seekTrack'
  | 'seekBuffer'
  | 'seekFill'
  | 'seekThumb'
  | 'seekPreview' // above the pointed time: its chapter's title and the time
  | 'seekChapterTitle'
  | 'seekValue'
  | 'time'
  | 'timeCurrent'
  | 'timeSeparator'
  | 'timeDuration'
  | 'timeChapter' // the playing chapter's title after the time
  | 'volume'
  | 'volumeSlider'
  | 'volumeTrack'
  | 'volumeFill'
  | 'errorBackdrop'
  | 'errorPopup'
  | 'errorTitle'
  | 'errorDescription'
  | 'errorClose';

export type AudioPlayerClassNames = Partial<Record<AudioPlayerSlot, string>>;

export type AudioPlayerProps = {
  src: string; // an audio file (MP3, M4A, WAV, OGG, AAC, FLAC) or a blob: URL
  type?: string; // MIME type, when the URL doesn't show it
  // The player's accessible name (the file's name). Default: Video.js's
  // container label.
  label?: string;
  // The file's chapters (the gallery's): they divide the seek bar, name the
  // pointed time's chapter and follow the time. No frames: audio has none.
  chapters?: VideoChapter[];
  // The file can't be loaded or played.
  onError?: () => void;
  // Progress, as the video player reports it (a course lesson's heartbeat).
  startAt?: number; // seconds, to resume
  furthestWatched?: number; // seconds already played in earlier sessions
  allowSeekAhead?: boolean; // false: no seeking past the furthest point played (default true)
  progressInterval?: number; // ms between reports while playing (default 10 s)
  onProgress?: (progress: MediaProgress) => void;
  onEnded?: () => void;
  onDuration?: (seconds: number) => void;
  onMedia?: (media: PlayerMedia | null) => void;
  onPlayerEvent?: (event: PlayerEvent) => void;
  // Language of the controls and numbers (BCP 47). Default: en.
  locale?: string;
  labels?: Partial<AudioPlayerLabels>; // over Video.js's English
  classNames?: AudioPlayerClassNames; // the player ships no styles
  className?: string; // added to the root
};

const Engine = lazy(() =>
  import('./audio-player-engine').then((x) => ({default: x.AudioPlayerEngine})),
);

// AudioPlayer is the one audio player (Video.js 10's audio preset). Like
// VideoPlayer it renders only in the browser and loads the player on first
// use; until then it renders an empty root.
export function AudioPlayer(props: AudioPlayerProps) {
  const placeholder = (
    <div data-placeholder="" className={cx(props.classNames?.root, props.className)} />
  );
  if (!useHydrated()) return placeholder;
  return (
    <Suspense fallback={placeholder}>
      <Engine {...props} />
    </Suspense>
  );
}
