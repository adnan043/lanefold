import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {LOCALES} from '../src/i18n/locales';
import {NEEDS_REVIEW} from '../src/i18n/meta';
import {PLURAL_SUFFIXES, placeholders} from '../src/i18n/core';

const DIR = join(__dirname, '..', 'src', 'i18n', 'messages');
const load = (code: string): Record<string, string> => JSON.parse(readFileSync(join(DIR, `${code}.json`), 'utf8'));

const suffixRe = new RegExp(`_(${PLURAL_SUFFIXES.join('|')})$`);
const baseOf = (key: string) => key.replace(suffixRe, '');
const isPlural = (key: string, keys: string[]) => suffixRe.test(key) && keys.some(k => k !== key && baseOf(k) === baseOf(key));

const en = load('en');
const enKeys = Object.keys(en);
const enBases = [...new Set(enKeys.map(baseOf))].sort();
const enPluralBases = new Set(enKeys.filter(k => isPlural(k, enKeys)).map(baseOf));

describe('i18n catalogs', () => {
  it('has a file for every launch locale and no strays', () => {
    const files = readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort();
    expect(files).toEqual(LOCALES.map(l => l.code).sort());
    expect(LOCALES).toHaveLength(20);
  });

  it('marks every non-English catalog needsReview', () => {
    for (const {code} of LOCALES) expect(NEEDS_REVIEW.has(code)).toBe(code !== 'en');
  });

  describe.each(LOCALES.filter(l => l.code !== 'en').map(l => l.code))('%s', code => {
    const catalog = load(code);
    const keys = Object.keys(catalog);

    it('has exactly the keys of en (plural forms by CLDR category)', () => {
      expect([...new Set(keys.map(baseOf))].sort()).toEqual(enBases);
      const categories = new Intl.PluralRules(code).resolvedOptions().pluralCategories;
      for (const base of enPluralBases) {
        const forms = keys.filter(k => baseOf(k) === base && k !== base).map(k => k.slice(base.length + 1)).sort();
        expect(forms, `${code} ${base}`).toEqual([...categories].sort());
        expect(keys).not.toContain(base);
      }
      for (const key of enKeys.filter(k => !isPlural(k, enKeys))) expect(keys).toContain(key);
    });

    it('keeps every placeholder of en', () => {
      for (const key of keys) {
        const source = isPlural(key, keys) ? en[`${baseOf(key)}_other`] : en[key];
        if (source === undefined) continue; // reported by the key test
        const want = placeholders(source);
        const got = placeholders(catalog[key]!);
        if (isPlural(key, keys) && !key.endsWith('_other')) {
          // a singular form may write the number out as a word
          expect(got.filter(p => p !== 'count'), key).toEqual(want.filter(p => p !== 'count'));
        } else {
          expect(got, key).toEqual(want);
        }
      }
    });

    it('has no empty strings', () => {
      for (const [key, value] of Object.entries(catalog)) expect(typeof value === 'string' && value.trim().length > 0, key).toBe(true);
    });
  });
});
