import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

/** A template upgrade leaves `prisma/schema.prisma` to you (docs/agent/upgrade.md): the managed code needs these. */
/** What `src/platform/player/` imports (Video.js 10), at the version it is written for. */
const PLAYER_PACKAGES = ['@videojs/react', '@videojs/hlsjs-video', '@videojs/youtube-video', '@videojs/vimeo-video'];

const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

describe('this site has what the managed code needs (docs/agent/upgrade.md)', () => {
  it('model User: platformOwnerId', () => {
    expect(schema).toMatch(/platformOwnerId\s+String\?\s+@unique\s+@map\("platform_owner_id"\)/);
  });
  it('model AuthState: ownerEnvId', () => {
    expect(schema).toMatch(/ownerEnvId\s+String\?\s+@map\("owner_env_id"\)/);
    expect(schema).toMatch(/model IdempotencyKey \{[^}]*@@map\("idempotency_keys"\)/);
    expect(readFileSync(new URL('../src/lib/checkout-session.ts', import.meta.url), 'utf8')).toContain('attemptKey(');
    expect(readFileSync(new URL('../src/server/routes/checkout.ts', import.meta.url), 'utf8')).toContain('idempotencyKey');
  });
  it('both generators: relationJoins', () => {
    expect(schema.match(/previewFeatures\s*=\s*\[[^\]]*"relationJoins"/g)?.length).toBe(2);
  });
  it('package.json: the player\'s packages (src/platform/player)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const name of PLAYER_PACKAGES) {
      expect(pkg.dependencies?.[name], `add "${name}": "10.3.0" to dependencies (upgrade.md, below 0.10.23)`).toBe('10.3.0');
    }
  });
});
