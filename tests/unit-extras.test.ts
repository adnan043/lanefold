import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {backgroundStyle} from '../src/app/boards/background';
import {faceExtras, withFaces, FACE_LABELS} from '../src/server/card-faces';
import {formatMoney, initials, formatDate} from '../src/lib/format';
import {jsonLdText, xmlEscape, absoluteUrl} from '../src/lib/seo';
import {addDays, addMonths, monthGrid, parseISODate, startOfWeek, todayISO, toISODate, weekday} from '../src/portal/ui/date';
import {bestScore, fuzzyScore} from '../src/portal/ui/fuzzy';
import {keepDays, nextCursor, cutoff} from '../src/server/jobs/logic';
import {computeEntitlements, type PlanLimits} from '../src/server/entitlements';

describe('xmlEscape / jsonLdText / absoluteUrl', () => {
  it('escapes all XML specials, & first (no double escape)', () => {
    expect(xmlEscape(`a&b<c>"d"`)).toBe('a&amp;b&lt;c&gt;&quot;d&quot;');
    expect(xmlEscape('&amp;')).toBe('&amp;amp;');
    expect(xmlEscape('')).toBe('');
  });
  it('JSON-LD cannot close the script tag', () => {
    const t = jsonLdText({name: '</script><script>alert(1)</script> <!-- & x'});
    expect(t).not.toContain('<');
    expect(t).not.toContain('>');
    expect(t).not.toContain('&');
    expect(JSON.parse(t).name).toBe('</script><script>alert(1)</script> <!-- & x');
  });
  it('absoluteUrl keeps https URLs', () => {
    expect(absoluteUrl('https://x.test/a.png')).toBe('https://x.test/a.png');
  });
});

describe('lib/format', () => {
  it('formatDate: null, empty and garbage give empty string; uses UTC', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate('')).toBe('');
    expect(formatDate('nope')).toBe('');
    expect(formatDate('2026-12-31T23:59:59Z')).toBe('31 December 2026');
    expect(formatDate('2026-01-01T00:00:00Z')).toBe('1 January 2026');
  });
  it('formatMoney handles zero-decimal and bad currencies', () => {
    expect(formatMoney(1999, 'USD')).toBe('$19.99');
    expect(formatMoney(1999, 'JPY')).toMatch(/1,999/);
    expect(formatMoney(0, 'USD')).toBe('$0.00');
    expect(formatMoney(-500, 'USD')).toContain('5.00');
    expect(formatMoney(1250, 'not-a-code')).toBe('12.50 not-a-code');
  });
  it('initials', () => {
    expect(initials('')).toBe('');
    expect(initials('   ')).toBe('');
    expect(initials('ada lovelace byron')).toBe('AL');
    expect(initials('  madonna ')).toBe('M');
    expect(initials('émile zola')).toBe('ÉZ');
  });
});

describe('backgroundStyle', () => {
  const node = () => ({style: {background: 'x'}}) as unknown as HTMLElement;
  it('does nothing for null', () => expect(() => backgroundStyle(null, {bgKind: 'solid', bgColor1: '#000000', bgColor2: '', bgAngle: 0})).not.toThrow());
  it('gradient clamps and rounds the angle; second colour falls back to the first', () => {
    const n = node();
    backgroundStyle(n, {bgKind: 'gradient', bgColor1: '#112233', bgColor2: 'bad', bgAngle: 721.6});
    expect(n.style.background).toBe('linear-gradient(360deg, #112233, #112233)');
    backgroundStyle(n, {bgKind: 'gradient', bgColor1: '#112233', bgColor2: '#aabbcc', bgAngle: -5});
    expect(n.style.background).toBe('linear-gradient(0deg, #112233, #aabbcc)');
  });
  it('rejects non-hex colours (no CSS injection) and falls to empty', () => {
    const n = node();
    backgroundStyle(n, {bgKind: 'solid', bgColor1: 'red; background:url(x)', bgColor2: '', bgAngle: 0});
    expect(n.style.background).toBe('');
    backgroundStyle(n, {bgKind: 'gradient', bgColor1: '#12345', bgColor2: '#123456', bgAngle: 10});
    expect(n.style.background).toBe('');
  });
  // Fixed: a non-finite angle now falls back to 0deg (was 'linear-gradient(NaNdeg, ...)', invalid CSS).
  it('NaN angle must not produce "NaNdeg"', () => {
    const n = node();
    backgroundStyle(n, {bgKind: 'gradient', bgColor1: '#112233', bgColor2: '#445566', bgAngle: NaN});
    expect(n.style.background).not.toContain('NaN');
  });
});

describe('date grid edge cases', () => {
  it('leap years and century rules', () => {
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2100-02-28', 1)).toBe('2100-03-01');
    expect(addDays('2000-02-28', 1)).toBe('2000-02-29');
    expect(parseISODate('2100-02-29')).toBeNull();
    expect(parseISODate('2026-13-01')).toBeNull();
    expect(parseISODate('2026-00-10')).toBeNull();
    expect(parseISODate('2026-1-1')).toBeNull();
    expect(parseISODate(20260101)).toBeNull();
  });
  it('addMonths across years, negatives, month end', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-03-31', -13)).toBe('2025-02-28');
    expect(addMonths('2026-05-10', 0)).toBe('2026-05-10');
    expect(addMonths('2026-05-10', 120)).toBe('2036-05-10');
  });
  it('monthGrid: every week-start gives full rows, contains the month, 7 columns', () => {
    for (let start = 0; start < 7; start++) {
      for (const [y, m] of [[2026, 2], [2026, 11], [2024, 2], [2026, 3], [2021, 2]] as const) {
        const g = monthGrid(y, m, start);
        expect(g.length).toBeGreaterThanOrEqual(4);
        expect(g.length).toBeLessThanOrEqual(6);
        expect(g.every(w => w.length === 7)).toBe(true);
        expect(weekday(g[0]![0]!)).toBe(start);
        const flat = g.flat();
        expect(flat).toContain(toISODate(y, m, 1));
        expect(flat).toContain(toISODate(y, m + 1, 0));
        // strictly consecutive days
        flat.forEach((d, i) => i && expect(addDays(flat[i - 1]!, 1)).toBe(d));
      }
    }
  });
  it('Feb 2021 starting Monday is exactly 4 rows', () => {
    expect(monthGrid(2021, 2, 1)).toHaveLength(4);
  });
  it('startOfWeek at year boundary', () => {
    expect(startOfWeek('2027-01-01', 1)).toBe('2026-12-28');
    expect(startOfWeek('2026-11-02', 1)).toBe('2026-11-02');
    expect(startOfWeek('2026-11-01', 1)).toBe('2026-10-26');
    expect(startOfWeek('2026-11-01', 0)).toBe('2026-11-01');
    expect(startOfWeek('2026-11-01', 6)).toBe('2026-10-31');
  });
  it('invalid input throws RangeError', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => weekday('')).toThrow(RangeError);
  });
  it('toISODate: low years are not mapped to 19xx', () => {
    expect(toISODate(50, 1, 1)).toBe('0050-01-01');
  });
  it('DST days are 24h in ISO arithmetic (stepping over a transition never skips or repeats)', () => {
    let d = '2026-03-01';
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      expect(seen.has(d)).toBe(false);
      seen.add(d);
      d = addDays(d, 1);
    }
    expect(d).toBe('2027-04-05');
  });
  describe('todayISO in other zones', () => {
    const orig = process.env.TZ;
    afterEach(() => {
      if (orig === undefined) delete process.env.TZ;
      else process.env.TZ = orig;
    });
    it('uses the local calendar day, not UTC', () => {
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
      expect(todayISO(new Date('2026-11-02T20:00:00Z'))).toBe('2026-11-03');
      process.env.TZ = 'Pacific/Pago_Pago'; // UTC-11
      expect(todayISO(new Date('2026-11-02T05:00:00Z'))).toBe('2026-11-01');
    });
    it('on a spring-forward day', () => {
      process.env.TZ = 'America/New_York';
      expect(todayISO(new Date('2026-03-08T12:00:00-04:00'))).toBe('2026-03-08');
    });
  });
});

describe('fuzzy edge cases', () => {
  it('blank query matches everything with 0', () => {
    expect(fuzzyScore('   ', 'anything')).toBe(0);
    expect(fuzzyScore('', '')).toBe(0);
  });
  it('is case insensitive and order dependent', () => {
    expect(fuzzyScore('GB', 'Go to Board')).not.toBeNull();
    expect(fuzzyScore('bg', 'go board')).toBeNull();
  });
  it('prefix beats mid match; shorter text beats longer', () => {
    expect(fuzzyScore('boa', 'Board')!).toBeGreaterThan(fuzzyScore('boa', 'My board')!);
    expect(fuzzyScore('boa', 'Board')!).toBeGreaterThan(fuzzyScore('boa', 'Board settings page')!);
  });
  it('word-start subsequence beats scattered one', () => {
    expect(fuzzyScore('nb', 'new board')!).toBeGreaterThan(fuzzyScore('nb', 'announcement bar')!);
  });
  it('query longer than text, unicode', () => {
    expect(fuzzyScore('abcdef', 'abc')).toBeNull();
    expect(fuzzyScore('é', 'Café')).not.toBeNull();
    expect(fuzzyScore('日本', '日本語')).not.toBeNull();
  });
  it('bestScore ignores empty fields and weights by position', () => {
    expect(bestScore('x', [undefined, '', 'nothing'])).toBeNull();
    const label = bestScore('inv', ['invite', 'invite'])!;
    const hint = bestScore('inv', ['zzz', 'invite'])!;
    expect(label).toBeGreaterThan(hint);
    expect(bestScore('', ['a'])).toBe(0);
  });
});

describe('jobs logic edge cases', () => {
  it('keepDays clamps and rejects non-numbers', () => {
    expect(keepDays(0, 30)).toBe(7);
    expect(keepDays(-1, 30)).toBe(7);
    expect(keepDays(1e9, 30)).toBe(3650);
    expect(keepDays(Infinity, 30)).toBe(30);
    expect(keepDays('90', 30)).toBe(30);
    expect(keepDays(null, 30)).toBe(30);
    expect(keepDays(NaN, 30)).toBe(30);
    expect(keepDays(45.9, 30)).toBe(45);
  });
  it('nextCursor handles bigint, exact page size and empty', () => {
    expect(nextCursor([], 2)).toBeNull();
    expect(nextCursor([{id: 1}], 2)).toBeNull();
    expect(nextCursor([{id: 1}, {id: 9n}], 2)).toBe(9);
  });
  it('cutoff', () => {
    expect(cutoff(Date.parse('2026-11-02T00:00:00Z'), 1).toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('computeEntitlements edge cases', () => {
  const PLAN: PlanLimits = {plan: 'pro', maxMembers: 5, maxFileBytes: 1, storageQuotaBytes: 100, maxFlows: 0, auditLog: false};
  const ws = (o = {}) => ({id: 1, plan: 'pro', memberCount: 0, storageUsedBytes: 0, graceUntil: null as Date | null, ...o});
  const NOW = new Date('2026-11-02T00:00:00Z');
  it('exactly at the limit is not over; one past is', () => {
    expect(computeEntitlements({limits: PLAN, workspace: ws({memberCount: 5, storageUsedBytes: 100}), mode: 'PAID', now: NOW}).overLimit).toBe(false);
    expect(computeEntitlements({limits: PLAN, workspace: ws({storageUsedBytes: 101}), mode: 'PAID', now: NOW}).overLimit).toBe(true);
  });
  it('over with no grace clock started: in grace, never read-only, graceUntil null', () => {
    const e = computeEntitlements({limits: PLAN, workspace: ws({memberCount: 6}), mode: 'PAID', now: NOW});
    expect(e).toMatchObject({inGrace: true, readOnly: false, graceUntil: null});
  });
  it('grace ending exactly now is over', () => {
    const e = computeEntitlements({limits: PLAN, workspace: ws({memberCount: 6, graceUntil: NOW}), mode: 'PAID', now: NOW});
    expect(e.readOnly).toBe(true);
    expect(e.inGrace).toBe(false);
  });
  it('flows feature follows maxFlows; FREE_FOR_ALL unlocks all', () => {
    expect(computeEntitlements({limits: PLAN, workspace: ws(), mode: 'PAID', now: NOW}).features).toEqual({auditLog: false, flows: false});
    expect(computeEntitlements({limits: PLAN, workspace: ws(), mode: 'FREE_FOR_ALL', now: NOW}).features).toEqual({auditLog: true, flows: true});
  });
  it('FREE_FOR_ALL never reports upgradeUi', () => {
    expect(computeEntitlements({limits: PLAN, workspace: ws({memberCount: 9999}), mode: 'FREE_FOR_ALL', now: NOW}).upgradeUi).toBe(false);
  });
});

describe('card-faces shaping', () => {
  const mkDb = (labels: unknown[], members: unknown[], covers: unknown[]) => {
    const q = vi.fn();
    q.mockResolvedValueOnce(labels).mockResolvedValueOnce(members).mockResolvedValueOnce(covers);
    return {db: {$queryRaw: q} as never, q};
  };
  it('no ids: no query at all', async () => {
    const {db, q} = mkDb([], [], []);
    expect((await faceExtras(db, 1, [])).size).toBe(0);
    expect((await faceExtras(db, 1, [0, -4])).size).toBe(0);
    expect(q).not.toHaveBeenCalled();
  });
  it('runs three queries and folds bigint totals', async () => {
    const {db, q} = mkDb(
      [{card_id: 1, id: 10, name: 'Bug', color_hex: '#ff0000', total: 6n}],
      [{card_id: 1, user_id: 7, name: 'Ada', total: 1n}],
      [{card_id: 2, id: 55}]
    );
    const m = await faceExtras(db, 3, [1, 1, 2]);
    expect(q).toHaveBeenCalledTimes(3);
    expect(m.get(1)).toEqual({labels: [{id: 10, name: 'Bug', colorHex: '#ff0000'}], labelCount: 6, members: [{id: 7, name: 'Ada'}], memberCount: 1, coverAttachmentId: null});
    expect(m.get(2)?.coverAttachmentId).toBe(55);
    expect(FACE_LABELS).toBeGreaterThan(0);
  });
  // Fixed: each card without extras gets its own empty arrays (they used to share EMPTY's, so a push leaked across cards).
  it('withFaces gives untouched cards an empty face and does not share arrays between cards', async () => {
    const {db} = mkDb([], [], []);
    const cards = await withFaces(db, 1, [{id: 1}, {id: 2}]);
    expect(cards[0]).toMatchObject({labels: [], members: [], labelCount: 0, coverAttachmentId: null});
    cards[0]!.labels.push({id: 1, name: 'x', colorHex: '#000000'});
    expect(cards[1]!.labels).toEqual([]);
  });
});
