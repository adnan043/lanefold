import {useMedia} from '@videojs/react';
import {usePlayer} from '@videojs/react/video';
import {useEffect, useId, useRef, useState, type RefObject} from 'react';

import {useEffectEvent} from './use-effect-event';

import type {VideoChapter} from './interactions';
import {listen} from './media-watch';
import {ChevronIcon, CloseIcon, LockIcon} from './player-icons';
import {usePlayerUi, type VideoPlayerClassNames} from './player-ui';
import {seekFrameStyle, type SeekPreview} from './seek-preview';

// The key moments (YouTube's chapter list) over the video: the chapter
// button after the time names the playing chapter ("Second example 3/4 ›")
// and opens a panel listing every chapter with its frame and start. A row
// seeks to its chapter and the panel stays open; the playing one is marked
// (aria-current, data-current) as the video plays. X, Escape or the button
// again close it. No styles: each part takes its slot's class.

// chapterIndex is the place (0-based) of the chapter playing at second t in
// chapters sorted by start; -1 before the first or with none.
export function chapterIndex(chapters: readonly VideoChapter[], t: number): number {
  let at = -1;
  for (let i = 0; i < chapters.length; i++) {
    if ((chapters[i]?.start ?? Infinity) <= t) at = i;
    else break;
  }
  return at;
}

// sortedChapters is chapters by start (the server sends them so; a page's own may not).
export function sortedChapters(chapters: readonly VideoChapter[]): VideoChapter[] {
  return [...chapters].sort((a, b) => a.start - b.start);
}

// clock is a time as the control bar shows it: 0:41, 12:05, 1:02:09.
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// A chapter starting this far past the furthest point played is locked
// when seeking ahead is off (the player pulls such a seek back).
const LOCK_SLACK = 0.25;

// A row's frame box is THUMB_WIDTH × 9/16 px (CSS may scale it); a frame
// of another shape (a portrait video's) fits inside it.
const THUMB_WIDTH = 88;

// thumbWidth is the frame's shown width so it fits the 16:9 box.
export function thumbWidth(p: SeekPreview): number {
  const fit = ((THUMB_WIDTH * 9) / 16) * (p.frameWidth / p.frameHeight);
  return Math.round(Math.min(THUMB_WIDTH, fit) * 100) / 100;
}

// ChapterButton is the playing chapter's title and place after the time;
// it renders again only when the chapter changes.
export function ChapterButton({
  chapters,
  open,
  panelId,
  buttonRef,
  onToggle,
  c,
}: {
  chapters: readonly VideoChapter[];
  open: boolean;
  panelId: string;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  c: VideoPlayerClassNames;
}) {
  const {labels} = usePlayerUi();
  const i = usePlayer((s) => chapterIndex(chapters, s.currentTime ?? 0));
  const title = chapters[i]?.title;
  if (title === undefined) return null;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={c.chapterButton}
      data-control="chapters"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-label={labels.chapterButton(title, i + 1, chapters.length)}
      onClick={onToggle}
    >
      <span className={c.timeChapter} data-chapter="">
        {title}
      </span>
      <span className={c.chapterCount} aria-hidden="true">
        {i + 1}/{chapters.length}
      </span>
      <ChevronIcon className={c.icon} />
    </button>
  );
}

export function ChaptersPanel({
  id,
  chapters,
  preview,
  allowSeekAhead,
  furthestWatched,
  onClose,
  c,
}: {
  id: string;
  chapters: readonly VideoChapter[];
  preview?: SeekPreview;
  allowSeekAhead: boolean;
  furthestWatched: number;
  onClose: () => void;
  c: VideoPlayerClassNames;
}) {
  const {labels} = usePlayerUi();
  const player = usePlayer();
  const current = usePlayer((s) => chapterIndex(chapters, s.currentTime ?? 0));
  const furthest = useFurthest(furthestWatched, !allowSeekAhead);
  const titleId = useId();
  const listRef = useRef<HTMLOListElement>(null);

  // Open: focus the chapter playing then (else the first).
  const [openedAt] = useState(current);
  useEffect(() => {
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>('button');
    rows?.[Math.max(openedAt, 0)]?.focus({preventScroll: true});
  }, [openedAt]);

  // The playing row stays in view as the video plays.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[current] as HTMLElement | undefined;
    if (!list || !row) return;
    const top = row.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, top - 8);
    }
  }, [current]);

  // Keys and pointers on the panel stay its own: native listeners, since
  // the player's keys and gestures listen on its root (a tap there pauses,
  // space plays, arrows seek).
  const panelRef = useRef<HTMLDialogElement>(null);
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const move: Record<string, number> = {
      ArrowDown: at + 1,
      ArrowUp: at - 1,
      Home: 0,
      End: rows.length - 1,
    };
    const next = move[e.key];
    if (next !== undefined && (at >= 0 || e.key === 'Home' || e.key === 'End')) {
      e.preventDefault();
      rows[Math.min(rows.length - 1, Math.max(0, next))]?.focus();
    }
    e.stopPropagation();
  });
  // Where the player ends on screen (--player-bottom on the panel, px), for a
  // theme that shows the panel as a sheet under the video on small screens.
  useEffect(() => {
    const el = panelRef.current;
    const root = el?.parentElement;
    if (!el || !root) return;
    const place = () =>
      el.style.setProperty(
        '--player-bottom',
        `${Math.round(root.getBoundingClientRect().bottom)}px`,
      );
    place();
    const watch = new ResizeObserver(place);
    watch.observe(root);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, {capture: true, passive: true});
    return () => {
      watch.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, {capture: true});
    };
  }, []);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    // Pointer events only: the player's gestures listen to them; click must
    // still reach React's root for the rows and the close button.
    const kinds = ['pointerdown', 'pointerup'];
    for (const k of kinds) el.addEventListener(k, stop);
    el.addEventListener('keydown', onKey);
    return () => {
      for (const k of kinds) el.removeEventListener(k, stop);
      el.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    // A non-modal dialog over the video (open, never showModal): the page
    // and the player stay usable beside it.
    <dialog
      ref={panelRef}
      open
      id={id}
      aria-labelledby={titleId}
      className={c.chaptersPanel}
      data-chapters-panel=""
    >
      <div className={c.chaptersHeader}>
        <h2 id={titleId} className={c.chaptersTitle}>
          {labels.keyMoments}
        </h2>
        <span className={c.chaptersCount}>{labels.keyMomentsCount(chapters.length)}</span>
        <button
          type="button"
          className={c.chaptersClose}
          data-control="close-chapters"
          aria-label={labels.closeKeyMoments}
          onClick={onClose}
        >
          <CloseIcon className={c.icon} />
        </button>
      </div>
      <ol ref={listRef} className={c.chaptersList}>
        {chapters.map((ch, i) => {
          const locked = !allowSeekAhead && ch.start > furthest + LOCK_SLACK;
          return (
            <li key={`${ch.start}:${i}`}>
              <button
                type="button"
                className={c.chapterItem}
                data-current={i === current ? '' : undefined}
                data-locked={locked ? '' : undefined}
                data-chapter-locked={locked ? '' : undefined}
                aria-current={i === current ? 'true' : undefined}
                aria-label={labels.chapterItem(ch.title, clock(ch.start), locked)}
                onClick={() => {
                  // Locked: the furthest point played instead (the player would pull it back there).
                  void player.seek(locked ? furthest : ch.start);
                }}
              >
                <span
                  className={c.chapterFrame}
                  data-empty={preview ? undefined : ''}
                  aria-hidden="true"
                >
                  {preview ? (
                    <span style={seekFrameStyle(preview, ch.start, thumbWidth(preview))} />
                  ) : (
                    i + 1
                  )}
                </span>
                <span className={c.chapterText}>
                  <span className={c.chapterTitle}>{ch.title}</span>
                  <span className={c.chapterTime}>
                    {clock(ch.start)}
                    {locked && <LockIcon className={c.icon} />}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </dialog>
  );
}

// useFurthest is the furthest second played (from furthestWatched on),
// followed only while seeking ahead is blocked: normal play moves it, a
// seek doesn't.
function useFurthest(start: number, follow: boolean): number {
  const media = useMedia();
  const [furthest, setFurthest] = useState(start);
  const read = useEffectEvent(() => {
    const m = media as unknown as {currentTime?: number; seeking?: boolean} | null;
    const t = m?.currentTime ?? 0;
    if (!m?.seeking && t > furthest && t - furthest < 2) setFurthest(t);
  });
  useEffect(() => {
    if (!media || !follow) return;
    return listen(media, 'timeupdate', read);
  }, [media, follow]);
  return Math.max(furthest, start);
}

// usePanelState is the panel's open state and the button that opened it
// (focus goes back there on close).
export function usePanelState() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus({preventScroll: true});
  };
  return {open, id, buttonRef, toggle: () => (open ? close() : setOpen(true)), close};
}
