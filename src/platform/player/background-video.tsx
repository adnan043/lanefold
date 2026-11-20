import {PauseIcon, PlayIcon} from '@videojs/react/icons';
import {lazy, type ReactNode, Suspense, useState, useSyncExternalStore} from 'react';

import {englishLabels, type VideoPlayerLabels} from './labels';
import {cx, type VideoPlayerClassNames} from './player-ui';
import {useHydrated} from './video-player';

const Media = lazy(() =>
  import('./background-video-media').then((x) => ({default: x.BackgroundVideoMedia})),
);

export type BackgroundVideoProps = {
  src: string; // a file (MP4, WebM) or an HLS manifest; unencrypted
  type?: string;
  poster?: string; // shown before the video plays and while motion is off
  labels?: Partial<Pick<VideoPlayerLabels, 'backgroundPlay' | 'backgroundPause'>>;
  // Slots: background (the section), backgroundPoster, backgroundMedia (the
  // layer behind the content), backgroundToggle and icon.
  classNames?: VideoPlayerClassNames;
  className?: string;
  children?: ReactNode; // the content shown over the video
};

// BackgroundVideo plays a decorative, muted, looping video behind its
// children. It follows prefers-reduced-motion and has a pause button, since
// moving content must be stoppable (WCAG 2.2.2).
export function BackgroundVideo({
  src,
  type,
  poster,
  labels,
  classNames: c = {},
  className,
  children,
}: BackgroundVideoProps) {
  const reduced = useReducedMotion();
  const hydrated = useHydrated();
  const [stopped, setStopped] = useState(false);
  const playing = hydrated && !reduced && !stopped;
  const text = {...englishLabels, ...labels};
  return (
    <section className={cx(c.background, className)}>
      <div aria-hidden="true" className={c.backgroundMedia}>
        {poster && <img src={poster} alt="" className={c.backgroundPoster} />}
        {playing && (
          <Suspense>
            <Media src={src} type={type} className={c.backgroundPoster} />
          </Suspense>
        )}
      </div>
      {children}
      {!reduced && (
        <button
          type="button"
          data-paused={stopped ? '' : undefined}
          className={c.backgroundToggle}
          aria-label={stopped ? text.backgroundPlay : text.backgroundPause}
          onClick={() => setStopped(!stopped)}
        >
          {stopped ? <PlayIcon className={c.icon} /> : <PauseIcon className={c.icon} />}
        </button>
      )}
    </section>
  );
}

const reducedMotion = '(prefers-reduced-motion: reduce)';

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = matchMedia(reducedMotion);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => matchMedia(reducedMotion).matches,
    () => false,
  );
}
