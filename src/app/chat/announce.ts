import type {MessageT} from './api';

/**
 * How many messages in `items` are new, incoming and worth announcing: newer than `lastSeq` (so a "load older"
 * page never counts), not sent by `me` and not deleted. Returns the count and the newest seq seen.
 */
export function incomingSince(items: readonly Pick<MessageT, 'seq' | 'sender' | 'deleted'>[], lastSeq: number, me: number | undefined): {count: number; maxSeq: number} {
  let count = 0;
  let maxSeq = lastSeq;
  for (const m of items) {
    if (m.seq <= lastSeq) continue;
    if (m.seq > maxSeq) maxSeq = m.seq;
    if (m.sender.id !== me && !m.deleted) count += 1;
  }
  return {count, maxSeq};
}

/** The newest seq among the items (0 for none): the baseline taken when the list first shows. */
export const newestSeq = (items: readonly Pick<MessageT, 'seq'>[]): number => items.reduce((max, m) => (m.seq > max ? m.seq : max), 0);
