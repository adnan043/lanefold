import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useRef} from 'react';

import {isLocale, useI18n} from '../../i18n';
import {call} from '../api';
import {
  applyDensity,
  applyFontScale,
  applyRadius,
  applyReduceMotion,
  applyTheme,
  type Density,
  type FontScale,
  isDensity,
  isFontScale,
  isRadius,
  isThemeMode,
  type Radius,
  type ThemeMode,
} from './prefs';

/** The signed-in person's saved preferences (`GET /preferences`; the server answers defaults when none). */
export type Preferences = {
  locale: string;
  themeMode: ThemeMode;
  density: Density;
  /** Percent as a string key of FONT_SCALES on this side; the server stores the number. */
  fontScale?: number;
  radius?: Radius;
  reduceMotion?: boolean;
};
export type PreferencesPatch = Partial<Preferences>;

type PrefKey = keyof Preferences;
const UNSAVED_KEY = 'lf:prefs-unsaved';
/** Keys the person changed in this tab since it loaded: a late profile answer must not overwrite them. */
const changedSinceLoad = new Set<PrefKey>();

/** Keys whose last save failed (offline, refused): this browser stays the source of truth until a save works. */
function readUnsaved(): Set<PrefKey> {
  try {
    const raw = JSON.parse(localStorage.getItem(UNSAVED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? (raw.filter(k => ['locale', 'themeMode', 'density', 'fontScale', 'radius', 'reduceMotion'].includes(k as string)) as PrefKey[]) : []);
  } catch {
    return new Set();
  }
}
function writeUnsaved(keys: Set<PrefKey>) {
  try {
    if (keys.size) localStorage.setItem(UNSAVED_KEY, JSON.stringify([...keys]));
    else localStorage.removeItem(UNSAVED_KEY);
  } catch {
    // Storage blocked: the choice lasts until the tab closes.
  }
}

const preferencesQuery = {
  queryKey: ['preferences'],
  queryFn: () => call<{preferences: Preferences}>('GET', '/preferences').then(r => r.preferences),
  staleTime: Infinity,
  retry: false,
} as const;

/**
 * Mounted once in the shell. Fetches the profile's preferences once per session and applies them (the
 * server is the source of truth across devices). A failure changes nothing: this browser's values (set at
 * boot) keep working, so there is no flash and no dead end.
 */
export function PreferencesSync() {
  const {data} = useQuery(preferencesQuery);
  const {locale, setLocale} = useI18n();
  const applied = useRef(false);
  useEffect(() => {
    if (!data || applied.current) return;
    applied.current = true;
    const keep = readUnsaved();
    const skip = (key: PrefKey) => keep.has(key) || changedSinceLoad.has(key);
    if (!skip('themeMode') && isThemeMode(data.themeMode)) applyTheme(data.themeMode);
    if (!skip('density') && isDensity(data.density)) applyDensity(data.density);
    const font = String(data.fontScale);
    if (!skip('fontScale') && isFontScale(font)) applyFontScale(font as FontScale);
    if (!skip('radius') && isRadius(data.radius)) applyRadius(data.radius);
    if (!skip('reduceMotion') && typeof data.reduceMotion === 'boolean') applyReduceMotion(data.reduceMotion);
    if (!skip('locale') && isLocale(data.locale) && data.locale !== locale) setLocale(data.locale);
    // Run once, when the profile arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  return null;
}

/**
 * Save a change to the profile. Resolves true when saved there, false when only this browser has it
 * (signed out, offline, server refused): the caller says which in its toast.
 */
export function useSavePreferences() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (patch: PreferencesPatch) => call<{preferences: Preferences}>('PATCH', '/preferences', patch).then(r => r.preferences),
    onSuccess: saved => queryClient.setQueryData(preferencesQuery.queryKey, saved),
  });
  return async (patch: PreferencesPatch): Promise<boolean> => {
    const keys = Object.keys(patch) as PrefKey[];
    for (const key of keys) changedSinceLoad.add(key);
    try {
      await mutation.mutateAsync(patch);
      const unsaved = readUnsaved();
      for (const key of keys) unsaved.delete(key);
      writeUnsaved(unsaved);
      return true;
    } catch {
      writeUnsaved(new Set([...readUnsaved(), ...keys]));
      return false;
    }
  };
}
