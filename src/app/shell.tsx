import {useQuery} from '@tanstack/react-query';
import {Outlet, useMatches, useRouterState} from '@tanstack/react-router';
import {Link, useNavigate} from './nav';
import {useEffect, useMemo, useRef, useState} from 'react';

import {useI18n, useT, type MessageKey} from '../i18n';
import {logout} from '../platform/browser';
import {useMe, useSite} from '../portal/shared';
import {browserStorage, clearAllDrafts} from './draft-store';
import {Avatar, ConfirmProvider, EmptyState, Icon, type IconName, IconButton, initials, Menu, type MenuItem, ToastProvider, UiLabels, buttonClass, useToast} from '../portal/ui';
import {lazyWithRetry} from './lazy';
import {ArchivedCardsDrawer} from './boards/archive-panel';
import {SIDEBAR_VIEWS, useBoardView, VIEW_ICONS} from './boards/views/view-switcher';
import {PlanLimitWatcher} from './plan-limits';
import {PreferencesSync} from './settings/sync';
import {ThemeToggle} from './settings/theme-toggle';
import {Kbd, Shortcuts} from './shortcuts';
import {totalUnread, usePulse} from './chat/api';
import {NotificationBell} from './notifications/bell';
import {TitleSetter, useWorkspace, WorkspaceProvider} from './workspace';
import {guestBoardsQuery} from './queries';

// Heavy, rarely used: loaded on first open, on hover/focus of the search button, or when the browser is idle.
// A failed chunk never reaches the router's error screen (`lazy.ts`): the widget just does not open.
const paletteWidget = lazyWithRetry(() => import('./palette/palette').then(m => m.AppPalette));
const shortcutsWidget = lazyWithRetry(() => import('./shortcuts-dialog').then(m => m.ShortcutsDialog));
const AppPalette = paletteWidget.Component;
const ShortcutsDialog = shortcutsWidget.Component;
const loadPalette = paletteWidget.preload;
const loadShortcutsDialog = shortcutsWidget.preload;

type NavItem = {to: string; label: MessageKey; dock: MessageKey; icon: IconName; sidebarOnly?: boolean};

/** The product's four homes (vocabulary: SPEC §1). Chat and the others arrive with their phases. */
const NAV: NavItem[] = [
  {to: '/my-day', label: 'nav.myDay', dock: 'dock.myDay', icon: 'calendar'},
  {to: '/inbox', label: 'nav.inbox', dock: 'dock.inbox', icon: 'inbox'},
  {to: '/boards', label: 'nav.boards', dock: 'dock.boards', icon: 'layout-kanban'},
  {to: '/chat', label: 'nav.chat', dock: 'dock.chat', icon: 'message'},
  {to: '/members', label: 'nav.members', dock: 'nav.members', icon: 'users', sidebarOnly: true},
];

/** The open board's Dashboard and Workload views, in the sidebar; pressing the active one goes back to the board. */
function BoardViewLinks({boardId}: {boardId: number}) {
  const t = useT();
  const [view, setView] = useBoardView(useMe().data?.viewer.id ?? null, boardId);
  return (
    <>
      {SIDEBAR_VIEWS.map(v => (
        <button key={v} type="button" className="app-nav-link" aria-pressed={view === v} onClick={() => setView(view === v ? 'board' : v)}>
          <Icon name={VIEW_ICONS[v]} size={18} />
          <span className="app-nav-text">{t(`views.${v}` as 'views.board')}</span>
        </button>
      ))}
    </>
  );
}

function useScreenTitleKey(): MessageKey | undefined {
  const matches = useMatches();
  return [...matches].reverse().find(match => match.staticData.title)?.staticData.title as MessageKey | undefined;
}

/** The tab title follows the screen; after each navigation (never the first load) focus moves to the `<h1>`. */
function useNavigationFocus(title: string, siteName: string | undefined) {
  const heading = useRef<HTMLHeadingElement>(null);
  const resolved = useRouterState({select: s => s.resolvedLocation?.pathname});
  const first = useRef(true);
  // The card panel manages its own focus (open and close): skip the `<h1>` when entering or leaving it.
  const matches = useMatches();
  const panel = matches.some(match => match.staticData.keepFocus);
  const boardMatch = matches.find(match => (match.routeId as string) === '/b/$boardId');
  const onBoard = boardMatch !== undefined;
  const boardKey = boardMatch ? String((boardMatch.params as {boardId?: string}).boardId ?? '') : '';
  const wasPanel = useRef(panel);
  const lastBoard = useRef(boardKey);
  useEffect(() => {
    document.title = siteName ? `${title} · ${siteName}` : title;
  }, [title, siteName]);
  useEffect(() => {
    if (!resolved) return;
    if (first.current) {
      first.current = false;
      return;
    }
    // Card to the same board: the panel restores focus. Card to a different board: the old opener is gone, use the `<h1>`.
    const skip = panel || (wasPanel.current && onBoard && lastBoard.current === boardKey);
    wasPanel.current = panel;
    lastBoard.current = boardKey;
    if (skip) return;
    heading.current?.focus({preventScroll: true});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);
  return {heading, resolved};
}

function WorkspaceSwitcher() {
  const t = useT();
  const navigate = useNavigate();
  const {workspaces, current, setCurrentId} = useWorkspace();
  if (!current) return null;
  const items: MenuItem[] = [
    ...(workspaces ?? []).map(w => ({
      label: w.name,
      icon: (w.id === current.id ? 'check' : 'layers') as IconName,
      onSelect: () => {
        setCurrentId(w.id);
        void navigate({to: '/boards'});
      },
    })),
    'separator',
    {label: t('workspace.new'), icon: 'plus', onSelect: () => void navigate({to: '/onboarding'})},
  ];
  return (
    <div className="lf-switcher">
      <Menu
        label={t('workspace.switcherLabel')}
        align="start"
        trigger={
          <>
            <span className="lf-switcher-mark" aria-hidden="true">
              {initials(current.name) || '·'}
            </span>
            <span className="lf-switcher-name" title={current.name}><bdi>{current.name}</bdi></span>
            <Icon name="chevrons-up-down" size={16} />
          </>
        }
        items={items}
      />
    </div>
  );
}

/**
 * The Lanefold shell: sidebar (workspace switcher, Boards / My Day / Inbox / Chat), top bar (the screen's
 * `<h1>`, account menu), a bottom dock on phones, a drawer with a scrim for the sidebar. Toasts and
 * confirmations are mounted here. It reuses the dashboard's shell classes (`app.css`) plus `lf-*` (`app.css` here).
 */
export function Root() {
  const t = useT();
  // The kit's own words (close, dismiss, month arrows...) in the user's language; the portal keeps English defaults.
  const labels = useMemo(
    () => ({
      close: t('common.close'),
      dismiss: t('common.dismiss'),
      cancel: t('common.cancel'),
      loading: t('common.loading'),
      presetColours: t('ui.presetColours'),
      previousMonth: t('ui.previousMonth'),
      nextMonth: t('ui.nextMonth'),
      previousYear: t('ui.previousYear'),
      nextYear: t('ui.nextYear'),
      optional: t('common.optional'),
    }),
    [t]
  );
  return (
    <UiLabels labels={labels}>
      <ToastProvider dismissLabel={labels.dismiss}>
        <ConfirmProvider>
          <WorkspaceProvider>
            <Shell />
          </WorkspaceProvider>
        </ConfirmProvider>
      </ToastProvider>
    </UiLabels>
  );
}

function Shell() {
  const t = useT();
  const {locale, dir} = useI18n();
  const me = useMe();
  const site = useSite();
  const navigate = useNavigate();
  const {workspaces, pending, current} = useWorkspace();
  const unreadChat = totalUnread(usePulse(false).data, current?.id);
  const titleKey = useScreenTitleKey();
  const [override, setOverride] = useState<string | null>(null);
  const siteName = site.data?.site?.name;
  const title = override ?? (titleKey ? t(titleKey) : (siteName ?? ''));
  const {heading, resolved} = useNavigationFocus(title, siteName);
  const [open, setOpen] = useState(false);
  // Desktop rail: icons only until hovered/focused; the arrow pins it open (remembered in this browser).
  const [pinned, setPinned] = useState(() => {
    try {
      return window.localStorage.getItem('lf-rail-pinned') === '1';
    } catch {
      return false;
    }
  });
  // After the arrow collapses the rail the pointer is still over it: keep it closed until the pointer leaves.
  const [locked, setLocked] = useState(false);
  const togglePinned = () => {
    if (pinned) {
      setLocked(true);
      (document.activeElement as HTMLElement | null)?.blur();
    }
    setPinned(value => {
      try {
        window.localStorage.setItem('lf-rail-pinned', value ? '0' : '1');
      } catch {
        /* storage blocked: the choice just is not remembered */
      }
      return !value;
    });
  };
  const [signingOut, setSigningOut] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const routeMatches = useMatches();
  const boardParam = (routeMatches.find(m => (m.routeId as string) === '/b/$boardId')?.params as {boardId?: string} | undefined)?.boardId;
  const currentBoardId = boardParam ? Number(boardParam) : null;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const paletteMounted = useRef(false);
  const shortcutsMounted = useRef(false);
  const toast = useToast();
  const [paletteLoadedTick, setPaletteLoadedTick] = useState(0);
  const paletteLoading = paletteOpen && !paletteWidget.isLoaded();
  useEffect(() => {
    if (paletteOpen && !paletteWidget.isLoaded()) void paletteWidget.load().then(() => setPaletteLoadedTick(n => n + 1));
  }, [paletteOpen]);
  void paletteLoadedTick;
  if (paletteOpen) paletteMounted.current = true;
  if (shortcutsOpen) shortcutsMounted.current = true;
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 2500));
    const handle = idle(() => {
      void loadPalette();
      void loadShortcutsDialog();
    });
    return () => (window.cancelIdleCallback ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
  }, []);
  const viewer = me.data?.viewer;
  const signedOut = viewer !== undefined && viewer.state !== 'user';

  useEffect(() => {
    if (!signedOut) return;
    const back = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
    window.location.replace(`/account/login/?next=${back}`);
  }, [signedOut]);
  useEffect(() => setOpen(false), [resolved]);
  // The page title override is NOT reset here on navigation: a child's effect runs before this one, so a board that
  // sets its name in the same commit as the route change would have it cleared at once (the title fell back to
  // "Board"). The screen that sets an override clears it itself when it unmounts (board-screen.tsx).
  useEffect(() => {
    if (!open) return;
    // The drawer is a modal-like layer on phones: move focus into it, and give it back to the menu button on Esc.
    const phone = window.matchMedia('(max-width: 960px)').matches;
    if (phone) document.querySelector<HTMLElement>('.app-sidebar .app-nav-link')?.focus({preventScroll: true});
    const onKey = (event: KeyboardEvent) => {
      // Already handled (a menu, a dialog) or a modal is on screen: that Esc is not ours.
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return;
      setOpen(false);
      if (phone) document.querySelector<HTMLElement>('.app-menu-button')?.focus({preventScroll: true});
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  // No workspace yet: the only thing to do is make one; unless the person is a guest on someone's board (they open
  // those from the board list), or is on a board or invite page right now.
  const noWorkspace = !pending && !!workspaces && workspaces.length === 0;
  const guestBoards = useQuery({...guestBoardsQuery, enabled: noWorkspace});
  useEffect(() => {
    if (!noWorkspace || !guestBoards.isSuccess || guestBoards.data.length > 0) return;
    if (!resolved?.endsWith('/onboarding') && !resolved?.includes('/join/') && !resolved?.includes('/b/')) {
      void navigate({to: '/onboarding'});
    }
  }, [noWorkspace, guestBoards.isSuccess, guestBoards.data, resolved, navigate]);
  if (signedOut) return null;

  const name = siteName || 'Lanefold';
  const logo = site.data?.site?.logo;
  // The site dashboard, only for people with an admin screen there (the same flags its nav uses).
  const can = me.data?.abilities;
  const admin = !!(can && (can.manageUsers || can.manageRoles || can.readAudit || can.manageBilling || can.managePlans || can.readWorkspaces));
  const accountItems: MenuItem[] = [
    {label: t('nav.settings'), icon: 'settings', onSelect: () => void navigate({to: '/settings/appearance'})},
    {label: t('shortcuts.menu'), icon: 'command', onSelect: () => setShortcutsOpen(true)},
    {label: t('account.yourAccount'), icon: 'user', onSelect: () => window.location.assign('/dashboard/account')},
    ...(admin ? [{label: t('account.dashboard'), icon: 'shield', onSelect: () => window.location.assign('/dashboard/')} satisfies MenuItem] : []),
    {label: t('account.backToWebsite'), icon: 'globe', onSelect: () => window.location.assign('/')},
    'separator',
    {
      label: t('account.signOut'),
      icon: 'log-out',
      onSelect: () => {
        setSigningOut(true);
        clearAllDrafts(browserStorage());
        void logout();
      },
    },
  ];

  return (
    <div className="app-shell" data-nav-open={open ? '' : undefined} data-rail={pinned ? 'pinned' : 'collapsed'} data-rail-lock={locked && !pinned ? '' : undefined} data-locale={locale} dir={dir}>
      <aside className="app-sidebar" data-locked={locked && !pinned ? '' : undefined} onMouseLeave={() => setLocked(false)} aria-label={t('shell.rail')}>
        <a className="app-brand" href="/">
          <span className="app-brand-mark">{logo ? <img src={logo} alt="" /> : <img className="app-brand-default" src="/logo.svg" alt="" />}</span>
          <span className="app-brand-name">{name}</span>
        </a>
        <button type="button" className="app-rail-toggle" aria-pressed={pinned} aria-label={pinned ? t('nav.collapseSidebar') : t('nav.expandSidebar')} title={pinned ? t('nav.collapseSidebar') : t('nav.expandSidebar')} onClick={togglePinned}>
          <Icon name={pinned ? 'chevrons-left' : 'chevrons-right'} size={16} />
        </button>
        <WorkspaceSwitcher />
        <nav
          className="app-nav"
          aria-label={t('nav.primary')}
          onClick={event => {
            // Collapsed rail: a mouse click on an item closes it again (the clicked link would otherwise keep focus and
            // hold it open through :focus-within). Keyboard activation (detail 0) keeps focus where it is.
            if (pinned || event.detail === 0 || !(event.target as HTMLElement).closest('.app-nav-link')) return;
            setLocked(true);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <div className="app-nav-group">
            <p className="app-nav-label">{t('nav.workspace')}</p>
            {NAV.map(item => (
              <Link key={item.to} to={item.to} className="app-nav-link" activeOptions={{exact: false}}>
                <Icon name={item.icon} size={18} />
                <span className="app-nav-text">{t(item.label)}</span>
                {item.to === '/chat' && unreadChat > 0 && <span className="chat-unread lf-nav-unread" aria-label={t('chat.unreadCount', {n: unreadChat})}>{unreadChat > 99 ? '99+' : unreadChat}</span>}
              </Link>
            ))}
            {currentBoardId !== null && Number.isInteger(currentBoardId) && <BoardViewLinks boardId={currentBoardId} />}
            {currentBoardId !== null && Number.isInteger(currentBoardId) && (
              <button type="button" className="app-nav-link" onClick={() => setArchiveOpen(true)}>
                <Icon name="archive" size={18} />
                <span className="app-nav-text">{t('bx.archive.cards')}</span>
              </button>
            )}
          </div>
        </nav>
      </aside>
      {currentBoardId !== null && Number.isInteger(currentBoardId) && <ArchivedCardsDrawer boardId={currentBoardId} open={archiveOpen} onClose={() => setArchiveOpen(false)} />}
      <button type="button" className="app-scrim" aria-label={t('nav.closeMenu')} tabIndex={-1} onClick={() => setOpen(false)} />

      <div className="app-main">
        <header className="app-topbar">
          <IconButton
            className="app-menu-button"
            icon={open ? 'x' : 'menu'}
            label={open ? t('nav.closeMenu') : t('nav.openMenu')}
            aria-expanded={open}
            onClick={() => setOpen(value => !value)}
          />
          <h1 className="app-title" ref={heading} tabIndex={-1}>
            {title}
          </h1>
          <div className="app-topbar-actions">
            <ThemeToggle />
            {viewer && <NotificationBell />}
            {paletteLoading && <span className="spinner" aria-hidden="true" />}
            <IconButton icon="search" label={`${t('shell.search')} (${t('shell.searchHint')})`} onPointerEnter={() => void loadPalette()} onFocus={() => void loadPalette()} onClick={() => setPaletteOpen(true)} />
            <span className="lf-kbd-hint" aria-hidden="true">
              <Kbd>/</Kbd>
            </span>
            {viewer && (
              <Menu
                label={t('account.menu', {name: viewer.name ?? t('account.you')})}
                trigger={
                  <>
                    {signingOut ? <span className="spinner" aria-hidden="true" /> : <Avatar name={viewer.name ?? ''} size="sm" />}
                    <span className="app-viewer-name"><bdi>{signingOut ? t('account.signingOut') : viewer.name}</bdi></span>
                    <span className="app-viewer-chevron" aria-hidden="true">
                      <Icon name="chevron-down" size={16} />
                    </span>
                  </>
                }
                disabled={signingOut}
                items={accountItems}
              />
            )}
          </div>
        </header>
        <main className="app-content app-content-wide lf-content" id="main">
          <TitleSetter value={setOverride}>
            <Outlet />
          </TitleSetter>
        </main>
        <nav className="lf-dock" aria-label={t('shell.dock')}>
          {NAV.filter(item => !item.sidebarOnly).map(item => (
            <Link key={item.to} to={item.to} className="lf-dock-link" activeOptions={{exact: false}}>
              <Icon name={item.icon} size={20} />
              <span>{t(item.dock)}</span>
              {item.to === '/chat' && unreadChat > 0 && <span className="lf-dock-dot" aria-label={t('chat.unreadCount', {n: unreadChat})} />}
            </Link>
          ))}
          <Link to="/settings/appearance" className="lf-dock-link" activeOptions={{exact: false}}>
            <Icon name="settings" size={20} />
            <span>{t('nav.settings')}</span>
          </Link>
        </nav>
      </div>
      <PreferencesSync />
      <Shortcuts open={shortcutsOpen} setOpen={setShortcutsOpen} openPalette={() => setPaletteOpen(true)} togglePalette={() => {
          // While the chunk loads a second press does nothing; never open over another dialog or menu.
          if (paletteLoading) return;
          if (!paletteOpen && document.querySelector('dialog[open], [role="dialog"], [role="menu"]')) return;
          setPaletteOpen(value => !value);
        }}
      />
      {paletteMounted.current && (
        <AppPalette
          open={paletteOpen}
          setOpen={setPaletteOpen}
          onLoadError={() => {
            setPaletteOpen(false);
            toast.danger(t('shell.loadFailed'));
          }}
        />
      )}
      {shortcutsMounted.current && (
        <ShortcutsDialog
          open={shortcutsOpen}
          setOpen={setShortcutsOpen}
          onLoadError={() => {
            setShortcutsOpen(false);
            toast.danger(t('shell.loadFailed'));
          }}
        />
      )}
      {paletteLoading && (
        <span className="visually-hidden" role="status">
          {t('common.loading')}
        </span>
      )}
      <PlanLimitWatcher />
    </div>
  );
}

export function NotFoundScreen() {
  const t = useT();
  return (
    <div className="app-page">
      <EmptyState
        icon="search"
        title={t('shell.notFoundTitle')}
        action={
          <Link className={buttonClass({variant: 'secondary'})} to="/boards">
            {t('boards.backToBoards')}
          </Link>
        }>
        {t('shell.notFoundBody')}
      </EmptyState>
    </div>
  );
}
