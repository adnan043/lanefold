import {describe, expect, it} from 'vitest';

import {cooldownMs, extendUntil, MAX_COOLDOWN_SECONDS, secondsLeft} from '../src/lib/cooldown';
import {dryRunMatches} from '../src/app/settings/import-binding';

describe('cooldown', () => {
  it('only a 429 with retryAfter waits, capped at 60 s', () => {
    expect(cooldownMs({status: 429, retryAfter: 5})).toBe(5000);
    expect(cooldownMs({status: 429, retryAfter: 300})).toBe(MAX_COOLDOWN_SECONDS * 1000);
    expect(cooldownMs({status: 429, retryAfter: 1.2})).toBe(2000);
    expect(cooldownMs({status: 429})).toBe(0);
    expect(cooldownMs({status: 429, retryAfter: 0})).toBe(0);
    expect(cooldownMs({status: 503, retryAfter: 5})).toBe(0);
    expect(cooldownMs(null)).toBe(0);
    expect(cooldownMs('x')).toBe(0);
  });
  it('counts seconds left and never shortens a wait', () => {
    expect(secondsLeft(10_000, 9_001)).toBe(1);
    expect(secondsLeft(10_000, 10_000)).toBe(0);
    expect(secondsLeft(10_000, 20_000)).toBe(0);
    expect(extendUntil(0, {status: 429, retryAfter: 10}, 1000)).toBe(11_000);
    expect(extendUntil(50_000, {status: 429, retryAfter: 1}, 1000)).toBe(50_000);
    expect(extendUntil(7, {status: 500}, 1000)).toBe(7);
  });
});

describe('dryRunMatches', () => {
  it('binds a dry run to its workspace', () => {
    expect(dryRunMatches({workspaceId: 1}, 1)).toBe(true);
    expect(dryRunMatches({workspaceId: 1}, 2)).toBe(false);
    expect(dryRunMatches({workspaceId: 1}, undefined)).toBe(false);
    expect(dryRunMatches(null, 1)).toBe(false);
  });
});
