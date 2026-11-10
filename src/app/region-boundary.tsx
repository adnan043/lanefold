import {Component, type ReactNode} from 'react';

import {useT} from '../i18n';
import {Button, EmptyState} from '../portal/ui';
import {isChunkLoadError, safeErrorLabel} from './polish';

function RegionFallback({error, compact, onRetry, onClose}: {error: unknown; compact?: boolean; onRetry: () => void; onClose?: () => void}) {
  const t = useT();
  const stale = isChunkLoadError(error);
  return (
    <div className={compact ? 'lf-region-error lf-region-error-compact' : 'lf-region-error'} role="alert">
      <EmptyState
        icon={stale ? 'refresh' : 'alert'}
        title={stale ? t('shell.staleTitle') : t('polish.regionTitle')}
        action={
          <>
            <Button variant="secondary" icon="refresh" onClick={() => (stale ? window.location.reload() : onRetry())}>
              {stale ? t('common.reload') : t('common.retry')}
            </Button>
            {onClose && (
              <>
                {' '}
                <Button variant="ghost" onClick={onClose}>
                  {t('common.close')}
                </Button>
              </>
            )}
          </>
        }>
        {stale ? t('shell.staleBody') : t('polish.errorBody')}
      </EmptyState>
    </div>
  );
}

/**
 * A boundary around one region (board canvas, card panel, chat, settings) so a crash there leaves the rest of the
 * screen usable. Retry re-renders the region; `onClose` offers a way out for panels. Only the error kind is logged.
 */
export class RegionBoundary extends Component<
  {region: string; children: ReactNode; compact?: boolean; onClose?: () => void},
  {error: unknown; failed: boolean}
> {
  state = {error: null as unknown, failed: false};
  static getDerivedStateFromError(error: unknown) {
    return {error, failed: true};
  }
  componentDidCatch(error: Error) {
    console.error(`[app] ${this.props.region} failed: ${safeErrorLabel(error)}`);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <RegionFallback
        error={this.state.error}
        compact={this.props.compact}
        onClose={this.props.onClose}
        onRetry={() => this.setState({error: null, failed: false})}
      />
    );
  }
}
