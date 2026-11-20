import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {describe, expect, it} from 'vitest';

/**
 * `src/platform/player/` is the platform's player (`packages/player` in the platform's repository),
 * copied in by `pnpm --filter @platform/player vendor` because a site is its own repository. On a
 * platform checkout the two must be the same file for file; a site's own copy has no
 * `packages/player` beside it and checks nothing here (`npm run platform -- check` covers it).
 */
const here = fileURLToPath(new URL('../src/platform/player/', import.meta.url));
const source = fileURLToPath(new URL('../../../packages/player/src/', import.meta.url));
const vendored = (name: string) => /\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name);

describe('the player', () => {
  it('is in src/platform/player', () => {
    expect(existsSync(`${here}video-player.tsx`)).toBe(true);
    expect(existsSync(`${here}player.css`)).toBe(true);
  });
});

describe.skipIf(!existsSync(source))('the vendored player', () => {
  it('is packages/player/src without its tests, byte for byte', () => {
    const want = readdirSync(source).filter(vendored).sort();
    expect(readdirSync(here).sort()).toEqual(want);
    for (const name of want) {
      expect(readFileSync(`${here}${name}`, 'utf8'), `${name}: run pnpm --filter @platform/player vendor`).toBe(
        readFileSync(`${source}${name}`, 'utf8')
      );
    }
  });
});
