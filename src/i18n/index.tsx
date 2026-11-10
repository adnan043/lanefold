import {createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState} from 'react';

import '../styles/i18n.css';
import {EN, type MessageKey, type Messages, type Params, lookup, translate} from './core';
import {errorText, type ErrorLike, fieldErrorTexts} from './errors';
import {browserTimezone, type FormatContext, formatDate, formatDateTime, formatNumber, formatRelative} from './format';
import {DEFAULT_LOCALE, dirOf, isLocale, langClass, LOCALES, type LocaleCode} from './locales';
import {LOCALE_COOKIE, readLocaleCookie, resolveLocale} from './resolve';

export * from './core';
export * from './errors';
export * from './format';
export * from './locales';
export * from './meta';
export * from './resolve';

/**
 * The i18n provider and `useT()`. Catalogs load lazily, one dynamic import per
 * language (`messages/<locale>.json`): `en` is always in the bundle (it is the
 * source of the typed keys), every other language is its own small chunk. A
 * language whose file does not exist yet shows English.
 */
const loaders = import.meta.glob<{default: Messages}>('./messages/*.json');

async function loadCatalog(locale: LocaleCode): Promise<Messages> {
  if (locale === 'en') return EN;
  const load = loaders[`./messages/${locale}.json`];
  if (!load) return EN;
  try {
    return (await load()).default;
  } catch {
    return EN;
  }
}

export interface UserLocaleSettings {
  /** `user_profiles.locale`, when known. */
  profileLocale?: string | null;
  timezone?: string | null;
  firstDayOfWeek?: number | null;
}

interface I18nValue {
  locale: LocaleCode;
  dir: 'ltr' | 'rtl';
  t: (key: MessageKey, params?: Params) => string;
  /** Like `t` for a key built at run time (`errors.<code>`): undefined when missing. */
  has: (key: string, params?: Params) => string | undefined;
  /** Switches language now and remembers it in the `lf_locale` cookie. Saving to the profile is the caller's job. */
  setLocale: (locale: LocaleCode) => void;
  timezone: string;
  firstDayOfWeek: number;
  formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatDateTime: (value: Date | string | number) => string;
  formatRelative: (value: Date | string | number) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  /** A server error in words, in this language. */
  errorMessage: (error: unknown) => string;
  /** The server's field errors in this language, by field name. */
  fieldErrors: (error: unknown) => Record<string, string>;
}

const I18nContext = createContext<I18nValue | null>(null);

function browserLanguages(): string[] {
  return typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language].filter(Boolean);
}

function writeCookie(locale: LocaleCode) {
  try {
    document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
  } catch {
    // Cookies blocked: the profile still remembers it.
  }
}

/** `<html lang dir class="lang-xx">`: the language's font stack and direction (global.css). */
export function applyDocumentLocale(locale: LocaleCode) {
  const root = document.documentElement;
  root.lang = locale;
  root.dir = dirOf(locale);
  for (const cls of [...root.classList]) if (cls.startsWith('lang-')) root.classList.remove(cls);
  root.classList.add(langClass(locale));
}

export function I18nProvider({settings, children}: {settings: UserLocaleSettings; children: ReactNode}) {
  // A choice made in the picker beats the profile until the profile catches up.
  const [chosen, setChosen] = useState<LocaleCode | null>(null);
  const locale = useMemo(
    () =>
      chosen ??
      resolveLocale({
        profile: settings.profileLocale,
        cookie: typeof document === 'undefined' ? null : readLocaleCookie(document.cookie),
        languages: browserLanguages(),
      }),
    [chosen, settings.profileLocale]
  );
  const [catalogs, setCatalogs] = useState<Partial<Record<LocaleCode, Messages>>>({en: EN});

  useEffect(() => {
    applyDocumentLocale(locale);
    if (locale === 'zh' || locale === 'ja' || locale === 'ko') void import('../styles/i18n-cjk.css').catch(() => undefined);
    if (catalogs[locale]) return;
    let live = true;
    void loadCatalog(locale)
      .catch(() => EN)
      .then(messages => live && setCatalogs(current => ({...current, [locale]: messages})));
    return () => {
      live = false;
    };
  }, [locale, catalogs]);

  const catalog = catalogs[locale] ?? EN;
  const timezone = settings.timezone || browserTimezone();
  const firstDayOfWeek = settings.firstDayOfWeek ?? 1;

  const setLocale = useCallback((next: LocaleCode) => {
    if (!isLocale(next)) return;
    writeCookie(next);
    setChosen(next);
  }, []);

  const value = useMemo<I18nValue>(() => {
    const ctx: FormatContext = {locale, timezone};
    const has = (key: string, params?: Params) => lookup(catalog, key, params, locale) ?? lookup(EN, key, params, 'en');
    return {
      locale,
      dir: dirOf(locale),
      t: (key, params) => translate(catalog, key, params, locale),
      has,
      setLocale,
      timezone,
      firstDayOfWeek,
      formatDate: (v, options) => formatDate(ctx, v, options),
      formatDateTime: v => formatDateTime(ctx, v),
      formatRelative: v => formatRelative(ctx, v),
      formatNumber: (v, options) => formatNumber(ctx, v, options),
      errorMessage: error => errorText(has, error as ErrorLike),
      fieldErrors: error => fieldErrorTexts(has, error as ErrorLike),
    };
  }, [catalog, locale, timezone, firstDayOfWeek, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n() needs <I18nProvider> (AppRoot mounts it).');
  return value;
}

/** `const t = useT(); t('nav.myDay')`. */
export function useT() {
  return useI18n().t;
}

export {DEFAULT_LOCALE, LOCALES};
