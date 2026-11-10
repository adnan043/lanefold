import type {LaneT} from '../api';

/**
 * The lane limits to PATCH: only saved lanes (not temporary) that were present when the drawer opened (`wip` has
 * them; a lane that arrived since keeps its limit) and whose value changed.
 */
export function planWipSaves(lanes: Pick<LaneT, 'id' | 'wipLimit'>[], wip: Record<number, string>): {id: number; wipLimit: number | null}[] {
  const out: {id: number; wipLimit: number | null}[] = [];
  for (const lane of lanes) {
    if (lane.id < 0 || !(lane.id in wip)) continue;
    const raw = (wip[lane.id] ?? '').trim();
    const next = raw ? Number(raw) : null;
    if (next !== lane.wipLimit) out.push({id: lane.id, wipLimit: next});
  }
  return out;
}
