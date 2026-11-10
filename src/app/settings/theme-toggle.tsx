import {useSyncExternalStore} from 'react';

import {useT} from '../../i18n';
import {IconButton} from '../../portal/ui';
import {applyTheme, type ThemeMode} from './prefs';
import {useSavePreferences} from './sync';

/**
 * The theme the page is showing right now: an explicit `data-theme` on <html>, else the device setting.
 * (High contrast is a light theme.)
 */
export function shownTheme(dataTheme: string | undefined, deviceDark: boolean): 'light' | 'dark' {
  if (dataTheme === 'dark') return 'dark';
  if (dataTheme === 'light' || dataTheme === 'contrast') return 'light';
  return deviceDark ? 'dark' : 'light';
}

const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null);

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  const media = query();
  media?.addEventListener('change', onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener('change', onChange);
  };
}

const snapshot = () => shownTheme(document.documentElement.dataset.theme, query()?.matches ?? false);

/** One click between light and dark from the top bar (the full list, accents and the rest stay in Settings). */
export function ThemeToggle() {
  const t = useT();
  const save = useSavePreferences();
  const shown = useSyncExternalStore(subscribe, snapshot, () => 'light' as const);
  const next: ThemeMode = shown === 'dark' ? 'light' : 'dark';
  return (
    <IconButton
      className="lf-theme-toggle"
      icon={shown === 'dark' ? 'sun' : 'moon'}
      label={shown === 'dark' ? t('shell.themeToLight') : t('shell.themeToDark')}
      onClick={() => {
        applyTheme(next);
        void save({themeMode: next});
      }}
    />
  );
}
