import {describe, expect, it} from 'vitest';

import {MAX_BULK_CARDS, parseBulk} from '../src/server/routes/card-bulk';

describe('parseBulk (bulk card action body)', () => {
  it('dedupes the ids and reads each action with its params', () => {
    expect(parseBulk({cardIds: [3, 3, 4], action: 'archive'})).toEqual({ok: true, value: {cardIds: [3, 4], action: 'archive'}});
    expect(parseBulk({cardIds: [1], action: 'move', laneId: 9})).toMatchObject({ok: true, value: {action: 'move', laneId: 9}});
    expect(parseBulk({cardIds: [1], action: 'label_add', labelId: 2})).toMatchObject({ok: true, value: {labelId: 2}});
    expect(parseBulk({cardIds: [1], action: 'assign', userId: 5})).toMatchObject({ok: true, value: {userId: 5}});
    expect(parseBulk({cardIds: [1], action: 'set_priority', priority: 'high'})).toMatchObject({ok: true, value: {priority: 'high'}});
  });
  it('reads a due date and null (clear)', () => {
    const set = parseBulk({cardIds: [1], action: 'set_due', dueDate: '2030-05-06'});
    expect(set.ok && set.value.action === 'set_due' && set.value.dueDate?.toISOString().slice(0, 10)).toBe('2030-05-06');
    expect(parseBulk({cardIds: [1], action: 'set_due', dueDate: null})).toMatchObject({ok: true, value: {dueDate: null}});
  });
  it('refuses a bad body with the field named', () => {
    const bad = (v: Record<string, unknown>) => {
      const r = parseBulk(v);
      return r.ok ? null : Object.keys(r.errors)[0];
    };
    expect(bad({action: 'archive'})).toBe('cardIds');
    expect(bad({cardIds: [], action: 'archive'})).toBe('cardIds');
    expect(bad({cardIds: ['1'], action: 'archive'})).toBe('cardIds');
    expect(bad({cardIds: [0], action: 'archive'})).toBe('cardIds');
    expect(bad({cardIds: Array.from({length: MAX_BULK_CARDS + 1}, (_, i) => i + 1), action: 'archive'})).toBe('cardIds');
    expect(bad({cardIds: [1], action: 'nope'})).toBe('action');
    expect(bad({cardIds: [1], action: 'move'})).toBe('laneId');
    expect(bad({cardIds: [1], action: 'label_remove'})).toBe('labelId');
    expect(bad({cardIds: [1], action: 'unassign'})).toBe('userId');
    expect(bad({cardIds: [1], action: 'set_due', dueDate: '2030-02-31'})).toBe('dueDate');
    expect(bad({cardIds: [1], action: 'set_due'})).toBe('dueDate');
    expect(bad({cardIds: [1], action: 'set_priority', priority: 'huge'})).toBe('priority');
  });
});
