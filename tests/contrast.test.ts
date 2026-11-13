import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {filterCommands} from '../src/portal/ui/command';

import {contrastRatio, hexToRgb, isValidHex, normalizeHex, readableOn} from '../src/portal/ui/contrast';
import {addDays, addMonths, monthGrid, parseISODate, weekday} from '../src/portal/ui/date';
import {fuzzyScore} from '../src/portal/ui/fuzzy';

describe('isValidHex', () => {
  it('accepts only #rrggbb', () => {
    for (const ok of ['#000000', '#ffffff', '#AbCdEf', '#3b82f6']) expect(isValidHex(ok)).toBe(true);
    for (const bad of ['', '#fff', '000000', '#00000g', '#0000000', '#12345678', ' #123456', '#123456 ', 'red', 'url(x)', '#123456;x', null, undefined, 5])
      expect(isValidHex(bad)).toBe(false);
  });
  it('normalizes to lower case or null', () => {
    expect(normalizeHex('#ABCDEF')).toBe('#abcdef');
    expect(normalizeHex('#abc')).toBeNull();
  });
  it('parses channels', () => {
    expect(hexToRgb('#0a141e')).toEqual([10, 20, 30]);
    expect(() => hexToRgb('nope')).toThrow(RangeError);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white and 1 for the same colour', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
  it('matches the known value for #777 on white (about 4.48)', () => {
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
});

describe('readableOn', () => {
  it('picks white on dark and black on light', () => {
    expect(readableOn('#000000')).toBe('#ffffff');
    expect(readableOn('#1e293b')).toBe('#ffffff');
    expect(readableOn('#ffffff')).toBe('#000000');
    expect(readableOn('#fde047')).toBe('#000000');
    expect(readableOn('#22c55e')).toBe('#000000');
    expect(readableOn('#eab308')).toBe('#000000');
  });
  it('prefers white on saturated mid-tones', () => {
    for (const hex of ['#ef4444', '#3b82f6', '#6366f1', '#a855f7', '#ec4899']) expect(readableOn(hex)).toBe('#ffffff');
  });
  it('falls back to black for invalid input', () => {
    expect(readableOn('nope')).toBe('#000000');
  });
});

describe('date helpers', () => {
  it('parses only real calendar dates', () => {
    expect(parseISODate('2024-02-29')).toEqual({year: 2024, month: 2, day: 29});
    expect(parseISODate('2026-02-29')).toBeNull();
    expect(parseISODate('2026-2-9')).toBeNull();
    expect(parseISODate('')).toBeNull();
  });
  it('adds days and months with clamping', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
  });
  it('builds month grids for either first day of week', () => {
    expect(weekday('2026-11-02')).toBe(1);
    const sun = monthGrid(2026, 11, 0);
    expect(sun[0]![0]).toBe('2026-11-01');
    const mon = monthGrid(2026, 11, 1);
    expect(mon[0]![0]).toBe('2026-10-26');
    for (const w of [sun, mon]) expect(w.every(row => row.length === 7)).toBe(true);
  });
});

describe('fuzzyScore', () => {
  it('matches in-order subsequences only', () => {
    expect(fuzzyScore('inv', 'Invite a teammate')).not.toBeNull();
    expect(fuzzyScore('ita', 'Invite a teammate')).not.toBeNull();
    expect(fuzzyScore('zzz', 'Invite a teammate')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
  it('ranks prefix above scattered', () => {
    expect(fuzzyScore('set', 'Settings')!).toBeGreaterThan(fuzzyScore('set', 'Open the site editor tab')!);
  });
});

describe('filterCommands', () => {
  const run = () => undefined;
  const items = [
    {id: '1', label: 'Go to Overview', onSelect: run},
    {id: '2', label: 'Invite a teammate', hint: 'Users', onSelect: run},
    {id: '3', label: 'Toggle theme', keywords: ['dark', 'light'], onSelect: run},
  ];
  it('returns everything for an empty query', () => {
    expect(filterCommands(items, '  ')).toHaveLength(3);
  });
  it('matches label, hint and hidden keywords, and drops misses', () => {
    expect(filterCommands(items, 'invite').map(i => i.id)).toEqual(['2']);
    expect(filterCommands(items, 'users').map(i => i.id)).toEqual(['2']);
    expect(filterCommands(items, 'dark').map(i => i.id)).toEqual(['3']);
    expect(filterCommands(items, 'zzzz')).toEqual([]);
  });
  it('ranks the stronger match first', () => {
    const ranked = filterCommands([{id: 'a', label: 'Open the site editor tab', onSelect: run}, {id: 'b', label: 'Settings', onSelect: run}], 'set');
    expect(ranked[0]!.id).toBe('b');
  });
});

/**
 * `color-mix(in oklab, <hex> N%, white)` as the browser computes it (CSS Color 4: mix in OKLab, then sRGB,
 * rounded), so tokens built from the accent can be checked like plain hex ones.
 */
function mixWithWhite(hex: string, pct: number): string {
  const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const toSrgb = (c: number) => {
    const v = Math.min(1, Math.max(0, c));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  const oklab = (h: string) => {
    const [r, g, b] = [1, 3, 5].map(i => toLin(parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number];
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const a = oklab(hex);
  const w = oklab('#ffffff');
  const [L, A, B] = a.map((v, i) => (pct / 100) * v + (1 - pct / 100) * w[i]!) as [number, number, number];
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map(c => Math.round(toSrgb(c) * 255).toString(16).padStart(2, '0')).join('')}`;
}
/** The light `--control-border` mix: `color-mix(in oklab, var(--accent) N%, white)` → N. */
const CONTROL_BORDER_MIX = Number(/--control-border:\s*color-mix\(in oklab, var\(--accent\) (\d+)%, white\)/.exec(readFileSync('src/styles/global.css', 'utf8'))?.[1] ?? NaN);

describe('colour tokens (global.css)', () => {
  const css = readFileSync('src/styles/global.css', 'utf8');
  const block = (start: string) => {
    const i = css.indexOf(start);
    return css.slice(i, css.indexOf('}', i));
  };
  const token = (b: string, name: string): string => {
    // An accent tint (the light --control-border) is computed from this block's --accent.
    if (name === '--control-border' && new RegExp(`${name}:\\s*color-mix`).test(b)) return mixWithWhite(token(b, '--accent'), CONTROL_BORDER_MIX);
    return new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(b)![1]!;
  };
  const sets = {
    light: {block: block(':root {'), surfaces: ['--bg', '--surface', '--card', '--hover', '--line']},
    dark: {block: block(":root[data-theme='dark'] {"), surfaces: ['--bg', '--surface', '--card', '--hover']},
    darkAuto: {block: block(':root:not([data-theme=\'light\']) {'), surfaces: ['--bg', '--surface', '--card', '--hover']},
  };
  for (const [mode, {block: b, surfaces}] of Object.entries(sets)) {
    it(`${mode}: --subtle is AA (4.5) and --control-border is 3:1 on every surface`, () => {
      for (const s of surfaces) {
        expect(contrastRatio(token(b, '--subtle'), token(b, s))).toBeGreaterThanOrEqual(4.5);
        if (s !== '--line') expect(contrastRatio(token(b, '--control-border'), token(b, s))).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${mode}: the focus ring colour --accent is 3:1 on every surface (WCAG 2.4.11)`, () => {
      for (const s of surfaces) {
        if (s !== '--line') expect(contrastRatio(token(b, '--accent'), token(b, s))).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe('accent swatch check mark (accents.css)', () => {
  const css = readFileSync('src/app/settings/accents.css', 'utf8');
  const dots = [...css.matchAll(/\.lf-swatch\[data-accent='(\w+)'\] \{ --swatch-bg: (#[0-9a-f]{6}); \}/g)];
  it('covers all eight accents', () => expect(dots.length).toBe(8));
  for (const [, name, bg] of dots) {
    it(`${name}: the white check is 4.5:1 on its dot`, () => {
      expect(contrastRatio('#ffffff', bg!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('accent presets and high contrast (src/app/settings/accents.css)', () => {
  const css = readFileSync('src/app/settings/accents.css', 'utf8');
  const hexOf = (body: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(body)![1]!;
  const block = (selector: string) => {
    const i = css.indexOf(`${selector} {`);
    expect(i, selector).toBeGreaterThanOrEqual(0);
    return css.slice(i, css.indexOf('}', i));
  };
  const base = readFileSync('src/styles/global.css', 'utf8');
  const surfacesOf = (selector: string, names: string[]) => {
    const i = base.indexOf(`${selector} {`);
    const b = base.slice(i, base.indexOf('}', i));
    return names.map(n => hexOf(b, n));
  };
  const light = surfacesOf(':root', ['bg', 'surface', 'card', 'hover']);
  const dark = surfacesOf(":root[data-theme='dark']", ['bg', 'surface', 'card', 'hover']);
  const accents = [...css.matchAll(/^:root\[data-accent='(\w+)'\] \{/gm)].map(m => m[1]!);

  it('the light field border (an accent tint) is 3:1 on every surface, for every preset', () => {
    expect(CONTROL_BORDER_MIX).toBeGreaterThan(0);
    for (const name of accents) {
      const border = mixWithWhite(hexOf(block(`:root[data-accent='${name}']`), 'accent'), CONTROL_BORDER_MIX);
      for (const s of light) expect(contrastRatio(border, s), `${name} ${border} on ${s}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('has the presets the picker offers', () => {
    expect(accents.sort()).toEqual(['blue', 'green', 'indigo', 'orange', 'purple', 'rose', 'slate', 'teal']);
  });
  for (const name of accents) {
    for (const [mode, selector, surfaces] of [
      ['light', `:root[data-accent='${name}']`, light],
      ['dark', `:root[data-theme='dark'][data-accent='${name}']`, dark],
    ] as const) {
      it(`${name} ${mode}: accent 4.5:1 on surfaces, ink on accent and text on tint 4.5:1`, () => {
        const b = block(selector);
        const accent = hexOf(b, 'accent');
        for (const s of surfaces) {
          expect(contrastRatio(accent, s)).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(hexOf(b, 'accent-text'), s)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrastRatio(hexOf(b, 'accent-ink'), accent)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(hexOf(b, 'accent-ink'), hexOf(b, 'accent-hover'))).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(hexOf(b, 'accent-text'), hexOf(b, 'accent-soft'))).toBeGreaterThanOrEqual(4.5);
      });
    }
    it(`${name}: the device-dark rule carries the same values as data-theme='dark'`, () => {
      const forced = block(`:root[data-theme='dark'][data-accent='${name}']`);
      const auto = block(`  :root:not([data-theme='light']):not([data-theme='contrast'])[data-accent='${name}']`.trim());
      for (const t of ['accent', 'accent-hover', 'accent-ink', 'accent-soft', 'accent-text']) expect(hexOf(auto, t)).toBe(hexOf(forced, t));
    });
  }

  it('high contrast: text AA+, field borders 3:1, accent AA on every surface', () => {
    const b = block(`html:root[data-theme='contrast'],\nhtml:root[data-theme='contrast'][data-accent]`);
    for (const s of ['bg', 'surface', 'card', 'hover']) {
      const surface = hexOf(b, s);
      expect(contrastRatio(hexOf(b, 'ink'), surface)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(hexOf(b, 'muted'), surface)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(hexOf(b, 'subtle'), surface)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(hexOf(b, 'control-border'), surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(hexOf(b, 'accent'), surface)).toBeGreaterThanOrEqual(7);
    }
    expect(contrastRatio(hexOf(b, 'accent-ink'), hexOf(b, 'accent'))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(hexOf(b, 'accent-text'), hexOf(b, 'accent-soft'))).toBeGreaterThanOrEqual(7);
  });
  it('high contrast: status colours are AA text and UI on every surface, and the line borders are 3:1', () => {
    const b = block(`html:root[data-theme='contrast'],\nhtml:root[data-theme='contrast'][data-accent]`);
    for (const s of ['bg', 'surface', 'card', 'hover']) {
      const surface = hexOf(b, s);
      for (const n of ['success', 'warning', 'danger', 'info']) expect(contrastRatio(hexOf(b, n), surface), n).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(hexOf(b, 'line-strong'), surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(hexOf(b, 'line'), surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it('corner radius: sharp < soft (global.css) < round, and every step keeps the token order', () => {
    const px = (body: string, name: string) => Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(body)![1]);
    const names = ['radius-sm', 'radius', 'radius-lg', 'radius-card', 'radius-lane'];
    const root = base.slice(base.indexOf(':root {'), base.indexOf('}', base.indexOf(':root {')));
    const sharp = block(`html[data-radius='sharp']`);
    const round = block(`html[data-radius='round']`);
    for (const n of names) {
      expect(px(sharp, n), n).toBeLessThan(px(root, n));
      expect(px(round, n), n).toBeGreaterThan(px(root, n));
    }
  });
});
