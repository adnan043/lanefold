import {contrastRatio, hexToRgb, normalizeHex} from '../portal/ui/contrast';

/**
 * The admin's brand colour (any `#rrggbb`, /dashboard Branding) turned into the five accent tokens of
 * `src/styles/global.css` for light and dark mode. Pure and browser-safe: the dashboard previews with it,
 * `/site-api/brand.css` serves it.
 *
 * Any colour is accepted; it is moved toward black (light mode) or white (dark mode) only as far as needed so
 * that, like the tested presets (tests/contrast.test.ts), the accent and the accent text are 4.5:1 on every
 * surface, the text on the accent is 4.5:1, and the accent text is 4.5:1 on its soft tint.
 */

export type AccentTokens = {accent: string; accentHover: string; accentInk: string; accentSoft: string; accentText: string};
export type BrandPalette = {color: string; light: AccentTokens; dark: AccentTokens; adjusted: boolean};

/** The surfaces of global.css (bg, surface, card, hover); tests/brand.test.ts keeps them in step. */
export const LIGHT_SURFACES = ['#ffffff', '#f6f7f9', '#ffffff', '#eff1f5'] as const;
export const DARK_SURFACES = ['#0d1110', '#111614', '#171d1b', '#1e2623'] as const;
/** global.css's own green: what the site uses while no brand colour is set. */
export const DEFAULT_BRAND = '#0f6b4f';
const DARK_INK = '#07100c';
const MIN = 4.5;

const toHex = (rgb: number[]) => `#${rgb.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

/** `a` moved `t` (0..1) of the way to `b`, in sRGB. */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return toHex(x.map((v, i) => v + (y[i]! - v) * t));
}

const worst = (color: string, against: readonly string[]) => Math.min(...against.map(s => contrastRatio(color, s)));

/** The least shift of `color` toward `target` that reads at 4.5:1 on every one of `against`. */
function readable(color: string, target: string, against: readonly string[]): string {
  for (let step = 0; step <= 50; step++) {
    const candidate = mix(color, target, step / 50);
    if (worst(candidate, against) >= MIN) return candidate;
  }
  return target;
}

const better = (bg: string, a: string, b: string) => (contrastRatio(a, bg) >= contrastRatio(b, bg) ? a : b);

function lightTokens(color: string): AccentTokens {
  const accent = readable(color, '#000000', LIGHT_SURFACES);
  const accentSoft = mix(accent, '#ffffff', 0.86);
  return {
    accent,
    accentHover: mix(accent, '#000000', 0.18),
    accentInk: better(accent, '#ffffff', '#000000'),
    accentSoft,
    accentText: readable(accent, '#000000', [...LIGHT_SURFACES, accentSoft]),
  };
}

function darkTokens(color: string): AccentTokens {
  const accent = readable(color, '#ffffff', DARK_SURFACES);
  const accentSoft = mix(accent, DARK_SURFACES[0], 0.78);
  return {
    accent,
    accentHover: mix(accent, '#ffffff', 0.2),
    accentInk: better(accent, DARK_INK, '#ffffff'),
    accentSoft,
    accentText: readable(accent, '#ffffff', [...DARK_SURFACES, accentSoft]),
  };
}

/** The palette for a brand colour, or null when it is not `#rrggbb`. */
export function brandPalette(value: unknown): BrandPalette | null {
  const color = normalizeHex(value);
  if (!color) return null;
  const light = lightTokens(color);
  const dark = darkTokens(color);
  return {color, light, dark, adjusted: light.accent !== color || dark.accent !== color};
}

const block = (selector: string, t: AccentTokens, indent = '') =>
  `${indent}${selector} {\n` +
  `${indent}  --accent: ${t.accent};\n${indent}  --accent-hover: ${t.accentHover};\n${indent}  --accent-ink: ${t.accentInk};\n` +
  `${indent}  --accent-soft: ${t.accentSoft};\n${indent}  --accent-text: ${t.accentText};\n${indent}}\n`;

/**
 * The stylesheet for a brand colour: '' for none (global.css keeps its green). Only when the person has not
 * chosen their own accent (`data-accent`, app Settings > Appearance), and never in high-contrast mode.
 * Specificity, not load order, makes it win over global.css (`:root`, `:root[data-theme='dark']`).
 */
export function brandCss(value: unknown): string {
  const p = brandPalette(value);
  if (!p) return '';
  return (
    `/* Brand colour ${p.color}, set in /dashboard Branding. */\n` +
    `:root {\n  --brand-swatch: ${p.light.accent};\n}\n` +
    block(':root:not([data-accent]):not([data-theme=\'contrast\'])', p.light) +
    block(':root[data-theme=\'dark\']:not([data-accent])', p.dark) +
    '@media (prefers-color-scheme: dark) {\n' +
    block(':root:not([data-theme=\'light\']):not([data-theme=\'contrast\']):not([data-accent])', p.dark, '  ') +
    '}\n'
  );
}

/**
 * A person's own accent (app Settings > Appearance > Custom color), made readable like the brand colour. Applies
 * under `data-accent='custom'`; high contrast mode still wins (accents.css). '' when not `#rrggbb`.
 */
export function customAccentCss(value: unknown): string {
  const p = brandPalette(value);
  if (!p) return '';
  return (
    `:root {\n  --custom-swatch: ${p.light.accent};\n}\n` +
    block(":root[data-accent='custom']", p.light) +
    block(":root[data-theme='dark'][data-accent='custom']", p.dark) +
    '@media (prefers-color-scheme: dark) {\n' +
    block(":root:not([data-theme='light']):not([data-theme='contrast'])[data-accent='custom']", p.dark, '  ') +
    '}\n'
  );
}
