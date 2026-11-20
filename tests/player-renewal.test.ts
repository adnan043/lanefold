import {describe, expect, it} from 'vitest';

import {createLinkRenewal, linkLifetimeSeconds, type PlaybackLink} from '../src/platform/player/link-renewal';

const T0 = Date.parse('2030-01-01T00:00:00Z');

/** A renewal on a hand-moved clock: `advance(ms)` fires what came due. */
function keeper(playing = true) {
  let now = T0;
  let timer: {at: number; fn: () => void} | null = null;
  const asked: number[] = [];
  const swapped: PlaybackLink[] = [];
  const k = createLinkRenewal({
    link: {src: 'https://v.example/a.m3u8?t=1', expiresAt: new Date(T0 + 30 * 60_000).toISOString()},
    renew: async () => {
      asked.push(now);
      return {src: `https://v.example/a.m3u8?t=${asked.length + 1}`, expiresAt: new Date(now + 30 * 60_000).toISOString()};
    },
    swap: link => swapped.push(link),
    isPlaying: () => playing,
    now: () => now,
    setTimer: (fn, ms) => (timer = {at: now + ms, fn}),
    clearTimer: () => (timer = null),
  });
  return {
    k,
    asked,
    swapped,
    async advance(ms: number) {
      now += ms;
      if (timer && timer.at <= now) {
        const t = timer;
        timer = null;
        t.fn();
      }
      await new Promise(r => setTimeout(r, 0));
    },
  };
}

describe('the player keeps a platform link fresh (src/platform/player/link-renewal.ts)', () => {
  it('a link lasts clamp(1.2 × length + 10 min, 30 min, 4 h)', () => {
    expect(linkLifetimeSeconds(10 * 60)).toBe(30 * 60);
    expect(linkLifetimeSeconds(3600)).toBe(4920);
    expect(linkLifetimeSeconds(10 * 3600)).toBe(4 * 3600);
  });

  it('asks for a fresh link about 2 minutes before it ends, while playing', async () => {
    const s = keeper();
    await s.advance(27 * 60_000);
    expect(s.asked).toHaveLength(0);
    await s.advance(60_000);
    expect(s.asked).toEqual([T0 + 28 * 60_000]);
    expect(s.swapped[0]?.src).toBe('https://v.example/a.m3u8?t=2');
    s.k.stop();
  });

  it('asks at once when a part of the video is refused (403)', async () => {
    const s = keeper();
    expect(s.k.failed({data: {response: {code: 403}}})).toBe(true);
    await s.advance(0);
    expect(s.asked).toHaveLength(1);
    expect(s.swapped).toHaveLength(1);
    s.k.stop();
  });

  it('a paused video gets its fresh link on the next play', async () => {
    const s = keeper(false);
    await s.advance(29 * 60_000);
    expect(s.asked).toHaveLength(0);
    s.k.played();
    await s.advance(0);
    expect(s.asked).toHaveLength(1);
    s.k.stop();
  });
});
