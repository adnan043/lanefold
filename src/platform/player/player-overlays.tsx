import {PlayButton, useMedia} from '@videojs/react';
import {usePlayer} from '@videojs/react/video';
import {useEffect, useRef, useState, type CSSProperties} from 'react';

import {useEffectEvent} from './use-effect-event';

import type {PlayerConfig, PlayerCorner, PlayerWatermark} from './player-config';
import {PlayIcon, ReplayIcon} from './player-icons';
import {usePlayerUi} from './player-ui';

// What fills a dynamic watermark's tokens: the signed-in learner and the
// school. Missing ones are left out.
export type WatermarkViewer = {
  name?: string;
  email?: string;
  userId?: string;
  school?: string;
};

// The overlays the config adds over the video: the centre play button, the
// logo, the watermark and the end screen. Positions, sizes and opacities
// are the config's, so they are inline; the look is the classNames'.

// BigPlay is the centre play button while paused (not after the end, where
// the end screen or the bar's replay shows).
export function BigPlay({config}: {config: PlayerConfig}) {
  const {classNames: c} = usePlayerUi();
  const paused = usePlayer((s) => s.paused);
  const ended = usePlayer((s) => s.ended);
  if (config.bigPlayButton === 'none' || !config.playButton || !paused || ended) return null;
  return (
    <PlayButton className={c.bigPlay} data-control="big-play" data-shape={config.bigPlayButton}>
      <PlayIcon className={c.bigPlayIcon} />
    </PlayButton>
  );
}

const cornerStyle = (corner: PlayerCorner, inset: string): CSSProperties => ({
  position: 'absolute',
  [corner.startsWith('top') ? 'top' : 'bottom']: inset,
  [corner.endsWith('left') ? 'left' : 'right']: inset,
});

// Logo is the school's logo in a corner, a link when it has one.
export function Logo({config}: {config: PlayerConfig}) {
  const {classNames: c} = usePlayerUi();
  const {logo} = config;
  if (!logo.enabled || !logo.url) return null;
  // Bottom corners sit above the control bar.
  const inset = logo.position.startsWith('bottom') ? '4.5rem' : '0.75rem';
  const style: CSSProperties = {
    ...cornerStyle(logo.position, inset),
    width: `${logo.size}%`,
    opacity: logo.opacity,
    zIndex: 15,
  };
  const img = <img src={logo.url} alt="" className={c.logoImage} draggable={false} />;
  return logo.link ? (
    <a href={logo.link} target="_blank" rel="noopener noreferrer" className={c.logo} style={style}>
      {img}
    </a>
  ) : (
    <span className={c.logo} style={{...style, pointerEvents: 'none'}}>
      {img}
    </span>
  );
}

// fillTokens puts the viewer's details in the watermark's text; tokens it
// has no value for go.
export function fillTokens(text: string, viewer: WatermarkViewer | undefined, now: Date): string {
  const values: Record<string, string | undefined> = {
    name: viewer?.name,
    email: viewer?.email,
    userId: viewer?.userId,
    school: viewer?.school,
    date: now.toISOString().slice(0, 10),
    time: now.toTimeString().slice(0, 5),
  };
  return text
    .replace(/\{(name|email|userId|date|time|school)\}/g, (_, k: string) => values[k] ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const anchors: Record<PlayerWatermark['position'], {x: number; y: number}> = {
  center: {x: 50, y: 50},
  'top-left': {x: 8, y: 8},
  'top-right': {x: 92, y: 8},
  'bottom-left': {x: 8, y: 80},
  'bottom-right': {x: 92, y: 80},
};

// Watermark is the text over the video: still, tiled, or moving (drift and
// bounce glide, jump and fade move every interval).
export function Watermark({config, viewer}: {config: PlayerConfig; viewer?: WatermarkViewer}) {
  const {classNames: c} = usePlayerUi();
  const w = config.watermark;
  const [now, setNow] = useState(() => new Date());
  // The time token stays current.
  useEffect(() => {
    if (!w.enabled || !w.text.includes('{time}')) return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [w.enabled, w.text]);
  const text = w.enabled ? fillTokens(w.text, viewer, now) : '';
  if (!text) return null;
  const base: CSSProperties = {
    position: 'absolute',
    pointerEvents: 'none',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    fontSize: w.fontSize,
    color: w.color ?? '#fff',
    opacity: w.opacity,
    zIndex: 21, // above the control bar: nothing hides it
  };
  if (w.tiled) {
    return (
      <div
        className={c.watermark}
        data-tiled=""
        aria-hidden="true"
        style={{...base, inset: 0, overflow: 'hidden', opacity: 1}}
      >
        <div
          style={{
            position: 'absolute',
            inset: '-50%',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(14em, 1fr))',
            gap: '3em 2em',
            alignContent: 'start',
            transform: 'rotate(-24deg)',
          }}
        >
          {Array.from({length: 60}, (_, i) => (
            <span key={i} className={c.watermarkText} style={{opacity: w.opacity}}>
              {text}
            </span>
          ))}
        </div>
      </div>
    );
  }
  return w.animation === 'none' ? (
    <span
      className={c.watermark}
      aria-hidden="true"
      style={{
        ...base,
        left: `${anchors[w.position].x}%`,
        top: `${anchors[w.position].y}%`,
        transform: `translate(${-anchors[w.position].x}%, ${-anchors[w.position].y}%)`,
      }}
    >
      <span className={c.watermarkText}>{text}</span>
    </span>
  ) : (
    <MovingWatermark watermark={w} text={text} base={base} />
  );
}

// MovingWatermark moves inside the video's box: its place is a % of the free
// room (0–100 on each axis), so it never leaves the frame.
function MovingWatermark({
  watermark: w,
  text,
  base,
}: {
  watermark: PlayerWatermark;
  text: string;
  base: CSSProperties;
}) {
  const {classNames: c} = usePlayerUi();
  const [place, setPlace] = useState(() => ({x: Math.random() * 100, y: Math.random() * 100}));
  const [shown, setShown] = useState(true);
  const ref = useRef<HTMLSpanElement>(null);

  // jump and fade: a new random place every interval (fade goes out first).
  useEffect(() => {
    if (w.animation !== 'jump' && w.animation !== 'fade') return;
    const ms = w.intervalSeconds * 1000;
    let hide: ReturnType<typeof setTimeout> | undefined;
    const id = setInterval(() => {
      if (w.animation === 'fade') {
        setShown(false);
        hide = setTimeout(() => {
          setPlace({x: Math.random() * 100, y: Math.random() * 100});
          setShown(true);
        }, 600);
      } else {
        setPlace({x: Math.random() * 100, y: Math.random() * 100});
      }
    }, ms);
    return () => {
      clearInterval(id);
      clearTimeout(hide);
    };
  }, [w.animation, w.intervalSeconds]);

  // drift and bounce: a frame loop writes the place to the element (no
  // re-render per frame). drift wraps around, bounce turns at the edges.
  useEffect(() => {
    if (w.animation !== 'drift' && w.animation !== 'bounce') return;
    const el = ref.current;
    if (!el) return;
    const speed = w.animation === 'drift' ? 4 : 9; // % of the room per second
    let x = Math.random() * 100;
    let y = Math.random() * 100;
    let dx = speed * (Math.random() > 0.5 ? 1 : -1);
    let dy = speed * 0.7 * (Math.random() > 0.5 ? 1 : -1);
    let last = performance.now();
    let frame = requestAnimationFrame(function step(t) {
      const s = Math.min((t - last) / 1000, 0.1);
      last = t;
      x += dx * s;
      y += dy * s;
      if (w.animation === 'bounce') {
        if (x < 0 || x > 100) dx = -dx;
        if (y < 0 || y > 100) dy = -dy;
        x = Math.max(0, Math.min(100, x));
        y = Math.max(0, Math.min(100, y));
      } else {
        x = (x + 100) % 100;
        y = (y + 100) % 100;
      }
      el.style.left = `${x}%`;
      el.style.top = `${y}%`;
      el.style.transform = `translate(${-x}%, ${-y}%)`;
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [w.animation]);

  return (
    <span
      ref={ref}
      className={c.watermark}
      data-animation={w.animation}
      aria-hidden="true"
      style={{
        ...base,
        left: `${place.x}%`,
        top: `${place.y}%`,
        transform: `translate(${-place.x}%, ${-place.y}%)`,
        opacity: shown ? w.opacity : 0,
        transition:
          w.animation === 'fade' ? 'opacity 0.6s' : w.animation === 'jump' ? 'none' : undefined,
      }}
    >
      <span className={c.watermarkText}>{text}</span>
    </span>
  );
}

// EndScreen shows over the video once it ends: a title, text, the school's
// button and Watch again.
export function EndScreen({config}: {config: PlayerConfig}) {
  const {classNames: c, labels} = usePlayerUi();
  const ended = usePlayer((s) => s.ended);
  const e = config.endScreen;
  if (!e.enabled || !ended || config.loop) return null;
  return (
    <section className={c.endScreen} aria-label={e.title || labels.watchAgain}>
      {e.title && <p className={c.endScreenTitle}>{e.title}</p>}
      {e.text && <p className={c.endScreenText}>{e.text}</p>}
      <div className={c.endScreenActions}>
        {e.buttonUrl && e.buttonLabel && (
          <a
            href={e.buttonUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={c.endScreenButton}
          >
            {e.buttonLabel}
          </a>
        )}
        {e.showReplay && (
          <PlayButton className={c.endScreenReplay} data-control="replay">
            <ReplayIcon className={c.icon} />
            {labels.watchAgain}
          </PlayButton>
        )}
      </div>
    </section>
  );
}

// screenshotKey: PrintScreen, and macOS's ⌘⇧3/4/5.
const screenshotKey = (e: KeyboardEvent) =>
  e.key === 'PrintScreen' || (e.metaKey && e.shiftKey && ['3', '4', '5'].includes(e.key));

// useProtection applies the config's protection to the player: it pauses
// when the page is left and reports when to blur (screenshot keys, for 3 s).
export function useProtection(config: PlayerConfig): {blurred: boolean} {
  const media = useMedia() as unknown as {pause?: () => void} | null;
  const {pauseWhenHidden, blurOnCapture} = config.protection;
  const [blurred, setBlurred] = useState(false);
  const pause = useEffectEvent(() => media?.pause?.());

  useEffect(() => {
    if (!pauseWhenHidden) return;
    const onHide = () => {
      if (document.hidden) pause();
    };
    const onBlur = () => pause();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('blur', onBlur);
    };
  }, [pauseWhenHidden]);

  useEffect(() => {
    if (!blurOnCapture) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!screenshotKey(e)) return;
      setBlurred(true);
      pause();
      clearTimeout(timer);
      timer = setTimeout(() => setBlurred(false), 3000);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      clearTimeout(timer);
    };
  }, [blurOnCapture]);

  return {blurred};
}
