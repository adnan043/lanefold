import {Component, type ErrorInfo, type ReactNode} from 'react';

import {useT} from '../i18n';
import {Button, buttonClass, EmptyState} from '../portal/ui';
import {isChunkLoadError, safeErrorLabel} from './polish';

/**
 * The last line of defence, above the router: a crash in the shell itself (or anything the route boundaries
 * did not catch) shows a plain message with Reload and a link out, never a blank page. It uses real links
 * (the router may be the thing that failed). Route screens have their own boundary (`RouteError`).
 */
function Fallback({error}: {error: unknown}) {
  const t = useT();
  const stale = isChunkLoadError(error);
  return (
    <div className="app-page" role="alert">
      <EmptyState
        icon={stale ? 'refresh' : 'alert'}
        title={stale ? t('shell.staleTitle') : t('polish.fatalTitle')}
        action={
          <>
            <Button variant="secondary" icon="refresh" onClick={() => window.location.reload()}>
              {t('common.reload')}
            </Button>{' '}
            <a className={buttonClass({variant: 'ghost'})} href="/app/boards">
              {t('boards.backToBoards')}
            </a>
          </>
        }>
        {stale ? t('shell.staleBody') : t('polish.fatalBody')}
      </EmptyState>
    </div>
  );
}

export class AppErrorBoundary extends Component<{children: ReactNode}, {error: unknown; failed: boolean}> {
  state = {error: null as unknown, failed: false};
  static getDerivedStateFromError(error: unknown) {
    return {error, failed: true};
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    // The kind only: a message can carry a card title, a name or an address.
    console.error(`[app] render failed: ${safeErrorLabel(error)}`);
  }
  render() {
    return this.state.failed ? <Fallback error={this.state.error} /> : this.props.children;
  }
}
