import {readFileSync} from 'node:fs';

import {describe, expect, it, vi} from 'vitest';

import {createBatcher} from '../src/app/chat/card-ref-batch';
import {pulseDelayMs, windowDelayMs} from '../src/app/chat/poll-timing';

const MIN = 60_000;

describe('chat polling backoff', () => {
  it('pulses every 3 s in an open chat while active, slower the longer the person is away', () => {
    expect(pulseDelayMs(0, true)).toBe(3000);
    expect(pulseDelayMs(59_000, true)).toBe(3000);
    expect(pulseDelayMs(MIN, true)).toBe(12_000);
    expect(pulseDelayMs(5 * MIN, true)).toBe(30_000);
    expect(pulseDelayMs(15 * MIN, true)).toBe(60_000);
  });

  it('pulses every 30 s outside the chat (the unread badge), 60 s after a long idle', () => {
    expect(pulseDelayMs(0, false)).toBe(30_000);
    expect(pulseDelayMs(14 * MIN, false)).toBe(30_000);
    expect(pulseDelayMs(15 * MIN, false)).toBe(60_000);
  });

  it('refreshes the open window every 20 s while active, then every minute, then every 3 minutes', () => {
    expect(windowDelayMs(0)).toBe(20_000);
    expect(windowDelayMs(MIN)).toBe(MIN);
    expect(windowDelayMs(5 * MIN)).toBe(3 * MIN);
  });
});

describe('card chip batching', () => {
  it('asks once for every id requested in the same tick, 20 ids per request, null for ids not answered', async () => {
    const fetchChunk = vi.fn(async (ids: number[]) => ids.filter(id => id % 2 === 0).map(id => ({id})));
    const load = createBatcher(fetchChunk, (x: {id: number}) => x.id, 20);
    const ids = Array.from({length: 25}, (_, i) => i + 1);
    const results = await Promise.all([...ids, 2, 4].map(id => load(id)));
    expect(fetchChunk).toHaveBeenCalledTimes(2);
    expect(fetchChunk.mock.calls[0]![0]).toHaveLength(20);
    expect(fetchChunk.mock.calls[1]![0]).toEqual([21, 22, 23, 24, 25]);
    expect(results[0]).toBeNull();
    expect(results[1]).toEqual({id: 2});
    expect(results.slice(-2)).toEqual([{id: 2}, {id: 4}]);
    // A later tick is a new batch.
    await load(7);
    expect(fetchChunk).toHaveBeenCalledTimes(3);
  });

  it('rejects every waiter of a failed request', async () => {
    const load = createBatcher(async () => Promise.reject(new Error('down')), (x: {id: number}) => x.id);
    await expect(Promise.all([load(1), load(2)])).rejects.toThrow('down');
  });
});

describe('chat message toolbar keyboard access', () => {
  it('is hidden by opacity, never display:none, so its buttons stay in the tab order and :focus-visible reveals it', () => {
    const css = readFileSync(new URL('../src/app/chat/chat.css', import.meta.url), 'utf8');
    const rules = [...css.matchAll(/([^{}]*\.chat-msg-actions[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , body] of rules) expect(body).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(css).toMatch(/\.chat-msg:has\(:focus-visible\) \.chat-msg-actions/);
  });
});
