import {describe, expect, it} from 'vitest';

import {barParts, filterToPerson, laneBreakdown, maxOpen, splitEstimate} from '../src/app/boards/views/workload-logic';
import {isBoardView} from '../src/app/boards/views/view-logic';
import {shapeWorkload} from '../src/server/routes/board-workload';

const row = (user_id: number | null, lane_id: number, open: number, overdue = 0, soon = 0, est = 0, name: string | null = user_id === null ? null : `P${user_id}`) => ({user_id, name, lane_id, open, overdue, soon, est});

describe('workload view logic', () => {
  it('is a known board view', () => expect(isBoardView('workload')).toBe(true));

  it('bar segments are relative to the busiest row and never exceed it', () => {
    expect(barParts({open: 4, overdue: 1}, 8)).toEqual({overduePct: 12.5, restPct: 37.5});
    expect(barParts({open: 8, overdue: 8}, 8)).toEqual({overduePct: 100, restPct: 0});
    expect(barParts({open: 2, overdue: 5}, 4)).toEqual({overduePct: 50, restPct: 0}); // overdue is clamped to open
    expect(barParts({open: 0, overdue: 0}, 4)).toEqual({overduePct: 0, restPct: 0});
    expect(barParts({open: 3, overdue: 0}, 0)).toEqual({overduePct: 0, restPct: 0});
  });

  it('the maximum counts people and the unassigned row, and is at least 1', () => {
    expect(maxOpen({people: [], unassigned: null})).toBe(1);
    expect(maxOpen({people: [{id: 1, name: 'A', open: 3, overdue: 0, dueSoon: 0, estimateMinutes: 0, lanes: []}], unassigned: {open: 7, overdue: 0, dueSoon: 0, estimateMinutes: 0, lanes: []}})).toBe(7);
  });

  it('splits estimates into hours and minutes', () => {
    expect(splitEstimate(0)).toEqual({hours: 0, minutes: 0});
    expect(splitEstimate(90)).toEqual({hours: 1, minutes: 30});
    expect(splitEstimate(125.4)).toEqual({hours: 2, minutes: 5});
    expect(splitEstimate(-5)).toEqual({hours: 0, minutes: 0});
  });

  it('lists a row\'s lanes in board order and skips lanes that are gone or empty', () => {
    const lanes = [{id: 1, name: 'To do'}, {id: 2, name: 'Doing'}, {id: 3, name: 'Done'}];
    expect(laneBreakdown({lanes: [{laneId: 2, count: 2}, {laneId: 1, count: 3}, {laneId: 99, count: 1}]}, lanes)).toEqual([
      {laneId: 1, name: 'To do', count: 3},
      {laneId: 2, name: 'Doing', count: 2},
    ]);
  });

  it('filtering to a person keeps the other criteria and replaces the members', () => {
    expect(filterToPerson({text: 'x', memberIds: [1, 2], due: 'week' as const}, 9)).toEqual({text: 'x', memberIds: [9], due: 'week'});
  });
});

describe('shapeWorkload (server)', () => {
  it('sums lanes per person, busiest first, and gathers the unassigned rows', () => {
    const out = shapeWorkload([row(1, 10, 2, 1, 1, 30), row(1, 11, 1, 0, 0, 0), row(2, 10, 5, 0, 2, 120), row(null, 10, 4, 1, 0, 0)]);
    expect(out.people.map(p => [p.id, p.open, p.overdue, p.dueSoon, p.estimateMinutes])).toEqual([[2, 5, 0, 2, 120], [1, 3, 1, 1, 30]]);
    expect(out.people[1]!.lanes).toEqual([{laneId: 10, count: 2}, {laneId: 11, count: 1}]);
    expect(out.unassigned).toMatchObject({open: 4, overdue: 1});
    expect(out.truncated).toBe(false);
  });

  it('breaks ties by name then id, caps the list and says so', () => {
    const rows = [3, 2, 1].map(id => row(id, 10, 1));
    const out = shapeWorkload(rows, 2);
    expect(out.people.map(p => p.id)).toEqual([1, 2]);
    expect(out.truncated).toBe(true);
  });

  it('an empty board has no people and no unassigned row', () => {
    expect(shapeWorkload([])).toEqual({people: [], unassigned: null, truncated: false});
  });
});
