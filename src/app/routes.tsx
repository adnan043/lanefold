import type {QueryClient} from '@tanstack/react-query';
import {RegionBoundary} from './region-boundary';
import {createRootRouteWithContext, createRoute, type ErrorComponentProps, lazyRouteComponent, useRouter} from '@tanstack/react-router';
import {Link, redirect} from './nav';
import {useEffect} from 'react';

import {useT} from '../i18n';
import {Button, buttonClass, EmptyState, LoadingBlock} from '../portal/ui';
import {isChunkLoadError, safeErrorLabel} from './polish';
import {todayISO} from '../portal/ui/date';
import {inboxQuery} from './inbox/queries';
import {myDayQuery} from './my-day/queries';
import {boardQuery, boardsQuery, workspacesQuery} from './queries';
import {NotFoundScreen, Root} from './shell';
import {remembered} from './workspace';

/**
 * Lanefold's screens: a TanStack Router app under `/app` (basepath), served by ONE host page
 * (`src/pages/app/[...path].astro`). Each route: a literal path, `staticData.title` (a message KEY: the shell
 * translates it for the top bar and the tab), a loader that warms its queries, the screen LAZY (its code,
 * and drag and drop for a board, loads on first use). Links inside the app are `<Link>`, never `<a href>`.
 */
const warm = (...reads: Promise<unknown>[]) => Promise.all(reads.map(read => read.catch(() => undefined))).then(() => undefined);

export function RoutePending() {
  return (
    <div className="app-page">
      <LoadingBlock rows={4} />
    </div>
  );
}

export function RouteError({error, reset}: ErrorComponentProps) {
  const t = useT();
  const router = useRouter();
  // A deploy replaced the code while the app was open: only a reload helps. Anything else: try the screen
  // again. The raw message is never shown (it can carry titles or names) and only the error kind is logged.
  const stale = isChunkLoadError(error);
  useEffect(() => {
    console.error(`[app] screen failed: ${safeErrorLabel(error)}`);
  }, [error]);
  return (
    <div className="app-page" role="alert">
      <EmptyState
        icon={stale ? 'refresh' : 'alert'}
        title={stale ? t('shell.staleTitle') : t('shell.errorTitle')}
        action={
          <>
            <Button
              variant="secondary"
              icon="refresh"
              onClick={() => {
                if (stale) window.location.reload();
                else {
                  reset();
                  void router.invalidate();
                }
              }}>
              {stale ? t('common.reload') : t('common.retry')}
            </Button>{' '}
            <Link className={buttonClass({variant: 'ghost'})} to="/boards">
              {t('boards.backToBoards')}
            </Link>
          </>
        }>
        {stale ? t('shell.staleBody') : t('polish.errorBody')}
      </EmptyState>
    </div>
  );
}

const rootRoute = createRootRouteWithContext<{queryClient: QueryClient}>()({
  component: Root,
  notFoundComponent: NotFoundScreen,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({to: '/boards', replace: true});
  },
});

const boardsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/boards',
  staticData: {title: 'nav.boards'},
  loader: async ({context: {queryClient}}) => {
    const workspaces = await queryClient.ensureQueryData(workspacesQuery).catch(() => null);
    const id = remembered() || workspaces?.[0]?.id;
    if (id) await warm(queryClient.ensureInfiniteQueryData(boardsQuery(id)));
  },
  component: lazyRouteComponent(() => import('./boards/board-list'), 'BoardList'),
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/b/$boardId',
  staticData: {title: 'nav.board'},
  loader: ({context: {queryClient}, params}) => warm(queryClient.ensureQueryData(boardQuery(Number(params.boardId)))),
  component: lazyRouteComponent(() => import('./boards/board-screen'), 'BoardScreen'),
});

/** The card slide-over: a child of the board, so the board stays mounted (and draggable) behind it. */
const cardRoute = createRoute({
  getParentRoute: () => boardRoute,
  path: '/c/$cardId',
  staticData: {title: 'nav.board', keepFocus: true},
  // Start the read, do not wait for it: the panel opens at once with its own loading state.
  loader: ({context: {queryClient}, params}) => {
    // use-card (upload + board-sync code) stays out of the entry chunk: it loads with the panel.
    void import('./cards/use-card').then(m => queryClient.prefetchQuery(m.cardDetailQuery(Number(params.cardId)))).catch(() => undefined);
  },
  component: lazyRouteComponent(() => import('./cards/card-panel'), 'CardPanel'),
});

const myDayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/my-day',
  staticData: {title: 'nav.myDay'},
  loader: ({context: {queryClient}}) => warm(queryClient.ensureQueryData(myDayQuery(todayISO()))),
  component: lazyRouteComponent(() => import('./my-day/my-day'), 'MyDay'),
});
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  staticData: {title: 'nav.inbox'},
  loader: async ({context: {queryClient}}) => {
    const workspaces = await queryClient.ensureQueryData(workspacesQuery).catch(() => null);
    const id = remembered() || workspaces?.[0]?.id;
    if (id) await warm(queryClient.ensureInfiniteQueryData(inboxQuery(id)));
  },
  component: lazyRouteComponent(() => import('./inbox/inbox'), 'Inbox'),
});
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/chat',
  staticData: {title: 'nav.chat'},
  validateSearch: (search: Record<string, unknown>): {c?: number} => {
    const c = Number(search.c);
    return Number.isSafeInteger(c) && c > 0 ? {c} : {};
  },
  component: lazyRouteComponent(() => import('./chat/chat-screen'), 'Chat'),
});
const membersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/members',
  staticData: {title: 'nav.members'},
  component: lazyRouteComponent(() => import('./members/members-screen'), 'Members'),
});
const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/join/$token',
  staticData: {title: 'nav.join'},
  component: lazyRouteComponent(() => import('./members/join-screen'), 'JoinWorkspace'),
});
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  staticData: {title: 'nav.onboarding'},
  component: lazyRouteComponent(() => import('./onboarding'), 'Onboarding'),
});

/** A route screen inside its own region boundary (keeps the lazy component's `preload`). */
function withRegion(region: string, Screen: any) {
  const Wrapped = () => (
    <RegionBoundary region={region}>
      <Screen />
    </RegionBoundary>
  );
  return Object.assign(Wrapped, {preload: Screen.preload});
}
const settingsRoute = (path: string, title: string, load: () => Promise<any>, name: string) =>
  createRoute({getParentRoute: () => rootRoute, path, staticData: {title}, component: withRegion('settings', lazyRouteComponent(load, name))});
const settingsAppearanceRoute = settingsRoute('/settings/appearance', 'nav.appearance', () => import('./settings/appearance'), 'Appearance');
const settingsLanguageRoute = settingsRoute('/settings/language', 'nav.language', () => import('./settings/language'), 'Language');
const settingsWorkspaceRoute = settingsRoute('/settings/workspace', 'nav.workspaceSettings', () => import('./settings/workspace'), 'WorkspaceSettings');
const settingsBillingRoute = settingsRoute('/settings/billing', 'nav.billing', () => import('./settings/billing'), 'Billing');
const settingsAuditRoute = settingsRoute('/settings/audit', 'audit.title', () => import('./settings/audit'), 'AuditLog');
const settingsImportExportRoute = settingsRoute('/settings/import-export', 'nav.importExport', () => import('./settings/import-export'), 'ImportExport');
const settingsNotificationsRoute = settingsRoute('/settings/notifications', 'notifEmail.title', () => import('./settings/notifications'), 'NotificationSettings');
const settingsAccountRoute = settingsRoute('/settings/account', 'nav.account', () => import('./settings/account'), 'Account');
const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => {
    throw redirect({to: '/settings/appearance', replace: true});
  },
});

export const routeTree = rootRoute.addChildren([indexRoute, boardsRoute, boardRoute.addChildren([cardRoute]), myDayRoute, inboxRoute, chatRoute, membersRoute, joinRoute, onboardingRoute, settingsIndexRoute, settingsAppearanceRoute, settingsLanguageRoute, settingsWorkspaceRoute, settingsBillingRoute, settingsAuditRoute, settingsImportExportRoute, settingsNotificationsRoute, settingsAccountRoute]);
