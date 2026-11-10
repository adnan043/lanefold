import {describe, expect, it} from 'vitest';

import {newShareToken, shareUrl} from '../src/server/routes/board-share';
import {sha256Hex, TOKEN_PATTERN} from '../src/server/routes/public-board';

describe('board share token', () => {
  it('is 43 base64url characters and the public reader accepts it', () => {
    for (let i = 0; i < 200; i++) expect(newShareToken()).toMatch(TOKEN_PATTERN);
  });

  it('is unique across many draws', () => {
    const seen = new Set(Array.from({length: 1000}, newShareToken));
    expect(seen.size).toBe(1000);
  });

  it('hashes to 64 hex characters that never contain the token', async () => {
    const t = newShareToken();
    const h = await sha256Hex(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
  });

  it('builds the public address with a trailing slash', () => {
    const t = newShareToken();
    expect(shareUrl('https://x.test/', t)).toBe(`https://x.test/b/${t}/`);
  });
});
