import {beforeAll, describe, expect, it} from 'vitest';

import {app} from '../src/server/app';
import {publicName, sha256Hex, TOKEN_PATTERN} from '../src/server/routes/public-board';
import {Browser, configureEnv} from './integration/support/harness';

describe('public board helpers', () => {
  it('accepts only 43 base64url characters', () => {
    expect(TOKEN_PATTERN.test('A'.repeat(43))).toBe(true);
    expect(TOKEN_PATTERN.test('a-_Z0'.repeat(8) + 'abc')).toBe(true);
    for (const bad of ['', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + '+', 'A'.repeat(42) + '/', 'A'.repeat(42) + '=', '../'.repeat(15)]) {
      expect(TOKEN_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('hashes to 64 hex characters, deterministically', async () => {
    const h = await sha256Hex('abc');
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('abc')).toBe(h);
  });

  it('shows first name and last initial, never an email', () => {
    expect(publicName('Maria Khan')).toBe('Maria K.');
    expect(publicName('  Ana   de la Cruz ')).toBe('Ana C.');
    expect(publicName('Cher')).toBe('Cher');
    expect(publicName('maria@example.com')).toBeNull();
    expect(publicName('   ')).toBeNull();
    expect(publicName('Maria maria@example.com')).toBeNull();
    expect(publicName(null)).toBeNull();
  });
});

describe('GET /site-api/public/boards/:token', () => {
  beforeAll(configureEnv);

  it('answers 404 for a malformed token, with noindex and no-referrer headers and no session cookie', async () => {
    const res = await new Browser(app).get('/site-api/public/boards/not-a-token');
    // 503 only when the test environment has no database (withDb runs first).
    expect([404, 503]).toContain(res.status);
    if (res.status === 404) {
      expect(res.headers.get('x-robots-tag')).toContain('noindex');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).not.toContain('public');
      // The app-wide csrf middleware (managed) may set its double-submit cookie; no session or refresh cookie may appear.
      const cookies = res.headers.getSetCookie().map(x => x.split('=')[0]!);
      expect(cookies.filter(n => !/csrf/i.test(n))).toEqual([]);
    }
  });
});
