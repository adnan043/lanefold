import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {brandCss, brandPalette, DARK_SURFACES, LIGHT_SURFACES} from '../src/lib/brand';
import {contrastRatio} from '../src/portal/ui/contrast';

const SAMPLES = ['#ffffff', '#000000', '#ffff00', '#fde047', '#808080', '#0f6b4f', '#3b82f6', '#ef4444', '#a855f7', '#22c55e', '#14b8a6', '#1e293b', '#f97316', '#ABCDEF'];

describe('brand palette (src/lib/brand.ts)', () => {
  it('keeps the surfaces in step with global.css', () => {
    const css = readFileSync('src/styles/global.css', 'utf8');
    const surfaces = (selector: string) => {
      const i = css.indexOf(`${selector} {`);
      const block = css.slice(i, css.indexOf('}', i));
      return ['bg', 'surface', 'card', 'hover'].map(n => new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`).exec(block)![1]!.toLowerCase());
    };
    expect([...LIGHT_SURFACES]).toEqual(surfaces(':root'));
    expect([...DARK_SURFACES]).toEqual(surfaces(":root[data-theme='dark']"));
  });

  for (const hex of SAMPLES) {
    it(`${hex}: readable in light and dark mode`, () => {
      const p = brandPalette(hex)!;
      for (const [tokens, surfaces] of [
        [p.light, LIGHT_SURFACES],
        [p.dark, DARK_SURFACES],
      ] as const) {
        for (const s of surfaces) {
          expect(contrastRatio(tokens.accent, s)).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(tokens.accentText, s)).toBeGreaterThanOrEqual(4.5);
        }
        expect(contrastRatio(tokens.accentInk, tokens.accent)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens.accentInk, tokens.accentHover)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(tokens.accentText, tokens.accentSoft)).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('keeps a colour that is already readable as it is', () => {
    const p = brandPalette('#0f6b4f')!;
    expect(p.light.accent).toBe('#0f6b4f');
    expect(p.color).toBe('#0f6b4f');
  });

  it('lower-cases and flags an adjusted colour', () => {
    const p = brandPalette('#FFFF00')!;
    expect(p.color).toBe('#ffff00');
    expect(p.adjusted).toBe(true);
  });

  it('refuses anything that is not #rrggbb, so no CSS can get in', () => {
    for (const bad of [null, undefined, '', 'red', '#fff', '#123456;}body{display:none', 'url(x)', 42]) {
      expect(brandPalette(bad)).toBeNull();
      expect(brandCss(bad)).toBe('');
    }
  });

  it('writes only hex values, behind :not([data-accent]), never for high contrast', () => {
    const css = brandCss('#1d4ed8');
    expect(css).toContain(":root:not([data-accent]):not([data-theme='contrast'])");
    expect(css).toContain(":root[data-theme='dark']:not([data-accent])");
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    for (const [, value] of css.matchAll(/--[a-z-]+: ([^;]+);/g)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('customAccentCss', () => {
  it('scopes the tokens to data-accent=custom and rejects anything but #rrggbb', async () => {
    const {customAccentCss} = await import('../src/lib/brand');
    const css = customAccentCss('#ef4444');
    expect(css).toContain(":root[data-accent='custom'] {");
    expect(css).toContain(":root[data-theme='dark'][data-accent='custom'] {");
    expect(css).toContain('--custom-swatch:');
    expect(customAccentCss('red; } body {')).toBe('');
  });
});
