import {beforeEach, describe, expect, it, vi} from 'vitest';

// Regression tests for the 2026-11 security audit fixes that need no database.
const cfg = vi.hoisted(() => ({production: false, siteUrl: null as string | null, jwtSecret: 'x'.repeat(40)}));
vi.mock('../src/platform/config', () => ({config: cfg}));

import {isSensitive} from '../src/platform/cache-guard';
import {modeGrants} from '../src/server/payments-hooks';
import {linkOrigin} from '../src/server/site-origin';

beforeEach(() => {
  cfg.production = false;
  cfg.siteUrl = null;
});

describe('modeGrants: test payments never grant a plan on the live site', () => {
  it('grants test and live payments outside production', () => {
    expect(modeGrants('test')).toBe(true);
    expect(modeGrants('live')).toBe(true);
    expect(modeGrants(undefined)).toBe(true);
  });
  it('grants only live payments in production', () => {
    cfg.production = true;
    expect(modeGrants('live')).toBe(true);
    expect(modeGrants('test')).toBe(false);
    expect(modeGrants(undefined)).toBe(false);
    expect(modeGrants(null)).toBe(false);
  });
});

describe('linkOrigin: invite and share links never take the request host on the live site', () => {
  it('uses SITE_URL whenever it is set', () => {
    cfg.siteUrl = 'https://app.example.com';
    expect(linkOrigin('https://evil.example/site-api/x')).toBe('https://app.example.com');
    cfg.production = true;
    expect(linkOrigin('https://evil.example/site-api/x')).toBe('https://app.example.com');
  });
  it('falls back to the request origin only outside production', () => {
    expect(linkOrigin('http://localhost:4321/site-api/x')).toBe('http://localhost:4321');
    cfg.production = true;
    expect(() => linkOrigin('https://evil.example/site-api/x')).toThrow(/SITE_URL/);
  });
});

describe('per-address rate-limit keys are accepted by the Site Cache', () => {
  // A key segment of 20+ hex digits looks like a token: the cache refuses the write and the limit silently stops.
  const hex = 'a3f09b12c4d5e6f708192a3b4c5d6e7f80912a3b';
  it('refuses the old 40-digit form (why the keys are short)', () => {
    expect(isSensitive(`pubmiss:${hex}`, '1')).toBe(true);
  });
  it('accepts the 16-digit form used by public-board and ipLimited', () => {
    expect(isSensitive(`pubmiss:${hex.slice(0, 16)}`, '1')).toBe(false);
    expect(isSensitive(`pubview:${hex.slice(0, 16)}`, '1')).toBe(false);
    expect(isSensitive(`rl:ip:checkout-start:${hex.slice(0, 16)}:2958461`, '1')).toBe(false);
  });
});

describe('ipLimited counts and stops', () => {
  it('allows max calls per window, then refuses', async () => {
    const store = new Map<string, unknown>();
    vi.doMock('../src/platform/cache', () => ({
      cache: {
        get: async (k: string) => (isSensitive(k, '1') ? null : (store.get(k) ?? null)),
        set: async (k: string, v: unknown) => (isSensitive(k, JSON.stringify(v)) ? false : (store.set(k, v), true)),
      },
      userKey: (id: number, rest: string) => `user:${id}:${rest}`,
    }));
    vi.resetModules();
    const {ipLimited} = await import('../src/server/soft-limit');
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push(await ipLimited('203.0.113.9', 'test', 3, 600));
    expect(results).toEqual([false, false, false, true]);
    // Another address has its own budget.
    expect(await ipLimited('203.0.113.10', 'test', 3, 600)).toBe(false);
    vi.doUnmock('../src/platform/cache');
  });
});
