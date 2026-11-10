/**
 * The launch languages (SPEC 11). Adding a language is one catalog file in
 * `messages/` plus one entry here (and one in `meta.ts`).
 */
export type Dir = 'ltr' | 'rtl';

export interface LocaleMeta {
  code: string;
  /** The language's own name, shown in the picker. */
  native: string;
  dir: Dir;
}

export const LOCALES = [
  {code: 'en', native: 'English', dir: 'ltr'},
  {code: 'bn', native: 'বাংলা', dir: 'ltr'},
  {code: 'hi', native: 'हिन्दी', dir: 'ltr'},
  {code: 'ur', native: 'اردو', dir: 'rtl'},
  {code: 'ar', native: 'العربية', dir: 'rtl'},
  {code: 'fa', native: 'فارسی', dir: 'rtl'},
  {code: 'es', native: 'Español', dir: 'ltr'},
  {code: 'fr', native: 'Français', dir: 'ltr'},
  {code: 'pt', native: 'Português', dir: 'ltr'},
  {code: 'de', native: 'Deutsch', dir: 'ltr'},
  {code: 'it', native: 'Italiano', dir: 'ltr'},
  {code: 'ru', native: 'Русский', dir: 'ltr'},
  {code: 'tr', native: 'Türkçe', dir: 'ltr'},
  {code: 'id', native: 'Bahasa Indonesia', dir: 'ltr'},
  {code: 'zh', native: '简体中文', dir: 'ltr'},
  {code: 'ja', native: '日本語', dir: 'ltr'},
  {code: 'ko', native: '한국어', dir: 'ltr'},
  {code: 'vi', native: 'Tiếng Việt', dir: 'ltr'},
  {code: 'th', native: 'ไทย', dir: 'ltr'},
  {code: 'sw', native: 'Kiswahili', dir: 'ltr'},
] as const satisfies readonly LocaleMeta[];

export type LocaleCode = (typeof LOCALES)[number]['code'];
export const DEFAULT_LOCALE: LocaleCode = 'en';

const CODES = new Set<string>(LOCALES.map(locale => locale.code));

export const isLocale = (value: unknown): value is LocaleCode => typeof value === 'string' && CODES.has(value);

export const dirOf = (code: string): Dir => LOCALES.find(locale => locale.code === code)?.dir ?? 'ltr';

/** The class on <html> that picks the language's font stack (`lang-bn`, see global.css). */
export const langClass = (code: string) => `lang-${code}`;
