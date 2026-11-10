import {describe, expect, it} from 'vitest';

import {expandTitle} from '../src/app/templates/templates';
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
      null, [], {evil: 1}, {priority: 'now'}, {estimateMinutes: -1}, {estimateMinutes: 1.5}, {title: 'x'.repeat(201)},
      {checklists: [{title: '', items: []}]}, {checklists: [{title: 'a', items: [1]}]},
      {checklists: Array.from({length: TEMPLATE_LIMITS.checklists + 1}, () => ({title: 'a', items: []}))},
      {checklists: Array.from({length: 3}, () => ({title: 'a', items: Array.from({length: 99}, () => 'i')}))},
      {labels: Array.from({length: 21}, (_, i) => `l${i}`)}, {labels: ['x'.repeat(41)]},
    ];
    for (const value of bad) expect(parsePayload(value).ok).toBe(false);
  });
});

describe('expandTitle', () => {
  it('replaces {date} with the local day and nothing else', () => {
    expect(expandTitle('Standup {date} {x}', new Date(2026, 10, 4))).toBe('Standup 2026-11-04 {x}');
  });
});
