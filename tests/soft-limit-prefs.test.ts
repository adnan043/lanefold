import {beforeEach, describe, expect, it, vi} from 'vitest';

const store = new Map<string, {v: unknown; ttl: number}>();
vi.mock('../src/platform/cache', () => ({
  cache: {
    get: async (k: string) => store.get(k)?.v ?? null,
    set: async (k: string, v: unknown, ttl: number) => void store.set(k, {v, ttl}),
  },
  userKey: (id: number | string, k: string) => `u:${id}:${k}`,
}));
vi.mock('../src/app/settings/settings.css', () => ({}));
vi.mock('../src/app/settings/accents.css', () => ({}));

import {softCount, softHit, softLimited} from '../src/server/soft-limit';
import * as prefs from '../src/app/settings/prefs';

describe('soft limit', () => {
  beforeEach(() => {
    store.clear();
    vi.useRealTimers();
  });
  it('allows max hits then refuses, per user and name', async () => {
    expect(await softLimited(1, 'a', 2, 60)).toBe(false);
    expect(await softLimited(1, 'a', 2, 60)).toBe(false);
    expect(await softLimited(1, 'a', 2, 60)).toBe(true);
    expect(await softLimited(2, 'a', 2, 60)).toBe(false);
    expect(await softLimited(1, 'b', 2, 60)).toBe(false);
  });
  it('max 0 always limits and never records', async () => {
    expect(await softLimited(1, 'z', 0, 60)).toBe(true);
    expect(await softCount(1, 'z', 60)).toBe(0);
  });
  it('a new window resets the count; TTL is at least 60 s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
    await softHit(1, 'w', 10);
    expect(await softCount(1, 'w', 10)).toBe(1);
    expect([...store.values()][0]!.ttl).toBe(60);
    vi.setSystemTime(new Date('2026-11-02T10:00:10Z'));
    expect(await softCount(1, 'w', 10)).toBe(0);
  });
  it('TTL follows long windows', async () => {
    await softHit(1, 'long', 3600);
    expect([...store.values()][0]!.ttl).toBe(3600);
  });
});

describe('stored prefs parsing', () => {
  const data = new Map<string, string>();
  const attrs: Record<string, string> = {};
  beforeEach(() => {
    data.clear();
    for (const k of Object.keys(attrs)) delete attrs[k];
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    vi.stubGlobal('document', {documentElement: {dataset: attrs}});
  });
  it('defaults when nothing stored', () => {
    expect(prefs.storedTheme()).toBe('system');
    expect(prefs.storedDensity()).toBe('comfortable');
    expect(prefs.storedAccent()).toBe('brand');
    expect(prefs.storedFontScale()).toBe('100');
    expect(prefs.storedReduceMotion()).toBe(false);
  });
  it('corrupt / hostile stored values fall back', () => {
    data.set('lf:theme', '{"a":');
    data.set('lf:density', 'huge');
    data.set('lf:accent', '__proto__');
    data.set('lf:font', '999');
    data.set('lf:motion', 'true');
    expect(prefs.storedTheme()).toBe('system');
    expect(prefs.storedDensity()).toBe('comfortable');
    expect(prefs.storedAccent()).toBe('brand');
    expect(prefs.storedFontScale()).toBe('100');
    expect(prefs.storedReduceMotion()).toBe(false);
  });
  it('falls back to the site theme key, but lf:theme wins', () => {
    data.set('site:theme', 'dark');
    expect(prefs.storedTheme()).toBe('dark');
    data.set('lf:theme', 'contrast');
    expect(prefs.storedTheme()).toBe('contrast');
  });
  it('an invalid lf:theme hides a valid site:theme (falls to system)', () => {
    data.set('lf:theme', 'bogus');
    data.set('site:theme', 'dark');
    expect(prefs.storedTheme()).toBe('system');
  });
  it('storage that throws is survived', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    });
    expect(prefs.storedTheme()).toBe('system');
    expect(() => prefs.applyTheme('dark')).not.toThrow();
    expect(attrs.theme).toBe('dark');
    expect(() => prefs.applyStoredPrefs()).not.toThrow();
  });
  it('apply* round trip and defaults clear storage', () => {
    prefs.applyTheme('dark');
    expect(data.get('lf:theme')).toBe('dark');
    expect(data.get('site:theme')).toBe('dark');
    prefs.applyTheme('contrast');
    expect(data.has('site:theme')).toBe(false);
    prefs.applyTheme('system');
    expect(attrs.theme).toBeUndefined();
    expect(data.has('lf:theme')).toBe(false);
    prefs.applyAccent('rose');
    prefs.applyFontScale('125');
    prefs.applyReduceMotion(true);
    prefs.applyDensity('compact');
    for (const k of Object.keys(attrs)) delete attrs[k];
    prefs.applyStoredPrefs();
    expect(attrs).toMatchObject({accent: 'rose', font: '125', motion: 'reduce', density: 'compact'});
    prefs.applyAccent('brand');
    prefs.applyFontScale('100');
    prefs.applyReduceMotion(false);
    expect([...data.keys()].filter(k => ['lf:accent', 'lf:font', 'lf:motion'].includes(k))).toEqual([]);
  });
  it('custom accent: any #rrggbb, kept, restored at boot; bad values fall back to brand', () => {
    prefs.applyCustomAccent('#EF4444');
    expect(attrs.accent).toBe('custom');
    expect(data.get('lf:accent')).toBe('custom');
    expect(data.get('lf:accent-custom')).toBe('#ef4444');
    expect(prefs.storedAccent()).toBe('custom');
    for (const k of Object.keys(attrs)) delete attrs[k];
    expect(() => prefs.applyStoredPrefs()).not.toThrow();
    expect(attrs.accent).toBe('custom');
    prefs.applyAccent('rose');
    expect(prefs.storedCustomAccent()).toBe('#ef4444');
    prefs.applyAccent('custom');
    expect(attrs.accent).toBe('custom');
    prefs.applyCustomAccent('red; } body {');
    expect(data.get('lf:accent-custom')).toBe('#ef4444');
    data.set('lf:accent-custom', 'url(x)');
    expect(prefs.storedAccent()).toBe('brand');
  });
  it('type guards reject non-strings', () => {
    expect(prefs.isThemeMode(null)).toBe(false);
    expect(prefs.isThemeMode('toString')).toBe(false);
    expect(prefs.isDensity(1)).toBe(false);
    expect(prefs.isDensity('compact')).toBe(true);
  });
});
