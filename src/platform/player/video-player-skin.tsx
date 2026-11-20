import {
  BufferingIndicator,
  CaptionsButton,
  Container,
  Controls,
  ErrorDialog,
  FullscreenButton,
  Gesture,
  Hotkey,
  Menu,
  MuteButton,
  PiPButton,
  PlayButton,
  Poster,
  SeekButton,
  StatusAnnouncer,
  Time,
  TimeSlider,
  Tooltip,
  VolumeSlider,
  useCaptionsOptions,
  useQualityOptions,
} from '@videojs/react';
import {usePlayer} from '@videojs/react/video';
import {useMemo, type CSSProperties, type ReactElement, type ReactNode} from 'react';

import {ChapterButton, ChaptersPanel, sortedChapters, usePanelState} from './chapters-panel';
import type {VideoChapter, VideoMark} from './interactions';
import {barOf, type PlayerConfig} from './player-config';
import {
  AskAiIcon,
  CaptionsIcon,
  CheckIcon,
  ChevronIcon,
  FullscreenExitIcon,
  FullscreenIcon,
  MuteIcon,
  PauseIcon,
  PipIcon,
  PlayIcon,
  ReplayIcon,
  SettingsIcon,
  SkipIcon,
  SpinnerIcon,
  VolumeHighIcon,
  VolumeLowIcon,
} from './player-icons';
import {
  BigPlay,
  EndScreen,
  Logo,
  Watermark,
  useProtection,
  type WatermarkViewer,
} from './player-overlays';
import {cx, usePlayerUi, type VideoPlayerClassNames} from './player-ui';
import {seekFrameStyle, type SeekPreview} from './seek-preview';

// The skin is Video.js's primitives with no styles: each element takes its
// slot's class, and states are data attributes (Video.js's, plus
// data-control on buttons). Icons follow the player state, so the markup
// works unstyled. Which controls show, and which keys and gestures work, is
// the resolved PlayerConfig's. The accent reaches CSS as --player-accent.

export function VideoPlayerSkin({
  config,
  chapters,
  marks = [],
  seekPreview,
  onAskAi,
  skipSeconds,
  furthestWatched = 0,
  aspectRatio,
  overlay,
  watermarkViewer,
  className,
  children,
}: {
  config: PlayerConfig;
  chapters: readonly VideoChapter[]; // with a chapters track: the seek bar and the time show them
  marks?: readonly VideoMark[]; // dots on the seek bar (moments)
  seekPreview?: SeekPreview; // frames above the seek bar's pointed time
  onAskAi?: () => void; // an Ask AI button before captions
  skipSeconds?: number; // back/forward buttons by this many seconds (with a seek bar)
  furthestWatched?: number; // seconds played before (key moments past it lock when seeking ahead is off)
  aspectRatio?: number; // the video's width ÷ height when known (--player-aspect, data-aspect)
  overlay?: ReactNode; // between the video and the controls
  watermarkViewer?: WatermarkViewer; // fills the watermark's tokens
  className?: string;
  children: ReactNode;
}) {
  const {classNames: c} = usePlayerUi();
  const sorted = useMemo(() => sortedChapters(chapters), [chapters]);
  const panel = usePanelState();
  const {blurred} = useProtection(config);
  const style = {
    ...(config.accentColor && {'--player-accent': config.accentColor}),
    ...(config.barColor && {'--player-bar': config.barColor}),
    ...(config.iconColor && {'--player-icon': config.iconColor}),
    '--player-radius': `${config.cornerRadius}px`,
    ...(aspectRatio && {'--player-aspect': String(Math.round(aspectRatio * 10000) / 10000)}),
  } as CSSProperties;
  return (
    <Container
      className={cx(c.root, className)}
      style={style}
      data-aspect={aspectRatio ? orientationOf(aspectRatio) : undefined}
      data-chapters-open={panel.open ? '' : undefined}
      data-skin={config.skin}
      data-bar={barOf(config)}
      data-icons={config.iconSize}
      data-autohide={config.autoHide ? undefined : 'off'}
      data-capture-blur={blurred ? '' : undefined}
      onContextMenu={
        config.protection.disableContextMenu
          ? (e: {preventDefault: () => void}) => e.preventDefault()
          : undefined
      }
    >
      {children}
      <Poster.Root className={c.poster}>
        <Poster.Image className={c.posterImage} />
      </Poster.Root>
      <BufferingIndicator className={c.buffering}>
        <SpinnerIcon className={c.bufferingIcon} />
      </BufferingIndicator>
      {overlay}
      <Logo config={config} />
      <Watermark config={config} viewer={watermarkViewer} />
      <BigPlay config={config} />
      <EndScreen config={config} />
      <ErrorDialog.Root>
        <ErrorDialog.Backdrop className={c.errorBackdrop} />
        <ErrorDialog.Popup className={c.errorPopup}>
          <ErrorDialog.Title className={c.errorTitle} />
          <ErrorDialog.Description className={c.errorDescription} />
          <ErrorDialog.Close className={c.errorClose} />
        </ErrorDialog.Popup>
      </ErrorDialog.Root>
      <PlayerControls
        config={config}
        chapters={sorted}
        marks={marks}
        seekPreview={seekPreview}
        onAskAi={onAskAi}
        skipSeconds={skipSeconds}
        chapterButton={
          config.timeDisplay &&
          sorted.length > 0 && (
            <ChapterButton
              chapters={sorted}
              open={panel.open}
              panelId={panel.id}
              buttonRef={panel.buttonRef}
              onToggle={panel.toggle}
              c={c}
            />
          )
        }
        c={c}
      />
      {panel.open && sorted.length > 0 && (
        <ChaptersPanel
          id={panel.id}
          chapters={sorted}
          preview={seekPreview}
          allowSeekAhead={config.allowSeekAhead}
          furthestWatched={furthestWatched}
          onClose={panel.close}
          c={c}
        />
      )}
      <PlayerKeys config={config} />
      <StatusAnnouncer />
    </Container>
  );
}

function PlayerControls({
  config,
  chapters,
  marks,
  seekPreview,
  onAskAi,
  skipSeconds,
  chapterButton,
  c,
}: {
  config: PlayerConfig;
  chapters: readonly VideoChapter[];
  marks: readonly VideoMark[];
  seekPreview?: SeekPreview;
  onAskAi?: () => void;
  skipSeconds?: number;
  chapterButton?: ReactNode;
  c: VideoPlayerClassNames;
}) {
  const {labels} = usePlayerUi();
  const skip = config.seekBar && skipSeconds && skipSeconds > 0 ? skipSeconds : 0;
  const speeds = config.speedControl && config.playbackRates.length > 1;
  return (
    <Controls.Root>
      <Controls.Backdrop className={c.controlsBackdrop} />
      <Controls.Content className={c.controls}>
        <Tooltip.Provider>
          {config.seekBar && (
            <SeekBar chapters={chapters.length > 0} marks={marks} preview={seekPreview} c={c} />
          )}
          <Controls.Group className={c.controlBar}>
            {config.playButton && (
              <WithTooltip c={c}>
                <PlayButton className={c.button} data-control="play">
                  <PlayIconFor c={c} />
                </PlayButton>
              </WithTooltip>
            )}
            {skip > 0 && (
              <WithTooltip c={c}>
                <SeekButton className={c.button} data-control="seek-back" seconds={-skip}>
                  <SkipIcon className={c.icon} seconds={skip} back />
                </SeekButton>
              </WithTooltip>
            )}
            {skip > 0 && (
              <WithTooltip c={c}>
                <SeekButton className={c.button} data-control="seek-forward" seconds={skip}>
                  <SkipIcon className={c.icon} seconds={skip} back={false} />
                </SeekButton>
              </WithTooltip>
            )}
            {config.volumeControl && <Volume c={c} />}
            {config.timeDisplay && (
              <Time.Group className={c.time}>
                <Time.Value type="current" className={c.timeCurrent} />
                <Time.Separator className={c.timeSeparator} />
                <Time.Value type="duration" className={c.timeDuration} />
              </Time.Group>
            )}
            {chapterButton}
            <span className={c.spacer} />
            {onAskAi && (
              <button
                type="button"
                className={c.button}
                data-control="ask-ai"
                aria-label={labels.askAi}
                title={labels.askAi}
                onClick={onAskAi}
              >
                <AskAiIcon className={c.icon} />
              </button>
            )}
            {speeds && <SpeedMenu rates={config.playbackRates} c={c} />}
            {config.captionsControl && <CaptionsControl c={c} />}
            <SettingsMenu rates={speeds ? config.playbackRates : []} c={c} />
            {config.pipButton && (
              <WithTooltip c={c}>
                <PiPButton className={c.button} data-control="pip">
                  <PipIconFor c={c} />
                </PiPButton>
              </WithTooltip>
            )}
            {config.fullscreenButton && (
              <WithTooltip c={c}>
                <FullscreenButton className={c.button} data-control="fullscreen">
                  <FullscreenIconFor c={c} />
                </FullscreenButton>
              </WithTooltip>
            )}
          </Controls.Group>
        </Tooltip.Provider>
      </Controls.Content>
    </Controls.Root>
  );
}

function PlayIconFor({c}: {c: VideoPlayerClassNames}) {
  const paused = usePlayer((s) => s.paused);
  const ended = usePlayer((s) => s.ended);
  if (ended) return <ReplayIcon className={c.icon} />;
  return paused ? <PlayIcon className={c.icon} /> : <PauseIcon className={c.icon} />;
}

function VolumeIconFor({c}: {c: VideoPlayerClassNames}) {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  if (muted || volume === 0) return <MuteIcon className={c.icon} />;
  return volume < 0.5 ? (
    <VolumeLowIcon className={c.icon} />
  ) : (
    <VolumeHighIcon className={c.icon} />
  );
}

function CaptionsIconFor({c}: {c: VideoPlayerClassNames}) {
  const on = usePlayer((s) => s.subtitlesShowing);
  return <CaptionsIcon className={c.icon} data-on={on ? '' : undefined} />;
}

function PipIconFor({c}: {c: VideoPlayerClassNames}) {
  const on = usePlayer((s) => s.isPictureInPicture);
  return <PipIcon className={c.icon} data-on={on ? '' : undefined} />;
}

function FullscreenIconFor({c}: {c: VideoPlayerClassNames}) {
  const on = usePlayer((s) => s.isFullscreen);
  return on ? <FullscreenExitIcon className={c.icon} /> : <FullscreenIcon className={c.icon} />;
}

// orientationOf names a width ÷ height: portrait (9:16, 4:5…), square or landscape.
export function orientationOf(ratio: number): 'portrait' | 'square' | 'landscape' {
  if (ratio < 0.95) return 'portrait';
  return ratio <= 1.05 ? 'square' : 'landscape';
}

// PREVIEW_WIDTH is a preview frame's shown width (px); CSS may scale it.
const PREVIEW_WIDTH = 160;

// SeekFrame is the preview frame at the pointed time: the slider's pointer
// value (seconds) reaches it through the Value part's render prop.
function SeekFrame({preview, c}: {preview: SeekPreview; c: VideoPlayerClassNames}) {
  return (
    <TimeSlider.Value
      type="pointer"
      format={(v) => String(v)}
      render={(props) => (
        <span
          className={c.seekFrame}
          data-frame=""
          aria-hidden="true"
          style={seekFrameStyle(preview, Number(props.children) || 0, PREVIEW_WIDTH)}
        />
      )}
    />
  );
}

// SeekBar splits into the video's chapters when it has them, with the
// pointed time's preview frame (seekPreview), its chapter's title and the
// time above it. Each chapter holds a whole track; clip it to the chapter
// with --media-slider-chapter-start and -end.
function SeekBar({
  chapters,
  marks,
  preview,
  c,
}: {
  chapters: boolean;
  marks: readonly VideoMark[];
  preview?: SeekPreview;
  c: VideoPlayerClassNames;
}) {
  return (
    <TimeSlider.Root className={c.seek}>
      {chapters ? (
        <TimeSlider.Chapters
          className={c.seekChapters}
          renderChapter={(props) => (
            <div {...props} className={c.seekChapter}>
              <SeekTrack c={c} />
            </div>
          )}
        />
      ) : (
        <SeekTrack c={c} />
      )}
      {marks.length > 0 && <SeekMarks marks={marks} c={c} />}
      <TimeSlider.Thumb className={c.seekThumb} />
      <TimeSlider.Preview className={c.seekPreview}>
        {preview && <SeekFrame preview={preview} c={c} />}
        {chapters && <TimeSlider.ChapterTitle className={c.seekChapterTitle} />}
        <TimeSlider.Value type="pointer" className={c.seekValue} />
      </TimeSlider.Preview>
    </TimeSlider.Root>
  );
}

// SeekMarks are the marks' dots over the track, placed by time once the
// length is known; they let pointer events through to the slider.
function SeekMarks({marks, c}: {marks: readonly VideoMark[]; c: VideoPlayerClassNames}) {
  const duration = usePlayer((s) => s.duration ?? 0);
  if (!(duration > 0)) return null;
  return (
    <div aria-hidden className={c.seekMarks}>
      {marks.map((m) => (
        <span
          key={m.time}
          title={m.title}
          className={c.seekMark}
          style={{left: `${Math.min(100, Math.max(0, (m.time / duration) * 100))}%`}}
        />
      ))}
    </div>
  );
}

function SeekTrack({c}: {c: VideoPlayerClassNames}) {
  return (
    <TimeSlider.Track className={c.seekTrack}>
      <TimeSlider.Buffer className={c.seekBuffer} />
      <TimeSlider.Fill className={c.seekFill} />
    </TimeSlider.Track>
  );
}

function Volume({c}: {c: VideoPlayerClassNames}) {
  return (
    <div className={c.volume}>
      <WithTooltip c={c}>
        <MuteButton className={c.button} data-control="mute">
          <VolumeIconFor c={c} />
        </MuteButton>
      </WithTooltip>
      <VolumeSlider.Root className={c.volumeSlider}>
        <VolumeSlider.Track className={c.volumeTrack}>
          <VolumeSlider.Fill className={c.volumeFill} />
        </VolumeSlider.Track>
      </VolumeSlider.Root>
    </div>
  );
}

// SpeedMenu offers the config's rates, not Video.js's fixed list.
function SpeedMenu({rates, c}: {rates: readonly number[]; c: VideoPlayerClassNames}) {
  const {labels, locale} = usePlayerUi();
  const rate = usePlayer((s) => s.playbackRate);
  const store = usePlayer();
  const format = (r: number) => `${new Intl.NumberFormat(locale).format(r)}×`;
  return (
    <Menu.Root side="top" align="end">
      <Menu.Trigger className={c.button} data-control="speed" aria-label={labels.speed}>
        {format(rate)}
      </Menu.Trigger>
      <Menu.Popup className={c.menu}>
        <Menu.Content>
          <Menu.RadioGroup
            value={String(rate)}
            onValueChange={(v) => store.setPlaybackRate(Number(v))}
            aria-label={labels.speed}
          >
            {rates.map((r) => (
              <Menu.RadioItem key={r} value={String(r)} className={c.menuItem}>
                {format(r)}
                <Menu.ItemIndicator>
                  <CheckIcon className={c.menuIndicator} />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Popup>
    </Menu.Root>
  );
}

// CaptionsControl turns captions on and off; with more than one track
// (languages) it is a menu of them with Off, like the quality menu. The
// `c` key still toggles the last one shown.
function CaptionsControl({c}: {c: VideoPlayerClassNames}) {
  const {labels} = usePlayerUi();
  const captions = useCaptionsOptions();
  if (!captions || captions.hidden || captions.options.length < 3) {
    return (
      <WithTooltip c={c}>
        <CaptionsButton className={c.button} data-control="captions">
          <CaptionsIconFor c={c} />
        </CaptionsButton>
      </WithTooltip>
    );
  }
  return (
    <Menu.Root side="top" align="end">
      <Menu.Trigger
        className={c.button}
        data-control="captions"
        aria-label={labels.captions}
        title={labels.captions}
      >
        <CaptionsIconFor c={c} />
      </Menu.Trigger>
      <Menu.Popup className={c.menu}>
        <Menu.Content>
          <Menu.RadioGroup
            value={captions.value}
            onValueChange={(v) => captions.setValue(String(v))}
            aria-label={labels.captions}
          >
            {captions.options.map((o) => (
              <Menu.RadioItem
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className={c.menuItem}
              >
                {o.label}
                <Menu.ItemIndicator>
                  <CheckIcon className={c.menuIndicator} />
                </Menu.ItemIndicator>
              </Menu.RadioItem>
            ))}
          </Menu.RadioGroup>
        </Menu.Content>
      </Menu.Popup>
    </Menu.Root>
  );
}

// SettingsMenu is the gear: the speed and, when the stream has renditions
// (HLS), the quality, each a page of the menu. It shows when it has one.
function SettingsMenu({rates, c}: {rates: readonly number[]; c: VideoPlayerClassNames}) {
  const {labels, locale} = usePlayerUi();
  const rate = usePlayer((s) => s.playbackRate);
  const store = usePlayer();
  const quality = useQualityOptions();
  const qualities = quality && !quality.hidden && quality.options.length >= 3 ? quality : null;
  if (rates.length === 0 && !qualities) return null;
  const format = (r: number) => `${new Intl.NumberFormat(locale).format(r)}×`;
  return (
    <Menu.Root side="top" align="end">
      <Menu.Trigger
        className={c.button}
        data-control="settings"
        aria-label={labels.settings}
        title={labels.settings}
      >
        <SettingsIcon className={c.icon} />
      </Menu.Trigger>
      <Menu.Popup className={c.menu}>
        <Menu.Content>
          {rates.length > 0 && (
            <Menu.Root>
              <Menu.Trigger className={c.menuItem} data-submenu="">
                <span>{labels.speed}</span>
                <span className={c.menuHint}>
                  {format(rate)}
                  <ChevronIcon className={c.menuChevron} />
                </span>
              </Menu.Trigger>
              <Menu.Content>
                <Menu.Item className={c.menuBack}>
                  <ChevronIcon className={c.menuChevron} back />
                  {labels.speed}
                </Menu.Item>
                <Menu.RadioGroup
                  value={String(rate)}
                  onValueChange={(v) => store.setPlaybackRate(Number(v))}
                  aria-label={labels.speed}
                >
                  {rates.map((r) => (
                    <Menu.RadioItem key={r} value={String(r)} className={c.menuItem}>
                      {format(r)}
                      <Menu.ItemIndicator>
                        <CheckIcon className={c.menuIndicator} />
                      </Menu.ItemIndicator>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.Content>
            </Menu.Root>
          )}
          {qualities && (
            <Menu.Root>
              <Menu.Trigger className={c.menuItem} data-submenu="">
                <span>{labels.quality}</span>
                <span className={c.menuHint}>
                  {qualities.selectedLabel}
                  <ChevronIcon className={c.menuChevron} />
                </span>
              </Menu.Trigger>
              <Menu.Content>
                <Menu.Item className={c.menuBack}>
                  <ChevronIcon className={c.menuChevron} back />
                  {labels.quality}
                </Menu.Item>
                <Menu.RadioGroup
                  value={qualities.value}
                  onValueChange={(v) => qualities.setValue(String(v))}
                  aria-label={labels.quality}
                >
                  {qualities.options.map((o) => (
                    <Menu.RadioItem
                      key={o.value}
                      value={o.value}
                      disabled={o.disabled}
                      className={c.menuItem}
                    >
                      {o.label}
                      <Menu.ItemIndicator>
                        <CheckIcon className={c.menuIndicator} />
                      </Menu.ItemIndicator>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.Content>
            </Menu.Root>
          )}
        </Menu.Content>
      </Menu.Popup>
    </Menu.Root>
  );
}

function WithTooltip({children, c}: {children: ReactElement; c: VideoPlayerClassNames}) {
  return (
    <Tooltip.Root side="top">
      <Tooltip.Trigger render={children} />
      <Tooltip.Popup className={c.tooltip}>
        <Tooltip.Label />
        <Tooltip.Shortcut className={c.tooltipShortcut} />
      </Tooltip.Popup>
    </Tooltip.Root>
  );
}

// PlayerKeys binds keys and gestures only for what the config shows: no
// seek keys without a seek bar, no speed keys (the config owns the rates).
function PlayerKeys({config}: {config: PlayerConfig}) {
  const keys = config.keyboardShortcuts;
  const seek = config.seekBar;
  return (
    <>
      <Hotkey disabled={!keys} keys="Space" action="togglePaused" />
      <Hotkey disabled={!keys} keys="k" action="togglePaused" />
      <Hotkey disabled={!keys || !seek} keys="ArrowRight" action="seekStep" />
      <Hotkey disabled={!keys || !seek} keys="ArrowLeft" action="seekStep" />
      <Hotkey disabled={!keys || !seek} keys="l" action="seekStep" />
      <Hotkey disabled={!keys || !seek} keys="j" action="seekStep" />
      <Hotkey disabled={!keys || !seek} keys="0-9" action="seekToPercent" />
      <Hotkey disabled={!keys || !seek} keys="Home" action="seekToPercent" value={0} />
      <Hotkey disabled={!keys || !seek} keys="End" action="seekToPercent" value={100} />
      <Hotkey disabled={!keys || !config.volumeControl} keys="m" action="toggleMuted" />
      <Hotkey disabled={!keys || !config.volumeControl} keys="ArrowUp" action="volumeStep" />
      <Hotkey disabled={!keys || !config.volumeControl} keys="ArrowDown" action="volumeStep" />
      <Hotkey disabled={!keys || !config.captionsControl} keys="c" action="toggleSubtitles" />
      <Hotkey disabled={!keys || !config.fullscreenButton} keys="f" action="toggleFullscreen" />
      <Hotkey disabled={!keys || !config.pipButton} keys="i" action="togglePictureInPicture" />
      <Gesture type="tap" action="togglePaused" pointer="mouse" region="center" />
      <Gesture type="tap" action="toggleControls" pointer="touch" />
      <Gesture disabled={!seek} type="doubletap" action="seekStep" region="left" />
      <Gesture disabled={!seek} type="doubletap" action="seekStep" region="right" />
      <Gesture
        disabled={!config.fullscreenButton}
        type="doubletap"
        action="toggleFullscreen"
        region="center"
      />
    </>
  );
}
