import {existsSync, readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('public/manifest.webmanifest', root), 'utf8'));

describe('PWA manifest', () => {
  it('is installable and scoped to /app/', () => {
    expect(manifest.name).toBe('Lanefold');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/app/');
    expect(manifest.scope).toBe('/app/');
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('has 192 and 512 icons plus a maskable one, all existing files', () => {
    const sizes = manifest.icons.map((i: {sizes: string}) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(manifest.icons.some((i: {purpose: string}) => i.purpose === 'maskable')).toBe(true);
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/')).toBe(true);
      expect(existsSync(new URL(`public${icon.src}`, root))).toBe(true);
    }
  });

  it('is linked from the app layout only for /app, with the apple icon', () => {
    const layout = readFileSync(new URL('src/layouts/App.astro', root), 'utf8');
    expect(layout).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(layout).toContain("startsWith('/app')");
    expect(layout).toContain('apple-touch-icon');
    expect(existsSync(new URL('public/icons/apple-touch-icon.png', root))).toBe(true);
  });

  it('ships no service worker (authenticated API data must never be cached)', () => {
    expect(existsSync(new URL('public/sw.js', root))).toBe(false);
  });
});
