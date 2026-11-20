import {
  Container,
  createPlayer,
  ErrorDialog,
  Hotkey,
  MuteButton,
  PlayButton,
  StatusAnnouncer,
  Time,
  TimeSlider,
  VolumeSlider,
} from '@videojs/react';
import {Audio, audioFeatures} from '@videojs/react/audio';
import {I18nProvider} from '@videojs/react/i18n';
import {
  PauseIcon,
  PlayIcon,
  RestartIcon,
  VolumeHighIcon,
  VolumeLowIcon,
  VolumeOffIcon,
} from '@videojs/react/icons';
import {videoFeatures} from '@videojs/react/video';

import type {AudioPlayerClassNames, AudioPlayerProps} from './audio-player';
import {useChaptersTrack} from './chapters-track';
import {chapterAt, chaptersVtt, type VideoChapter} from './interactions';
import {MediaWatch} from './media-watch';
import {cx} from './player-ui';

// The audio preset's features plus the text tracks (the video preset's
// feature): the seek bar's chapters read the chapters track's cues.
const {Player, usePlayer} = createPlayer({
  features: [...audioFeatures, ...videoFeatures.filter((f) => f.name === 'textTrack')],
  displayName: 'AudioPlayer',
});

// AudioPlayerEngine is the player itself; load it through AudioPlayer. Its
// skin is Video.js's primitives with no styles: play, the seek bar (split
// into the file's chapters when it has them, with the pointed time's
// chapter and time above it), the time (and the playing chapter), mute and
// volume, the error dialog, Video.js's playback keys while it has the focus.
export function AudioPlayerEngine(props: AudioPlayerProps) {
  const c = props.classNames ?? {};
  const chapters = props.chapters ?? [];
  const vtt = chapters.length > 0 ? chaptersVtt(chapters) : '';
  const chaptersTrack = useChaptersTrack(vtt);
  return (
    <I18nProvider locale={props.locale ?? 'en'} translations={props.labels?.player}>
      {/* A new source starts a new player: no state carries over. */}
      <Player key={props.src}>
        <Container className={cx(c.root, props.className)} aria-label={props.label}>
          <Audio
            src={props.type ? undefined : props.src}
            preload="metadata"
            onError={props.onError}
          >
            {props.type && <source src={props.src} type={props.type} />}
            {vtt && <track key={`chapters:${vtt}`} ref={chaptersTrack} kind="chapters" default />}
          </Audio>
          <div className={c.controls}>
            <PlayButton className={c.button} data-control="play">
              <PlayIconFor c={c} />
            </PlayButton>
            <SeekBar chapters={vtt !== ''} c={c} />
            <Time.Group className={c.time}>
              <Time.Value type="current" className={c.timeCurrent} />
              <Time.Separator className={c.timeSeparator} />
              <Time.Value type="duration" className={c.timeDuration} />
              {chapters.length > 0 && <CurrentChapter chapters={chapters} c={c} />}
            </Time.Group>
            <div className={c.volume}>
              <MuteButton className={c.button} data-control="mute">
                <VolumeIconFor c={c} />
              </MuteButton>
              <VolumeSlider.Root className={c.volumeSlider}>
                <VolumeSlider.Track className={c.volumeTrack}>
                  <VolumeSlider.Fill className={c.volumeFill} />
                </VolumeSlider.Track>
              </VolumeSlider.Root>
            </div>
          </div>
          <ErrorDialog.Root>
            <ErrorDialog.Backdrop className={c.errorBackdrop} />
            <ErrorDialog.Popup className={c.errorPopup}>
              <ErrorDialog.Title className={c.errorTitle} />
              <ErrorDialog.Description className={c.errorDescription} />
              <ErrorDialog.Close className={c.errorClose} />
            </ErrorDialog.Popup>
          </ErrorDialog.Root>
          <MediaWatch
            resume
            startAt={props.startAt}
            furthestWatched={props.furthestWatched}
            allowSeekAhead={props.allowSeekAhead ?? true}
            progressInterval={props.progressInterval}
            onProgress={props.onProgress}
            onEnded={props.onEnded}
            onDuration={props.onDuration}
            onMedia={props.onMedia}
            onPlayerEvent={props.onPlayerEvent}
          />
          <AudioKeys />
          <StatusAnnouncer />
        </Container>
      </Player>
    </I18nProvider>
  );
}

// SeekBar is the time slider, in the chapters' segments when it has them
// (each holds a whole track; clip it with --media-slider-chapter-start and
// -end), and the pointed time's chapter title and time above it.
function SeekBar({chapters, c}: {chapters: boolean; c: AudioPlayerClassNames}) {
  const track = (
    <TimeSlider.Track className={c.seekTrack}>
      <TimeSlider.Buffer className={c.seekBuffer} />
      <TimeSlider.Fill className={c.seekFill} />
    </TimeSlider.Track>
  );
  return (
    <TimeSlider.Root className={c.seek}>
      {chapters ? (
        <TimeSlider.Chapters
          className={c.seekChapters}
          renderChapter={(props) => (
            <div {...props} className={c.seekChapter}>
              {track}
            </div>
          )}
        />
      ) : (
        track
      )}
      <TimeSlider.Thumb className={c.seekThumb} />
      {chapters && (
        <TimeSlider.Preview className={c.seekPreview}>
          <TimeSlider.ChapterTitle className={c.seekChapterTitle} />
          <TimeSlider.Value type="pointer" className={c.seekValue} />
        </TimeSlider.Preview>
      )}
    </TimeSlider.Root>
  );
}

// CurrentChapter is the playing chapter's title after the time; it renders
// again only when the chapter changes.
function CurrentChapter({
  chapters,
  c,
}: {
  chapters: readonly VideoChapter[];
  c: AudioPlayerClassNames;
}) {
  const title = usePlayer((s) => chapterAt(chapters, s.currentTime ?? 0)?.title ?? '');
  if (!title) return null;
  return (
    <span className={c.timeChapter} data-chapter="">
      {title}
    </span>
  );
}

function PlayIconFor({c}: {c: AudioPlayerClassNames}) {
  const paused = usePlayer((s) => s.paused);
  const ended = usePlayer((s) => s.ended);
  if (ended) return <RestartIcon className={c.icon} />;
  return paused ? <PlayIcon className={c.icon} /> : <PauseIcon className={c.icon} />;
}

function VolumeIconFor({c}: {c: AudioPlayerClassNames}) {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  if (muted || volume === 0) return <VolumeOffIcon className={c.icon} />;
  return volume < 0.5 ? (
    <VolumeLowIcon className={c.icon} />
  ) : (
    <VolumeHighIcon className={c.icon} />
  );
}

// AudioKeys are Video.js's audio skin's playback keys (no speed keys: the
// player shows no speed).
function AudioKeys() {
  return (
    <>
      <Hotkey keys="Space" action="togglePaused" />
      <Hotkey keys="k" action="togglePaused" />
      <Hotkey keys="m" action="toggleMuted" />
      <Hotkey keys="ArrowRight" action="seekStep" />
      <Hotkey keys="ArrowLeft" action="seekStep" />
      <Hotkey keys="l" action="seekStep" />
      <Hotkey keys="j" action="seekStep" />
      <Hotkey keys="ArrowUp" action="volumeStep" />
      <Hotkey keys="ArrowDown" action="volumeStep" />
      <Hotkey keys="0-9" action="seekToPercent" />
      <Hotkey keys="Home" action="seekToPercent" value={0} />
      <Hotkey keys="End" action="seekToPercent" value={100} />
    </>
  );
}
