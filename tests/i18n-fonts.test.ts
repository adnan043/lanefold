import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Every /fonts/ URL in i18n.css and the CSS it imports. */
function fontUrls(): string[] {
  // i18n-cjk.css is loaded on demand (zh/ja/ko only) by src/i18n/index.tsx, so it is listed here.
  const main = read('src/styles/i18n.css');
  const files = ['src/styles/i18n.css', 'src/styles/i18n-cjk.css'];
  for (const m of main.matchAll(/@import\s+'\.\/([^']+)'/g)) if (!files.includes(`src/styles/${m[1]}`)) files.push(`src/styles/${m[1]}`);
  const urls = new Set<string>();
  for (const f of files) for (const m of read(f).matchAll(/url\('(\/fonts\/[^']+)'\)/g)) urls.add(m[1]);
  return [...urls];
}

describe('locale fonts', () => {
  const urls = fontUrls();

  it('references font files', () => {
    expect(urls.length).toBeGreaterThanOrEqual(8);
  });

  it('every /fonts/ URL in i18n.css exists in public/fonts', () => {
    const missing = urls.filter(u => !existsSync(join(ROOT, 'public', u)));
    expect(missing).toEqual([]);
  });

  it('ships the OFL licenses', () => {
    expect(read('public/fonts/LICENSES.txt')).toContain('SIL Open Font License');
  });

  it('caches /fonts/* as immutable', () => {
    expect(read('public/_headers')).toMatch(/\/fonts\/\*\s+Cache-Control: public, max-age=31536000, immutable/);
  });
});
