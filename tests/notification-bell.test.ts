import {describe, expect, it} from 'vitest';

import {BELL_IDLE_MS, bellInterval} from '../src/app/notifications/bell';

describe('notification bell polling', () => {
  it('polls every 30 s while the person is active', () => {
    expect(bellInterval(0, false)).toBe(30_000);
    expect(bellInterval(BELL_IDLE_MS - 1, false)).toBe(30_000);
  });

  it('backs off while idle, doubling up to 5 minutes', () => {
    expect(bellInterval(BELL_IDLE_MS, false)).toBe(60_000);
    expect(bellInterval(2 * BELL_IDLE_MS, false)).toBe(120_000);
    expect(bellInterval(4 * BELL_IDLE_MS, false)).toBe(240_000);
    expect(bellInterval(8 * BELL_IDLE_MS, false)).toBe(300_000);
    expect(bellInterval(24 * 60 * 60_000, false)).toBe(300_000);
  });

  it('waits at least a minute after a failed read', () => {
    expect(bellInterval(0, true)).toBe(60_000);
    expect(bellInterval(8 * BELL_IDLE_MS, true)).toBe(300_000);
  });
});
