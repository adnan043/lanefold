import {describe, expect, it} from 'vitest';

import {expandTitle} from '../src/app/templates/templates';
import {CARD_ESTIMATE} from '../src/lib/rules';
import {parsePayload, TEMPLATE_LIMITS} from '../src/server/routes/card-templates';

describe('card template payload', () => {
  it('accepts a full template and normalises it', () => {
    const r = parsePayload({title: ' Weekly {date} ', description: 'Body', priority: 'high', estimateMinutes: 30, checklists: [{title: 'QA', items: ['a', ' b ']}], labels: ['Bug', 'bug', 'UI']});
    expect(r).toEqual({ok: true, value: {title: 'Weekly {date}', description: 'Body', priority: 'high', estimateMinutes: 30, checklists: [{title: 'QA', items: ['a', 'b']}], labels: ['Bug', 'UI']}});
  });
  it('fills defaults for an empty object', () => {
    expect(parsePayload({})).toMatchObject({ok: true, value: {title: '', priority: 'none', estimateMinutes: null, checklists: [], labels: []}});
  });
  it('refuses unknown keys, bad types and oversized lists', () => {
    const bad: unknown[] = [
      null, [], {evil: 1}, {priority: 'now'}, {estimateMinutes: -1}, {estimateMinutes: 1.5}, {estimateMinutes: 0}, {estimateMinutes: CARD_ESTIMATE.max + 1}, {title: 'x'.repeat(201)},
      {checklists: [{title: '', items: []}]}, {checklists: [{title: 'a', items: [1]}]},
      {checklists: Array.from({length: TEMPLATE_LIMITS.checklists + 1}, () => ({title: 'a', items: []}))},
      {checklists: Array.from({length: 3}, () => ({title: 'a', items: Array.from({length: 99}, () => 'i')}))},
      {labels: Array.from({length: 21}, (_, i) => `l${i}`)}, {labels: ['x'.repeat(41)]},
    ];
    for (const value of bad) expect(parsePayload(value).ok).toBe(false);
  });
  it("uses the card's estimate range, and brings an older stored estimate into it", () => {
    expect(parsePayload({estimateMinutes: CARD_ESTIMATE.max})).toMatchObject({ok: true, value: {estimateMinutes: CARD_ESTIMATE.max}});
    expect(parsePayload({estimateMinutes: CARD_ESTIMATE.min})).toMatchObject({ok: true, value: {estimateMinutes: CARD_ESTIMATE.min}});
    // Templates once allowed 0 to 1,000,000: a stored row is read, never hidden, and never gives an unsaveable card.
    expect(parsePayload({estimateMinutes: 1_000_000}, {stored: true})).toMatchObject({ok: true, value: {estimateMinutes: CARD_ESTIMATE.max}});
    expect(parsePayload({estimateMinutes: 0}, {stored: true})).toMatchObject({ok: true, value: {estimateMinutes: null}});
    expect(parsePayload({estimateMinutes: 45}, {stored: true})).toMatchObject({ok: true, value: {estimateMinutes: 45}});
    expect(parsePayload({estimateMinutes: 1.5}, {stored: true}).ok).toBe(false);
  });
});

describe('expandTitle', () => {
  it('replaces {date} with the local day and nothing else', () => {
    expect(expandTitle('Standup {date} {x}', new Date(2026, 10, 4))).toBe('Standup 2026-11-04 {x}');
  });
});
