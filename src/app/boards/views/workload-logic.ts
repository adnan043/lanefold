/** Pure logic of the Workload view: no React, no network (tests/workload-logic.test.ts). Wire shape: src/server/routes/board-workload.ts. */

export type WorkloadLane = {id: number; name: string};
export type WorkloadTotals = {open: number; overdue: number; dueSoon: number; estimateMinutes: number; lanes: {laneId: number; count: number}[]};
export type WorkloadPerson = WorkloadTotals & {id: number; name: string};
export type WorkloadData = {lanes: WorkloadLane[]; people: WorkloadPerson[]; unassigned: WorkloadTotals | null; truncated: boolean};

/** The bar's two segments as percentages of the busiest row: overdue first, then the rest of the open cards. */
export function barParts(row: Pick<WorkloadTotals, 'open' | 'overdue'>, maxOpen: number): {overduePct: number; restPct: number} {
  if (maxOpen <= 0 || row.open <= 0) return {overduePct: 0, restPct: 0};
  const overdue = Math.min(row.overdue, row.open);
  const unit = 100 / maxOpen;
  return {overduePct: overdue * unit, restPct: (row.open - overdue) * unit};
}

/** The busiest row's open count (at least 1, so an empty board never divides by zero). */
export const maxOpen = (data: Pick<WorkloadData, 'people' | 'unassigned'>): number =>
  Math.max(1, ...data.people.map(p => p.open), data.unassigned?.open ?? 0);

/** Estimate as whole hours and leftover minutes (the view formats them with its own words). */
export function splitEstimate(minutes: number): {hours: number; minutes: number} {
  const m = Math.max(0, Math.round(minutes));
  return {hours: Math.floor(m / 60), minutes: m % 60};
}

/** "To do 3 · Doing 2": the row's open cards per lane in the board's lane order (lanes that are gone are skipped). */
export function laneBreakdown(row: Pick<WorkloadTotals, 'lanes'>, lanes: WorkloadLane[]): {laneId: number; name: string; count: number}[] {
  const counts = new Map(row.lanes.map(l => [l.laneId, l.count]));
  return lanes.flatMap(l => (counts.get(l.id) ? [{laneId: l.id, name: l.name, count: counts.get(l.id)!}] : []));
}

/** Filtering the board to one person keeps the other criteria and replaces the member choice. */
export function filterToPerson<F extends {memberIds?: number[]}>(filter: F, userId: number): F {
  return {...filter, memberIds: [userId]};
}
