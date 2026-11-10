import {MutationCache, QueryCache, QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {createRouter, RouterProvider} from '@tanstack/react-router';
import {useEffect, useState} from 'react';

import {I18nProvider, useT} from '../i18n';
import {postJson} from '../lib/form';
import {siteFetch} from '../platform/browser';
import {ApiError} from './api';
import {OfflineBanner} from './offline-banner';
import {isSessionLost, retryDelay, shouldRetryQuery} from './resilience';
import {AppErrorBoundary} from './error-boundary';
import {applyStoredPrefs} from './settings/prefs';
import {RouteError, RoutePending, routeTree} from './routes';

/**
 * Lanefold, rendered ONLY in the browser (`client:only="react"`) by `src/pages/app/[...path].astro`, which
 * answers every `/app/*` URL. Same model as the dashboard: TanStack Query owns the data, the router preloads a
 * screen on hover, and a signed-out visitor is sent to sign in by the shell.
 */
applyStoredPrefs();

/** A 401 that survived the shared fetch's one refresh: re-check who is signed in, so the shell sends them to sign in (with the way back). */
let sessionCheck = 0;
function onFailed(error: unknown) {
  if (!(error instanceof ApiError) || !isSessionLost(error) || Date.now() - sessionCheck < 5000) return;
  sessionCheck = Date.now();
  void queryClient.invalidateQueries({queryKey: ['me']});
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({onError: onFailed}),
  mutationCache: new MutationCache({onError: onFailed}),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // A network blip or a gateway error retries with backoff, bounded; never an answer the server meant (4xx). Writes never retry.
      retry: shouldRetryQuery,
      retryDelay: attempt => retryDelay(attempt),
    },
    mutations: {retry: false},
  },
});

const router = createRouter({
  routeTree,
  basepath: '/app',
  context: {queryClient},
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 300,
  defaultErrorComponent: RouteError,
});

/** The editor's one-click owner sign-in (`?owner_ticket=`), same as the dashboard's. */
function useOwnerTicket(): boolean {
  const [pending, setPending] = useState(() => new URLSearchParams(window.location.search).has('owner_ticket'));
  useEffect(() => {
    if (!pending) return;
    const params = new URLSearchParams(window.location.search);
    const ticket = params.get('owner_ticket') ?? '';
    params.delete('owner_ticket');
    const rest = params.toString();
    const here = window.location.pathname + (rest ? `?${rest}` : '');
    window.history.replaceState(null, '', here + window.location.hash);
    void postJson(siteFetch, '/site-api/auth/owner', {ticket, next: here}).then(({res, data}) => {
      if (res?.status === 202 && data?.twoFactor === true && typeof data.challenge === 'string') {
        window.location.replace(`/account/login/?${new URLSearchParams({mfa: data.challenge, next: here}).toString()}`);
        return;
      }
      if (!res?.ok) {
        window.location.replace(`/account/login/?${new URLSearchParams({notice: 'owner-link', next: here}).toString()}`);
        return;
      }
      void queryClient.invalidateQueries();
      setPending(false);
    });
  }, [pending]);
  return pending;
}

function SigningIn() {
  const t = useT();
  return (
    <p className="app-signing-in" role="status">
      {t('shell.signingIn')}
    </p>
  );
}

export default function AppRoot() {
  const signingIn = useOwnerTicket();
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider settings={{}}>
        <AppErrorBoundary>
          <OfflineBanner />
          {signingIn ? <SigningIn /> : <RouterProvider router={router} />}
        </AppErrorBoundary>
      </I18nProvider>
    </QueryClientProvider>
  );
}
