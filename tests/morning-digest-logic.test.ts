import {describe, expect, it} from 'vitest';

import {digestDue, localParts, renderDigestEmail, validTimeZone} from '../src/server/jobs/morning-digest';

describe('morning digest: local day and hour', () => {
  it('reads the hour and day in the person\'s zone', () => {
    // 2026-11-04 01:30 UTC is 07:30 in Dhaka (UTC+6) and still 4 Nov, but 20:30 on 3 Nov in New York (UTC-5).
    const now = new Date('2026-11-04T01:30:00Z');
    expect(localParts(now, 'Asia/Dhaka')).toEqual({day: '2026-11-04', hour: 7});
    expect(localParts(now, 'America/New_York')).toEqual({day: '2026-11-03', hour: 20});
    expect(localParts(now, null)).toEqual({day: '2026-11-04', hour: 1});
  });
  it('treats an unknown zone as UTC and rejects it as a setting', () => {
    const now = new Date('2026-11-04T09:00:00Z');
    expect(localParts(now, 'Not/AZone')).toEqual({day: '2026-11-04', hour: 9});
    expect(validTimeZone('Not/AZone')).toBe(false);
    expect(validTimeZone('Asia/Dhaka')).toBe(true);
    expect(validTimeZone('')).toBe(false);
    expect(validTimeZone('x'.repeat(65))).toBe(false);
    expect(validTimeZone(42)).toBe(false);
  });
  it('midnight is hour 0, never 24', () => {
    expect(localParts(new Date('2026-11-04T00:10:00Z'), 'UTC').hour).toBe(0);
  });
});

describe('morning digest: who is due', () => {
  const at = (iso: string) => new Date(iso);
  it('is due from the chosen hour, once per local day', () => {
    const opts = {hour: 7, tz: 'UTC', lastOn: null};
    expect(digestDue(opts, at('2026-11-04T06:59:00Z')).due).toBe(false);
    expect(digestDue(opts, at('2026-11-04T07:00:00Z'))).toEqual({due: true, day: '2026-11-04'});
    expect(digestDue({...opts, lastOn: '2026-11-04'}, at('2026-11-04T08:00:00Z')).due).toBe(false);
    expect(digestDue({...opts, lastOn: '2026-11-03'}, at('2026-11-04T08:00:00Z')).due).toBe(true);
  });
  it('is off when no hour is set or the hour is out of range', () => {
    expect(digestDue({hour: null, tz: 'UTC', lastOn: null}, at('2026-11-04T09:00:00Z')).due).toBe(false);
    expect(digestDue({hour: 3, tz: 'UTC', lastOn: null}, at('2026-11-04T09:00:00Z')).due).toBe(false);
    expect(digestDue({hour: 13, tz: 'UTC', lastOn: null}, at('2026-11-04T15:00:00Z')).due).toBe(false);
  });
  it('is never made in the evening', () => {
    expect(digestDue({hour: 7, tz: 'UTC', lastOn: null}, at('2026-11-04T15:00:00Z')).due).toBe(false);
    expect(digestDue({hour: 7, tz: 'UTC', lastOn: null}, at('2026-11-04T14:30:00Z')).due).toBe(true);
  });
  it('follows the person\'s zone', () => {
    // 7 am in Dhaka is 01:00 UTC.
    const opts = {hour: 7, tz: 'Asia/Dhaka', lastOn: null};
    expect(digestDue(opts, at('2026-11-04T00:30:00Z')).due).toBe(false);
    expect(digestDue(opts, at('2026-11-04T01:05:00Z'))).toEqual({due: true, day: '2026-11-04'});
  });
});

describe('morning digest: email', () => {
  it('has counts only', () => {
    const mail = renderDigestEmail({due: 2, overdue: 1, mentions: 0}, 'https://x.test/app/my-day');
    expect(mail.subject).toBe('Your Lanefold morning: 2 cards due today, 1 overdue card');
    expect(mail.text).toContain('https://x.test/app/my-day');
    expect(mail.text).not.toContain('mention');
  });
  it('escapes the link in the html', () => {
    const mail = renderDigestEmail({due: 1, overdue: 0, mentions: 3}, 'https://x.test/a?b=1&c="2"');
    expect(mail.html).not.toContain('"2"');
    expect(mail.html).toContain('&amp;');
  });
});
