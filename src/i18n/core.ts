import en from './messages/en.json';

/**
 * The translator, pure (no React, no DOM): typed keys from `en`,
 * `{name}` placeholders, plurals through `Intl.PluralRules` with
 * `_zero/_one/_two/_few/_many/_other` suffixes (`t('workspace.members', {count: 3})`
 * looks up `workspace.members_few`, then `_other`).
 */
export type Messages = Readonly<Record<string, string>>;
export type Params = Record<string, string | number>;

type PluralSuffix = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
type Base<K> = K extends `${infer B}_${PluralSuffix}` ? B : K;
/** Every key you may pass to `t()`: en's keys, plural forms collapsed to their base. */
export type MessageKey = Base<keyof typeof en>;

export const EN: Messages = en;
export const PLURAL_SUFFIXES: readonly PluralSuffix[] = ['zero', 'one', 'two', 'few', 'many', 'other'];

const rules = new Map<string, Intl.PluralRules>();
function pluralRule(locale: string): Intl.PluralRules {
  let rule = rules.get(locale);
  if (!rule) {
    try {
      rule = new Intl.PluralRules(locale);
    } catch {
      rule = new Intl.PluralRules('en');
    }
    rules.set(locale, rule);
  }
  return rule;
}

/** The plural category of `count` in `locale`. */
export const pluralCategory = (locale: string, count: number): PluralSuffix => pluralRule(locale).select(count) as PluralSuffix;

/** Fills `{name}` from params. A number is formatted for the locale; an unknown name stays as written. */
export function interpolate(template: string, params: Params | undefined, locale = 'en'): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : value;
  });
}

/** The text for `key` in `catalog`, or undefined when the catalog has none. */
export function lookup(catalog: Messages, key: string, params?: Params, locale = 'en'): string | undefined {
  let raw: string | undefined;
  if (typeof params?.count === 'number') {
    raw = catalog[`${key}_${pluralCategory(locale, params.count)}`] ?? catalog[`${key}_other`];
  }
  raw ??= catalog[key];
  return raw === undefined ? undefined : interpolate(raw, params, locale);
}

/** `catalog`, then English, then the key itself (a missing key is visible, never blank). */
export function translate(catalog: Messages, key: string, params?: Params, locale = 'en'): string {
  return lookup(catalog, key, params, locale) ?? lookup(EN, key, params, 'en') ?? key;
}

export type TFunction = (key: MessageKey, params?: Params) => string;

/** Placeholder names in a message, sorted: `"{a} of {b}"` gives `['a', 'b']`. */
export const placeholders = (message: string): string[] =>
  [...new Set([...message.matchAll(/\{(\w+)\}/g)].map(match => match[1]!))].sort();
