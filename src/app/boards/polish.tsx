import {useEffect} from 'react';
import {createPortal} from 'react-dom';

import {useT} from '../../i18n';
import {Button, IconButton, useOverlayHost} from '../../portal/ui';
import type {Failure} from './actions';

/** Two card-shaped placeholders for a lane whose cards are still loading. */
export function CardSkeletons({label}: {label: string}) {
  return (
    <div className="lf-skel-cards" role="status">
      <span className="sr-only">{label}</span>
      {[0, 1].map(i => (
        <span key={i} className="lf-skel-card skeleton" aria-hidden="true" />
      ))}
    </div>
  );
}

/** The board while it loads: lane-shaped columns with card blocks, not a generic text loader. */
export function BoardSkeleton() {
  const t = useT();
  const cards = [3, 4, 2];
  return (
    <div className="lf-board" role="status">
      <span className="sr-only">{t('common.loading')}</span>
      <div className="lf-lanes lf-skel-lanes" aria-hidden="true">
        {cards.map((count, lane) => (
          <div key={lane} className="lf-lane lf-skel-lane">
            <span className="skeleton skeleton-third lf-skel-title" />
            {Array.from({length: count}, (_, i) => (
              <span key={i} className="lf-skel-card skeleton" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A save the screen already showed has failed and was put back: say why and offer Retry. It stays until
 * dismissed or retried (an alert, so it is read at once), unlike the timed toast.
 */
export function FailureBar({failure, onDone}: {failure: Failure | null; onDone: () => void}) {
  const t = useT();
  useEffect(() => {
    if (!failure) return;
    const onKey = (event: KeyboardEvent) => {
      // Already handled (a menu, a dialog) or a modal is on screen: that Esc is not ours.
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      onDone();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [failure, onDone]);
  const host = useOverlayHost();
  const bar = (
    <div className="lf-failure-region" role="alert">
      {failure && (
        <div className="lf-failure">
          <span>{failure.message}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onDone();
              failure.retry();
            }}>
            {t('common.retry')}
          </Button>
          <IconButton icon="x" size="sm" label={t('common.close')} onClick={onDone} />
        </div>
      )}
    </div>
  );
  // Inside the open card modal the body is hidden (top layer) and inert: show the bar in the modal then.
  return host ? createPortal(bar, host) : bar;
}
