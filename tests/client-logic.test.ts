import {describe, expect, it} from 'vitest';

import type {BoardData, CardT, LaneT} from '../src/app/api';
import {appendCards, applyChanges, insertCard, mergeLanePage, moveCardInLanes, moveLaneInList, nextCursor, patchCard, removeCard} from '../src/app/board-state';
import {totalUnread, displayName} from '../src/app/chat/api';
import {cardTagAt, dayKey, insertMention, matchPeople, mentionAt, mentionedIds, removeCardTag, segments} from '../src/app/chat/mentions';
import {INTENT_TEMPLATE, TEMPLATES} from '../src/app/templates';
import {interpolate, lookup, pluralCategory, translate} from '../src/i18n/core';
import {formatDate, formatNumber, formatRelative} from '../src/i18n/format';
import {LOCALES, dirOf, isLocale} from '../src/i18n/locales';
import {matchLocale, parseAcceptLanguage, readLocaleCookie, resolveLocale} from '../src/i18n/resolve';
import {AUTH_RULES, rules} from '../src/lib/rules';
import {textField, intField, likeEscape} from '../src/server/validation';
import {PASSWORD_LIMITS} from '../src/platform/auth/password';
import en from '../src/i18n/messages/en.json';

const card = (id: number, laneId: number, position: string, extra: Partial<CardT> = {}): CardT => ({
  id, laneId, title: `c${id}`, position, priority: 'none', dueDate: null, completed: false,
  checklistTotal: 0, checklistDone: 0, commentCount: 0, attachmentCount: 0, archived: false, ...extra,
});
const lane = (id: number, position: string, cards: CardT[], extra: Partial<LaneT> = {}): LaneT => ({
  id, name: `L${id}`, position, colorHex: null, wipLimit: null, cardCount: cards.length, collapsed: false,
  archived: false, rev: '1', cards, loaded: true, hasMore: false, ...extra,
});
const data = (lanes: LaneT[]): BoardData => ({
  board: {id: 1, workspaceId: 1, name: 'B', visibility: 'workspace', bgKind: 'color', bgColor1: '#FFFFFF', bgColor2: '#000000', bgAngle: 0,
    bgPattern: 'none', archived: false, rev: '1', starred: false, role: 'admin', canWrite: true, canAdmin: true},
  lanes,
});
const delta = (lanes: unknown[], cards: CardT[], rev = '2') => ({rev, archived: false, truncated: false, lanes, cards}) as never;

describe('board state edge cases', () => {
  it('moveCardInLanes: unknown card is a no-op; index is clamped; same-lane move keeps counts', () => {
    const lanes = [lane(1, 'a0', [card(1, 1, 'a0'), card(2, 1, 'a1'), card(3, 1, 'a2')])];
    expect(moveCardInLanes(lanes, 99, 1, 0)).toBe(lanes);
    expect(moveCardInLanes(lanes, 1, 1, 99, 'a3')[0]!.cards.map(c => c.id)).toEqual([2, 3, 1]);
    expect(moveCardInLanes(lanes, 3, 1, -5)[0]!.cards.map(c => c.id)).toEqual([3, 1, 2]);
    expect(moveCardInLanes(lanes, 1, 1, 2)[0]!.cardCount).toBe(3);
  });
  it('moveCardInLanes to a missing lane is a no-op (the card stays where it was)', () => {
    const lanes = [lane(1, 'a0', [card(1, 1, 'a0')])];
    const out = moveCardInLanes(lanes, 1, 77, 0);
    expect(out[0]!.cards).toHaveLength(1);
  });
  it('moveLaneInList: missing lane no-op, position applied', () => {
    const lanes = [lane(1, 'a0', []), lane(2, 'a1', [])];
    expect(moveLaneInList(lanes, 9, 0)).toBe(lanes);
    expect(moveLaneInList(lanes, 2, 0, 'Zz')[0]).toMatchObject({id: 2, position: 'Zz'});
  });
  it('removeCard never goes below zero; patchCard touches only that card', () => {
    const lanes = [lane(1, 'a0', [card(1, 1, 'a0')], {cardCount: 0})];
    expect(removeCard(lanes, 1)[0]!.cardCount).toBe(0);
    expect(removeCard(lanes, 5)).toBe(lanes);
    const patched = patchCard([lane(1, 'a0', [card(1, 1, 'a0'), card(2, 1, 'a1')])], 2, {title: 'x'});
    expect(patched[0]!.cards.map(c => c.title)).toEqual(['c1', 'x']);
  });
  it('insertCard: undo of archive lands at its key, is idempotent, skipped beyond a partial window', () => {
    const lanes = [lane(1, 'a0', [card(1, 1, 'a0'), card(3, 1, 'a2')])];
    const back = insertCard(lanes, card(2, 1, 'a1'));
    expect(back[0]!.cards.map(c => c.id)).toEqual([1, 2, 3]);
    expect(back[0]!.cardCount).toBe(3);
    expect(insertCard(back, card(2, 1, 'a1'))).toEqual(back);
    const partial = [lane(1, 'a0', [card(1, 1, 'a0')], {hasMore: true, cardCount: 9})];
    const far = insertCard(partial, card(8, 1, 'zz'));
    expect(far[0]!.cards.map(c => c.id)).toEqual([1]);
    expect(far[0]!.cardCount).toBe(10);
  });
  it('appendCards dedupes by id and skips the list when more are unloaded', () => {
    const lanes = [lane(1, 'a0', [card(1, 1, 'a0')])];
    const out = appendCards(lanes, 1, [card(1, 1, 'a0'), card(2, 1, 'a1')]);
    expect(out[0]!.cards.map(c => c.id)).toEqual([1, 2]);
    expect(out[0]!.cardCount).toBe(2);
    expect(appendCards([lane(1, 'a0', [], {hasMore: true})], 1, [card(5, 1, 'a1')])[0]!.cards).toEqual([]);
  });
  it('mergeLanePage merges without duplicates and sets the cursor', () => {
    const l = lane(1, 'a0', [card(1, 1, 'a0')], {loaded: false, hasMore: true});
    const out = mergeLanePage([l], 1, [card(1, 1, 'a0'), card(2, 1, 'a1')], false)[0]!;
    expect(out.cards.map(c => c.id)).toEqual([1, 2]);
    expect(out).toMatchObject({loaded: true, hasMore: false});
    expect(nextCursor(out)).toBe('a1|2');
    expect(nextCursor(lane(1, 'a0', []))).toBe('');
  });
  it('applyChanges: a card moving between lanes in one delta leaves no ghost; archived lane drops', () => {
    const base = data([lane(1, 'a0', [card(1, 1, 'a0')]), lane(2, 'a1', [card(2, 2, 'a0')])]);
    const out = applyChanges(base, delta([{...lane(2, 'a1', []), cards: undefined, archived: true}], [card(1, 2, 'a1')]));
    expect(out.lanes.map(l => l.id)).toEqual([1]);
    expect(out.lanes[0]!.cards).toEqual([]);
  });
  it('applyChanges: re-sorts lanes by position and keeps the lane order stable on equal keys', () => {
    const base = data([lane(1, 'a0', []), lane(2, 'a1', [])]);
    const out = applyChanges(base, delta([{...lane(1, 'a2', []), cards: undefined}], []));
    expect(out.lanes.map(l => l.id)).toEqual([2, 1]);
  });
  it('applyChanges: a card for a lane not loaded yet is held back (the lane fetches itself)', () => {
    const base = data([lane(1, 'a0', [], {loaded: false, hasMore: true, cardCount: 3})]);
    expect(applyChanges(base, delta([], [card(1, 1, 'a0')])).lanes[0]!.cards).toEqual([]);
  });
  it('applyChanges carries board archived + rev', () => {
    const out = applyChanges(data([]), {rev: '9', archived: true, truncated: false, lanes: [], cards: []} as never);
    expect(out.board).toMatchObject({rev: '9', archived: true});
  });
});

describe('chat helpers', () => {
  const pulse = (workspaceId: number, unread: number, muted = false) => ({conversationId: unread, workspaceId, lastSeq: 0, lastReadSeq: 0, unread, muted});
  it('totalUnread skips muted and other workspaces', () => {
    const items = [pulse(1, 3), pulse(1, 4, true), pulse(2, 5)];
    expect(totalUnread(items)).toBe(8);
    expect(totalUnread(items, 1)).toBe(3);
    expect(totalUnread(undefined)).toBe(0);
  });
  it('displayName falls back for blank names', () => {
    expect(displayName('  ', 'Deleted')).toBe('Deleted');
    expect(displayName(null, 'Deleted')).toBe('Deleted');
    expect(displayName('Ann', 'Deleted')).toBe('Ann');
  });
  const people = [{userId: 1, name: 'Ann'}, {userId: 2, name: 'Ann Lee'}, {userId: 3, name: null as unknown as string}, {userId: 4, name: 'Bo (QA)'}];
  it('mentionedIds: longest name wins, boundaries respected, names with punctuation', () => {
    expect(mentionedIds('hi @Ann Lee!', people)).toEqual([2]);
    expect(mentionedIds('hi @Ann and @Ann Lee', people).sort()).toEqual([1, 2]);
    expect(mentionedIds('@Annie', people)).toEqual([]);
    expect(mentionedIds('mail@Ann', people)).toEqual([]);
    expect(mentionedIds('x @Bo (QA), ok', people)).toEqual([4]);
    expect(mentionedIds('@Ann', [])).toEqual([]);
  });
  it('mentionedIds: a later valid occurrence counts after an invalid first one', () => {
    expect(mentionedIds('@Annie then @Ann', people)).toEqual([1]);
  });
  it('mentionAt: caret in the middle, newline and long queries', () => {
    expect(mentionAt('a @bo and', 5)).toEqual({start: 2, query: 'bo'});
    expect(mentionAt('@a\nb', 4)).toBeNull();
    expect(mentionAt(`@${'x'.repeat(31)}`, 32)).toBeNull();
    expect(mentionAt('no at', 5)).toBeNull();
  });
  it('card tag helpers', () => {
    expect(cardTagAt('see #fix', 8)).toEqual({start: 4, query: 'fix'});
    expect(cardTagAt('a#b', 3)).toBeNull();
    expect(removeCardTag('see #fix now', 8, 4)).toEqual({text: 'see  now', caret: 4});
  });
  it('matchPeople ignores unnamed, caps results, empty query lists first max', () => {
    const many = Array.from({length: 10}, (_, i) => ({userId: i, name: `P${i}`}));
    expect(matchPeople(many, '')).toHaveLength(6);
    expect(matchPeople(many, '', 2)).toHaveLength(2);
    expect(matchPeople(people, '').map(p => p.userId)).not.toContain(3);
  });
  it('insertMention at the end and the start', () => {
    expect(insertMention('@', 1, 0, 'Bo')).toEqual({text: '@Bo ', caret: 4});
    expect(insertMention('@b tail', 2, 0, 'Bo')).toEqual({text: '@Bo  tail', caret: 4});
  });
  it('segments: mentions, links with trailing punctuation, html stays text', () => {
    expect(segments('hi @Ann, see https://x.io/a.', ['Ann'])).toEqual([
      {kind: 'text', value: 'hi '}, {kind: 'mention', value: '@Ann'}, {kind: 'text', value: ', see '},
      {kind: 'link', value: 'https://x.io/a'}, {kind: 'text', value: '.'},
    ]);
    expect(segments('<b>@Ann</b>', ['Ann']).map(s => s.kind)).toEqual(['text']);
    expect(segments('', ['Ann'])).toEqual([]);
    expect(segments('javascript:alert(1)', []).every(s => s.kind === 'text')).toBe(true);
    expect(segments('@Ann Lee', ['Ann', 'Ann Lee'])).toEqual([{kind: 'mention', value: '@Ann Lee'}]);
  });
  it('dayKey separates days', () => {
    expect(dayKey('2026-01-01T12:00:00')).not.toBe(dayKey('2026-01-02T12:00:00'));
  });
});

describe('templates', () => {
  it('ids unique, intents map to real templates, lane keys exist in en and are unique per template', () => {
    expect(new Set(TEMPLATES.map(t => t.id)).size).toBe(TEMPLATES.length);
    for (const id of Object.values(INTENT_TEMPLATE)) expect(TEMPLATES.some(t => t.id === id)).toBe(true);
    for (const t of TEMPLATES) {
      for (const key of [t.title, t.description, ...t.lanes]) expect(key in en, key).toBe(true);
      expect(new Set(t.lanes).size).toBe(t.lanes.length);
      expect(t.lanes.length).toBeLessThanOrEqual(30);
      for (const key of t.lanes) expect((en as Record<string, string>)[key]!.length).toBeLessThanOrEqual(80);
    }
  });
});

describe('i18n pure logic', () => {
  it('interpolate: numbers localised, unknown names kept, $ patterns literal', () => {
    expect(interpolate('{n} cards', {n: 1234}, 'en')).toBe('1,234 cards');
    expect(interpolate('hi {who}', {}, 'en')).toBe('hi {who}');
    expect(interpolate('hi {who}', {who: '$&'}, 'en')).toBe('hi $&');
    expect(interpolate('plain', undefined)).toBe('plain');
  });
  it('lookup: plural categories with fallback to _other then base', () => {
    const cat = {k_one: '{count} item', k_other: '{count} items', z: 'z'};
    expect(lookup(cat, 'k', {count: 1})).toBe('1 item');
    expect(lookup(cat, 'k', {count: 0})).toBe('0 items');
    expect(lookup(cat, 'z', {count: 5})).toBe('z');
    expect(lookup(cat, 'missing')).toBeUndefined();
    expect(lookup({k_one: 'a', k_other: 'b'}, 'k', {count: Number.NaN})).toBe('b');
  });
  it('arabic and russian plural categories', () => {
    expect(pluralCategory('ru', 2)).toBe('few');
    expect(pluralCategory('ru', 5)).toBe('many');
    expect(pluralCategory('ar', 0)).toBe('zero');
    expect(pluralCategory('xx-invalid-locale-!!', 1)).toBe('one');
  });
  it('translate: catalog, then English, then the key', () => {
    expect(translate({}, 'definitely.missing')).toBe('definitely.missing');
    expect(translate({'shortcuts.title': 'X'}, 'shortcuts.title')).toBe('X');
    expect(translate({}, 'shortcuts.title')).toBe((en as Record<string, string>)['shortcuts.title']);
  });
  it('matchLocale / parseAcceptLanguage / resolveLocale', () => {
    expect(matchLocale('pt-BR')).toBe('pt');
    expect(matchLocale('ZH_hans_CN')).toBe('zh');
    expect(matchLocale('nb')).toBeNull();
    expect(matchLocale('')).toBeNull();
    expect(matchLocale(' AR ')).toBe('ar');
    expect(parseAcceptLanguage('en;q=0.5, bn;q=0.9, *;q=0.1, de;q=0')).toEqual(['bn', 'en', '*']);
    expect(parseAcceptLanguage('fr, es')).toEqual(['fr', 'es']);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(resolveLocale({profile: 'xx', cookie: 'tr', languages: ['de']})).toBe('tr');
    expect(resolveLocale({languages: ['xx', 'ja-JP']})).toBe('ja');
    expect(resolveLocale({})).toBe('en');
  });
  it('readLocaleCookie', () => {
    expect(readLocaleCookie('a=1; lf_locale=bn; b=2')).toBe('bn');
    expect(readLocaleCookie('a=1')).toBeNull();
    expect(readLocaleCookie('lf_locale_other=x')).toBeNull();
  });
  it('readLocaleCookie never throws on a malformed cookie (BUG if it does)', () => {
    expect(() => readLocaleCookie('lf_locale=%E0%A4%A')).not.toThrow();
  });
  it('dirOf / isLocale', () => {
    for (const code of ['ur', 'ar', 'fa']) expect(dirOf(code)).toBe('rtl');
    expect(dirOf('en')).toBe('ltr');
    expect(dirOf('xx')).toBe('ltr');
    expect(isLocale('en')).toBe(true);
    expect(isLocale('EN')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(LOCALES.length).toBe(20);
  });
  const ctx = {locale: 'en', timezone: 'UTC'};
  it('format: invalid input gives empty, bad timezone and locale fall back', () => {
    expect(formatDate(ctx, 'nope')).toBe('');
    expect(formatRelative(ctx, 'nope')).toBe('');
    expect(formatDate({locale: 'en', timezone: 'Not/AZone'}, '2026-01-02T00:00:00Z')).toMatch(/2026/);
    expect(formatNumber({locale: 'zz-bad-locale-!', timezone: 'UTC'}, 1234.5)).toBe('1,234.5');
    expect(formatDate(ctx, '2026-03-04T23:30:00Z', {dateStyle: 'short'})).toBe('3/4/26');
    expect(formatDate({locale: 'en', timezone: 'Asia/Dhaka'}, '2026-03-04T23:30:00Z', {dateStyle: 'short'})).toBe('3/5/26');
  });
  it('formatRelative: units and "now"', () => {
    const now = Date.parse('2026-06-15T12:00:00Z');
    expect(formatRelative(ctx, now - 30_000, now)).toBe('now');
    expect(formatRelative(ctx, now - 3 * 60_000, now)).toBe('3 minutes ago');
    expect(formatRelative(ctx, now + 86_400_000, now)).toBe('tomorrow');
    expect(formatRelative(ctx, now - 86_400_000, now)).toBe('yesterday');
    expect(formatRelative(ctx, now + 14 * 86_400_000, now)).toBe('in 2 weeks');
    expect(formatRelative(ctx, now - 3600_000, now)).toBe('1 hour ago');
  });
});

describe('client rules mirror server validators', () => {
  it('name: 80 like the board/lane/workspace limits; trimmed on both sides', () => {
    const name = AUTH_RULES.name;
    const run = (v: string) => name.map(r => r(v)).find(Boolean) ?? null;
    expect(run('a'.repeat(80))).toBeNull();
    expect(run('a'.repeat(81))).not.toBeNull();
    expect(run('  ')).not.toBeNull();
    expect(textField('a'.repeat(80), 1, 80).ok).toBe(true);
    expect(textField(` ${'a'.repeat(80)} `, 1, 80).ok).toBe(true);
    expect(rules.maxLength(80)(` ${'a'.repeat(80)} `)).toBeNull();
    expect(textField('a'.repeat(81), 1, 80).ok).toBe(false);
  });
  it('required and textField agree on whitespace-only', () => {
    expect(rules.required()('   ')).not.toBeNull();
    expect(textField('   ', 1, 80).ok).toBe(false);
  });
  it('email: 254 max and basic shape', () => {
    const run = (v: string) => AUTH_RULES.email.map(r => r(v)).find(Boolean) ?? null;
    expect(run('a@b.co')).toBeNull();
    expect(run('a@b')).not.toBeNull();
    expect(run('a b@c.com')).not.toBeNull();
    expect(run(`${'a'.repeat(250)}@b.co`)).not.toBeNull();
  });
  it('newPassword limits equal the platform limits', () => {
    const r = rules.newPassword();
    expect(r('a'.repeat(PASSWORD_LIMITS.min))).toBeNull();
    expect(r('a'.repeat(PASSWORD_LIMITS.min - 1))).not.toBeNull();
    expect(r('a'.repeat(PASSWORD_LIMITS.max))).toBeNull();
    expect(r('a'.repeat(PASSWORD_LIMITS.max + 1))).not.toBeNull();
    expect(r('')).not.toBeNull();
  });
  it('other rules', () => {
    expect(rules.minLength(3)('')).toBeNull();
    expect(rules.minLength(3)('ab')).not.toBeNull();
    expect(rules.wholeNumber()('12a')).not.toBeNull();
    expect(rules.wholeNumber()('٣')).not.toBeNull();
    expect(rules.pattern(/^a$/, 'x')(' a ')).toBeNull();
  });
  it('server validators: intField is strict, likeEscape escapes', () => {
    expect(intField('5', 1, 9).ok).toBe(false);
    expect(intField(1.5, 1, 9).ok).toBe(false);
    expect(intField(9, 1, 9).ok).toBe(true);
    expect(intField(0, 1, 9).ok).toBe(false);
    expect(likeEscape('50%_\\')).toBe('50\\%\\_\\\\');
  });
});
