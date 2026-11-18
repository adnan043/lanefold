import {describe, expect, it} from 'vitest';

import {checkRule, nextAfter, occurrence, onOrAfter, upcoming, type RepeatRule} from '../src/lib/recurrence';

const rule = (r: Partial<RepeatRule> & Pick<RepeatRule, 'frequency' | 'anchor'>): RepeatRule => ({interval: 1, endsOn: null, ...r});

describe('recurrence dates', () => {
  it('daily and weekly count from the anchor', () => {
    expect(nextAfter(rule({frequency: 'daily', anchor: '2026-11-01'}), '2026-11-01')).toBe('2026-11-02');
    expect(nextAfter(rule({frequency: 'daily', interval: 3, anchor: '2026-11-01'}), '2026-11-05')).toBe('2026-11-07');
    expect(nextAfter(rule({frequency: 'weekly', interval: 2, anchor: '2026-11-02'}), '2026-11-02')).toBe('2026-11-16');
    expect(nextAfter(rule({frequency: 'weekly', anchor: '2026-11-02'}), '2026-12-30')).toBe('2027-01-04');
  });

  it('a day before the anchor gives the anchor itself', () => {
    expect(nextAfter(rule({frequency: 'weekly', anchor: '2026-11-10'}), '2026-11-01')).toBe('2026-11-10');
    expect(onOrAfter(rule({frequency: 'weekly', anchor: '2026-11-10'}), '2026-11-10')).toBe('2026-11-10');
  });

  it('monthly keeps the anchor day and clamps without drifting', () => {
    const r = rule({frequency: 'monthly', anchor: '2026-01-31'});
    expect([1, 2, 3, 4].map(k => occurrence(r, k))).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
    expect(occurrence(r, 25)).toBe('2028-02-29');
    expect(nextAfter(r, '2026-02-28')).toBe('2026-03-31');
    expect(nextAfter(rule({frequency: 'monthly', interval: 12, anchor: '2024-02-29'}), '2024-03-01')).toBe('2025-02-28');
  });

  it('jumps over a long gap in one step and stays strictly after the day', () => {
    const r = rule({frequency: 'monthly', interval: 5, anchor: '2020-03-15'});
    for (const day of ['2026-11-04', '2026-11-15', '2030-01-01']) {
      const out = nextAfter(r, day)!;
      expect(out > day).toBe(true);
      const k = [...Array(80).keys()].find(i => occurrence(r, i) === out)!;
      expect(k).toBeGreaterThan(0);
      expect(occurrence(r, k - 1) <= day).toBe(true);
    }
    expect(nextAfter(rule({frequency: 'daily', anchor: '2000-01-01'}), '2026-11-04')).toBe('2026-11-05');
  });

  it('stops after the last day', () => {
    const r = rule({frequency: 'daily', anchor: '2026-11-01', endsOn: '2026-11-03'});
    expect(nextAfter(r, '2026-11-02')).toBe('2026-11-03');
    expect(nextAfter(r, '2026-11-03')).toBeNull();
    expect(upcoming(r, '2026-11-01', 10)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
  });
});

describe('checkRule', () => {
  const ok = {frequency: 'weekly', interval: 2, startOn: '2026-11-04', endsOn: null};
  it('accepts a good rule, today or yesterday as the first day', () => {
    expect(checkRule(ok, '2026-11-04').ok).toBe(true);
    expect(checkRule({...ok, startOn: '2026-11-03'}, '2026-11-04').ok).toBe(true);
    expect(checkRule({...ok, endsOn: '2026-12-01'}, '2026-11-04')).toMatchObject({ok: true, value: {endsOn: '2026-12-01'}});
  });
  it('names every wrong field', () => {
    expect(checkRule({frequency: 'hourly', interval: 0, startOn: '2026-02-30', endsOn: 'x'}, '2026-11-04')).toEqual({
      ok: false,
      fields: {frequency: 'invalid', interval: 'invalid', startOn: 'invalid', endsOn: 'invalid'},
    });
    expect(checkRule({...ok, interval: 100}, '2026-11-04')).toMatchObject({ok: false, fields: {interval: 'invalid'}});
    expect(checkRule({...ok, interval: 1.5}, '2026-11-04')).toMatchObject({ok: false});
    expect(checkRule({...ok, interval: '2'}, '2026-11-04')).toMatchObject({ok: false});
    expect(checkRule({...ok, startOn: '2026-11-01'}, '2026-11-04')).toMatchObject({ok: false, fields: {startOn: 'past'}});
    expect(checkRule({...ok, endsOn: '2026-11-01'}, '2026-11-04')).toMatchObject({ok: false, fields: {endsOn: 'before_start'}});
  });
  it('keeps a separate anchor so a monthly rule on the 31st does not drift after a short month', () => {
    // Card due Jan 31, "repeat monthly" chosen on Feb 5: first copy Feb 28, then back to the 31st.
    const r = checkRule({frequency: 'monthly', interval: 1, startOn: '2027-02-28', anchorOn: '2027-01-31', endsOn: null}, '2027-02-05');
    expect(r).toMatchObject({ok: true, value: {startOn: '2027-02-28', anchorOn: '2027-01-31'}});
    if (!r.ok) return;
    const rule: RepeatRule = {frequency: 'monthly', interval: 1, anchor: r.value.anchorOn, endsOn: null};
    expect(nextAfter(rule, '2027-02-28')).toBe('2027-03-31');
    expect(nextAfter(rule, '2027-03-31')).toBe('2027-04-30');
    expect(upcoming(rule, '2027-02-05', 3)).toEqual(['2027-02-28', '2027-03-31', '2027-04-30']);
  });
  it('defaults the anchor to the first day and refuses an anchor that does not fit', () => {
    const ok = {frequency: 'monthly', interval: 1, startOn: '2027-02-28', endsOn: null};
    expect(checkRule(ok, '2027-02-05')).toMatchObject({ok: true, value: {anchorOn: '2027-02-28'}});
    expect(checkRule({...ok, anchorOn: ''}, '2027-02-05')).toMatchObject({ok: true, value: {anchorOn: '2027-02-28'}});
    expect(checkRule({...ok, anchorOn: '2027-03-31'}, '2027-02-05')).toMatchObject({ok: false, fields: {anchorOn: 'invalid'}}); // after the first day
    expect(checkRule({...ok, anchorOn: '2027-02-31'}, '2027-02-05')).toMatchObject({ok: false, fields: {anchorOn: 'invalid'}});
    expect(checkRule({...ok, anchorOn: '2027-01-15'}, '2027-02-05')).toEqual({ok: false, fields: {startOn: 'off_rule'}}); // the 28th is not a day of a rule on the 15th
    expect(checkRule({...ok, frequency: 'weekly', startOn: '2027-02-12', anchorOn: '2027-01-29'}, '2027-02-05')).toMatchObject({ok: true}); // both Fridays
  });
});
