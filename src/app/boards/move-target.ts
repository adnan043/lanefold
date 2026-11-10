import type {LaneT} from '../api';

/** How many positions the card can take in a lane: the lane's other loaded cards, plus one. */
export function moveSlots(lanes: LaneT[], cardId: number, laneId: number): number {
  const lane = lanes.find(l => l.id === laneId);
  if (!lane) return 1;
  return lane.cards.filter(c => c.id !== cardId).length + 1;
}

/** The 0-based index `moveCard` expects (counted without the card) for a 1-based position, kept in range. */
export function moveIndex(lanes: LaneT[], cardId: number, laneId: number, position: number): number {
  const slots = moveSlots(lanes, cardId, laneId);
  return Math.min(Math.max(Math.trunc(position) || 1, 1), slots) - 1;
}
