import {describe, expect, it} from 'vitest';

import {type FieldValuesPage, type FieldValuesT, loadFieldValues, MAX_PAGES, mergeDelta, revNewer} from '../src/app/custom-fields/field-values';

const fields = [{id: 1, name: 'Points', type: 'number' as const, options: []}];
const page = (extra: Partial<FieldValuesPage>): FieldValuesPage => ({fields, values: {}, rev: '10', ...extra});

/** The Table view's custom field values: one full read in pages, then deltas. */
describe('field values in the table view', () => {
  it('reads every page once, keeping the first page revision', async () => {
    const asked: string[] = [];
    const pages: Record<string, FieldValuesPage> = {
      '': page({values: {'1': {'1': 3}}, nextAfter: 1, rev: '10'}),
      'after=1': page({values: {'2': {'1': 5}}, nextAfter: null, rev: '11'}),
    };
    const out = await loadFieldValues(async q => (asked.push(q), pages[q]!), undefined);
    expect(asked).toEqual(['', 'after=1']);
    expect(out).toEqual({fields, values: {'1': {'1': 3}, '2': {'1': 5}}, rev: '10', partial: false});
  });

  it('stops after MAX_PAGES and says the values are partial', async () => {
    let calls = 0;
    const out = await loadFieldValues(async () => (calls++, page({values: {[String(calls)]: {'1': calls}}, nextAfter: calls})), undefined);
    expect(calls).toBe(MAX_PAGES);
    expect(out.partial).toBe(true);
    expect(Object.keys(out.values)).toHaveLength(MAX_PAGES);
  });

  it('asks only for what changed since the held revision, and merges it', async () => {
    const held: FieldValuesT = {fields, values: {'1': {'1': 3}, '2': {'1': 5}, '3': {'1': 8}}, rev: '10', partial: false};
    const asked: string[] = [];
    // Card 2 was cleared (changed, no values), card 3 archived (changed, gone), card 4 is new.
    const out = await loadFieldValues(async q => (asked.push(q), page({values: {'4': {'1': 1}}, changed: [2, 3, 4], rev: '12'})), held);
    expect(asked).toEqual(['since=10']);
    expect(out).toEqual({fields, values: {'1': {'1': 3}, '4': {'1': 1}}, rev: '12', partial: false});
    expect(held.values['2']).toEqual({'1': 5}); // the held object is not changed in place
  });

  it('reads it all again when the delta says reset', async () => {
    const held: FieldValuesT = {fields, values: {'1': {'1': 3}}, rev: '10', partial: false};
    const asked: string[] = [];
    const out = await loadFieldValues(async q => (asked.push(q), q.startsWith('since') ? page({reset: true, rev: '900'}) : page({values: {'9': {'1': 9}}, rev: '900', nextAfter: null})), held);
    expect(asked).toEqual(['since=10', '']);
    expect(out.values).toEqual({'9': {'1': 9}});
  });

  it('keeps partial through deltas and compares revisions as big numbers', () => {
    expect(mergeDelta({fields, values: {}, rev: '1', partial: true}, page({changed: [], rev: '2'})).partial).toBe(true);
    expect(revNewer('10', '9')).toBe(true);
    expect(revNewer('9007199254740993', '9007199254740992')).toBe(true);
    expect(revNewer('5', '5')).toBe(false);
  });
});
