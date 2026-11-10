import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

/** Static accessibility rules for the app and the kit (browser checks are listed in docs/product/review-a11y-phase10.md). */
const files = (dir: string): string[] =>
  readdirSync(dir, {withFileTypes: true}).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : []));
const sources = [...files('src/app'), ...files('src/portal')].map(path => ({path, text: readFileSync(path, 'utf8')}));
const line = (text: string, index: number) => text.slice(0, index).split('\n').length;

describe('a11y static guard', () => {
  it('icon-only <button> elements have an accessible name', () => {
    const bad: string[] = [];
    for (const {path, text} of sources) {
      for (const m of text.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        const body = m[2].trim();
        if (/aria-label|aria-labelledby|title=/.test(m[1])) continue;
        if (/^<Icon\b[^>]*\/>$/.test(body) || /^[×✕✖⋯…+−]$/.test(body)) bad.push(`${path}:${line(text, m.index ?? 0)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('target="_blank" links carry rel="noopener noreferrer"', () => {
    const bad: string[] = [];
    for (const {path, text} of sources)
      for (const m of text.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) if (!/rel="noopener noreferrer"/.test(m[0])) bad.push(`${path}:${line(text, m.index ?? 0)}`);
    expect(bad).toEqual([]);
  });

  it('images have an alt attribute', () => {
    const bad: string[] = [];
    for (const {path, text} of sources) for (const m of text.matchAll(/<img\b[^>]*>/g)) if (!/\balt=/.test(m[0]) && !/\{\.\.\./.test(m[0])) bad.push(`${path}:${line(text, m.index ?? 0)}`);
    expect(bad).toEqual([]);
  });

  it('no window.alert / confirm / prompt', () => {
    const bad = sources.filter(s => /\bwindow\.(alert|confirm|prompt)\(/.test(s.text)).map(s => s.path);
    expect(bad).toEqual([]);
  });

  it('no positive tabIndex', () => {
    const bad = sources.filter(s => /tabIndex=\{?[1-9]/.test(s.text)).map(s => s.path);
    expect(bad).toEqual([]);
  });

  it('Field wires its control: label id, aria-invalid, aria-describedby, translated "optional"', () => {
    const form = readFileSync('src/portal/ui/form.tsx', 'utf8');
    expect(form).toContain('cloneElement');
    expect(form).toContain("'aria-invalid'");
    expect(form).toContain("'aria-describedby'");
    expect(form).toContain('labels.optional');
    expect(readFileSync('src/app/shell.tsx', 'utf8')).toContain("optional: t('common.optional')");
  });

  it('toasts: errors are assertive alerts, others polite status', () => {
    const overlay = readFileSync('src/portal/ui/overlay.tsx', 'utf8');
    expect(overlay).toMatch(/role="alert" aria-live="assertive"/);
    expect(overlay).toMatch(/role="status" aria-live="polite"/);
  });

  it('dialogs are native <dialog> opened with showModal (trap, Esc, focus return)', () => {
    const overlay = readFileSync('src/portal/ui/overlay.tsx', 'utf8');
    expect(overlay).toContain('showModal()');
    expect(overlay).not.toMatch(/aria-modal="false"/);
  });
});
