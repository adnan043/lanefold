import {DEFAULT_LOCALE, isLocale, type LocaleCode} from './locales';

/** `pt-BR` gives `pt`, `zh-Hans-CN` gives `zh`, `nb`/unknown gives null. */
export function matchLocale(tag: string | null | undefined): LocaleCode | null {
  if (!tag) return null;
  const lower = tag.trim().toLowerCase().replace('_', '-');
  if (isLocale(lower)) return lower;
  const primary = lower.split('-')[0] ?? '';
  return isLocale(primary) ? primary : null;
}

/** `en-US,en;q=0.9,bn;q=0.8` into tags, best first. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = Number(params.find(p => p.trim().startsWith('q='))?.split('=')[1] ?? 1);
      return {tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index};
    })
    .filter(entry => entry.tag && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map(entry => entry.tag);
}

export const LOCALE_COOKIE = 'lf_locale';

export function readLocaleCookie(cookie: string): string | null {
  const match = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${LOCALE_COOKIE}=`));
  if (!match) return null;
  try {
    return decodeURIComponent(match.slice(LOCALE_COOKIE.length + 1));
  } catch {
    return null; // a malformed cookie must not break the page
  }
}

/**
 * profile.locale, then the `lf_locale` cookie, then the browser's languages
 * (navigator / Accept-Language), then `en`. Each step is used only when it names a
 * language we have.
 */
export function resolveLocale(input: {
  profile?: string | null;
  cookie?: string | null;
  languages?: readonly string[];
}): LocaleCode {
  const candidates = [input.profile, input.cookie, ...(input.languages ?? [])];
  for (const candidate of candidates) {
    const found = matchLocale(candidate);
    if (found) return found;
  }
  return DEFAULT_LOCALE;
}
