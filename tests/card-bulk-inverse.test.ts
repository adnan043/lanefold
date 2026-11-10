import {describe, expect, it} from 'vitest';

import {type Before, type BulkInput, inverseSteps, MAX_UNDO_STEPS, parseBulk} from '../src/server/routes/card-bulk';

const none: Before = {cards: [], moved: [], labelCards: [], personCards: []};
const day = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);

describe('parseBulk: restore and the Undo guard', () => {
  it('accepts restore and a numeric ifUnchangedSince', () => {
    const r = parseBulk({cardIds: [3, 3, 4], action: 'restore', ifUnchangedSince: '42'});
    expect(r.ok && r.value).toMatchObject({cardIds: [3, 4], action: 'restore', since: 42n});
  });
  it('has no `since` without the guard', () => {
    const r = parseBulk({cardIds: [3], action: 'archive'});
    expect(r.ok && 'since' in r.value).toBe(false);
  });
  it.each(['', 'abc', '-1', '1.5', '1'.repeat(19), 7, null])('refuses the guard %j', bad => {
    expect(parseBulk({cardIds: [3], action: 'archive', ifUnchangedSince: bad}).ok).toBe(false);
  });
});

describe('inverseSteps', () => {
  it('move: one step per lane the cards came from, to that lane', () => {
    const input: BulkInput = {cardIds: [1, 2, 3], action: 'move', laneId: 9};
    expect(inverseSteps(input, [1, 2, 3], {...none, moved: [{id: 1, from: 5}, {id: 2, from: 6}, {id: 3, from: 5}]})).toEqual([
      {action: 'move', laneId: 5, cardIds: [1, 3]},
      {action: 'move', laneId: 6, cardIds: [2]},
    ]);
  });
  it('move: nothing moved means nothing to undo', () => {
    expect(inverseSteps({cardIds: [1], action: 'move', laneId: 9}, [1], none)).toEqual([]);
  });
  it('archive and restore invert each other', () => {
    expect(inverseSteps({cardIds: [1, 2], action: 'archive'}, [1, 2], none)).toEqual([{action: 'restore', cardIds: [1, 2]}]);
    expect(inverseSteps({cardIds: [1, 2], action: 'restore'}, [1, 2], none)).toEqual([{action: 'archive', cardIds: [1, 2]}]);
  });
  it('label_add takes the label off only the cards that lacked it; label_remove puts it back on those that had it', () => {
    expect(inverseSteps({cardIds: [1, 2], action: 'label_add', labelId: 7}, [1, 2], {...none, labelCards: [2]})).toEqual([{action: 'label_remove', labelId: 7, cardIds: [2]}]);
    expect(inverseSteps({cardIds: [1, 2], action: 'label_remove', labelId: 7}, [1, 2], {...none, labelCards: [1]})).toEqual([{action: 'label_add', labelId: 7, cardIds: [1]}]);
    expect(inverseSteps({cardIds: [1], action: 'label_add', labelId: 7}, [1], none)).toEqual([]);
  });
  it('assign and unassign invert each other on the cards that really changed', () => {
    expect(inverseSteps({cardIds: [1, 2], action: 'assign', userId: 4}, [1, 2], {...none, personCards: [2]})).toEqual([{action: 'unassign', userId: 4, cardIds: [2]}]);
    expect(inverseSteps({cardIds: [1, 2], action: 'unassign', userId: 4}, [1, 2], {...none, personCards: [1]})).toEqual([{action: 'assign', userId: 4, cardIds: [1]}]);
  });
  it('set_due: one step per previous day (null clears), cards already on the new day are left out', () => {
    const cards = [
      {id: 1, dueDate: day('2026-01-01'), priority: 'none'},
      {id: 2, dueDate: null, priority: 'none'},
      {id: 3, dueDate: day('2026-01-01'), priority: 'none'},
      {id: 4, dueDate: day('2026-03-03'), priority: 'none'}, // already the new day
    ];
    expect(inverseSteps({cardIds: [1, 2, 3, 4], action: 'set_due', dueDate: day('2026-03-03')}, [1, 2, 3, 4], {...none, cards})).toEqual([
      {action: 'set_due', dueDate: '2026-01-01', cardIds: [1, 3]},
      {action: 'set_due', dueDate: null, cardIds: [2]},
    ]);
  });
  it('set_priority: one step per previous priority, cards already at it are left out', () => {
    const cards = [
      {id: 1, dueDate: null, priority: 'low'},
      {id: 2, dueDate: null, priority: 'high'},
      {id: 3, dueDate: null, priority: 'low'},
      {id: 4, dueDate: null, priority: 'urgent'},
    ];
    expect(inverseSteps({cardIds: [1, 2, 3, 4], action: 'set_priority', priority: 'urgent'}, [1, 2, 3, 4], {...none, cards})).toEqual([
      {action: 'set_priority', priority: 'low', cardIds: [1, 3]},
      {action: 'set_priority', priority: 'high', cardIds: [2]},
    ]);
  });
  it('offers no Undo at all when it would take more than MAX_UNDO_STEPS requests', () => {
    const cards = Array.from({length: MAX_UNDO_STEPS + 1}, (_, i) => ({id: i + 1, dueDate: day(`2026-01-${String(i + 1).padStart(2, '0')}`), priority: 'none'}));
    const ids = cards.map(c => c.id);
    expect(inverseSteps({cardIds: ids, action: 'set_due', dueDate: null}, ids, {...none, cards})).toEqual([]);
    expect(inverseSteps({cardIds: ids.slice(0, MAX_UNDO_STEPS), action: 'set_due', dueDate: null}, ids.slice(0, MAX_UNDO_STEPS), {...none, cards: cards.slice(0, MAX_UNDO_STEPS)})).toHaveLength(MAX_UNDO_STEPS);
  });
});
