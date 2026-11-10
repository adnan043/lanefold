import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

import {ERROR_ALIASES, PLAN_LIMIT_CODES} from '../src/i18n/errors';
import {LOCALES} from '../src/i18n/locales';

const ROOT = join(__dirname, '..');
const MESSAGES = join(ROOT, 'src', 'i18n', 'messages');
const load = (code: string): Record<string, string> => JSON.parse(readFileSync(join(MESSAGES, `${code}.json`), 'utf8'));

/** Codes the client never shows as such: the managed platform answers them with their own `message` (auth, guards). */
const INTERNAL = new Set<string>([
  'P2002', // Prisma error codes, caught in the server and never sent
  'P2025',
  'E_FILE_NOT_FOUND', // the platform's answer to a file delete, matched in the file-cleanup job only
  'empty', // import dry-run problems: shown through importExport.problem.<code>, never as an API error
  'lane_full',
  'too_many_labels',
  'too_many_lanes',
]);

function sources(dir: string): string[] {
  return readdirSync(dir, {withFileTypes: true}).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? sources(p) : e.name.endsWith('.ts') ? [p] : [];
  });
}

/** Every literal error code the server sources send. */
function serverCodes(): Set<string> {
  const re = /(?:problem\(\s*(?:[a-z.]+,\s*)?|Refuse\(\s*\d+,\s*|\brefuse\(\s*\d+,\s*|\bcode:\s*|\bcode\s*===\s*)'([A-Za-z][A-Za-z_0-9]*)'/g;
  const out = new Set<string>();
  for (const file of sources(join(ROOT, 'src', 'server'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(re)) out.add(m[1]!);
  }
  return out;
}

const en = load('en');
const mapped = (code: string) => `errors.${ERROR_ALIASES[code] ?? code}` in en;

describe('server error codes', () => {
  const codes = [...serverCodes()].sort();

  it('finds the codes', () => {
    expect(codes.length).toBeGreaterThan(20);
    expect(codes).toContain('stale');
  });

  it('every code has an errors.* message (or is deliberately internal)', () => {
    const missing = codes.filter(c => !INTERNAL.has(c) && !mapped(c));
    expect(missing).toEqual([]);
  });

  it('every alias points at a real message', () => {
    for (const target of Object.values(ERROR_ALIASES)) expect(en[`errors.${target}`], target).toBeTruthy();
  });

  it('every plan-limit code has a message', () => {
    for (const code of PLAN_LIMIT_CODES) expect(mapped(code), code).toBe(true);
  });

  it('every error message exists, translated, in all catalogs', () => {
    const keys = Object.keys(en).filter(k => k.startsWith('errors.'));
    for (const {code} of LOCALES.filter(l => l.code !== 'en')) {
      const catalog = load(code);
      for (const k of keys) {
        expect(catalog[k], `${code} ${k}`).toBeTruthy();
        expect(catalog[k], `${code} ${k} is still English`).not.toBe(en[k]);
      }
    }
  });
});
