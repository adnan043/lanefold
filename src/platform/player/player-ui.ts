import {createContext, useContext} from 'react';

import {englishLabels, type VideoPlayerLabels} from './labels';

// The components ship no styles. Every element takes a class from
// `classNames` by slot and shows its state in data attributes (Video.js's,
// such as data-paused and data-visible, and ours: data-control, data-type,
// data-look, data-layout, data-variant…), so any CSS can style them.
export type VideoPlayerSlot =
  // player
  | 'root'
  | 'poster'
  | 'posterImage'
  | 'buffering'
  | 'bufferingIcon'
  | 'errorBackdrop'
  | 'errorPopup'
  | 'errorTitle'
  | 'errorDescription'
  | 'errorClose'
  | 'controlsBackdrop'
  | 'controls'
  | 'controlBar'
  | 'button' // every icon button; data-control names it
  | 'icon'
  | 'spacer'
  | 'seek'
  | 'seekChapters'
  | 'seekChapter'
  | 'seekTrack'
  | 'seekBuffer'
  | 'seekFill'
  | 'seekMarks' // the dots' layer over the track (marks)
  | 'seekMark' // one mark's dot; left is its place
  | 'seekThumb'
  | 'seekPreview'
  | 'seekChapterTitle'
  | 'seekValue'
  | 'seekFrame' // the preview frame above the pointed time (seekPreview); its background is the sheet
  | 'volume'
  | 'volumeSlider'
  | 'volumeTrack'
  | 'volumeFill'
  | 'time'
  | 'timeCurrent'
  | 'timeSeparator'
  | 'timeDuration'
  | 'timeChapter' // the playing chapter's title after the time (with chapters)
  | 'chapterButton' // after the time: the playing chapter, its place and a chevron; opens the key moments (aria-expanded)
  | 'chapterCount' // "3/4" in the chapter button
  | 'chaptersPanel' // the key moments over the video (a dialog); --player-bottom is where the player ends on screen (px)
  | 'chaptersHeader'
  | 'chaptersTitle'
  | 'chaptersCount' // "4 in this video"
  | 'chaptersClose'
  | 'chaptersList'
  | 'chapterItem' // a chapter's row; data-current (playing), data-locked (past the furthest point, seeking ahead off)
  | 'chapterFrame' // its frame from the seek preview's sheet (background); data-empty without one (shows its number)
  | 'chapterText'
  | 'chapterTitle'
  | 'chapterTime'
  | 'menu'
  | 'menuItem'
  | 'menuIndicator'
  | 'menuHint' // a submenu row's value (1×, Auto) and chevron, at its end (data-submenu rows)
  | 'menuChevron'
  | 'menuBack' // a submenu page's first row: back to the settings
  | 'tooltip'
  | 'tooltipShortcut'
  // config overlays (player-overlays): the centre play button (data-shape), the
  // logo, the watermark (data-tiled, data-animation) and the end screen
  | 'bigPlay'
  | 'bigPlayIcon'
  | 'logo'
  | 'logoImage'
  | 'watermark'
  | 'watermarkText'
  | 'endScreen'
  | 'endScreenTitle'
  | 'endScreenText'
  | 'endScreenActions'
  | 'endScreenButton'
  | 'endScreenReplay'
  // interactions
  | 'interactions'
  | 'notice'
  | 'object' // data-type, data-look, data-animation, data-indicate
  | 'hotspotRing'
  | 'hotspotLabel'
  | 'image'
  | 'embedFrame'
  | 'panelBackdrop' // data-dim
  | 'panel' // data-type, data-layout, data-variant
  | 'panelTitle'
  | 'panelText'
  | 'answers' // data-layout
  | 'answer' // data-checked
  | 'answerInput'
  | 'answerDot'
  | 'feedback' // data-result
  | 'panelActions'
  | 'panelSkip'
  | 'panelSubmit'
  | 'field'
  | 'fieldLabel'
  | 'fieldInput'
  | 'fieldError'
  // background video
  | 'background'
  | 'backgroundMedia'
  | 'backgroundPoster'
  | 'backgroundToggle';

export type VideoPlayerClassNames = Partial<Record<VideoPlayerSlot, string>>;

export type PlayerUi = {
  classNames: VideoPlayerClassNames;
  labels: VideoPlayerLabels;
  locale: string;
};

export const PlayerUiContext = createContext<PlayerUi>({
  classNames: {},
  labels: englishLabels,
  locale: 'en',
});

export function usePlayerUi(): PlayerUi {
  return useContext(PlayerUiContext);
}

// cx joins class names, skipping empty ones.
export function cx(...parts: (string | false | null | undefined)[]): string | undefined {
  return parts.filter(Boolean).join(' ') || undefined;
}
