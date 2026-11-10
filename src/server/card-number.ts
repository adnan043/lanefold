import type {Prisma} from '../generated/prisma/client';

/**
 * Card numbers: every card has a short number within its board (#42), shown next to its title and searchable.
 * - Handed out here and nowhere else, by ONE `UPDATE boards ... RETURNING`: the row lock serialises two parallel
 *   creations of the same board, so they never get the same numbers; `cards_board_id_number_key` is the safety net.
 * - Never reused: a deleted or archived card keeps its number; the counter only goes up.
 * - A card moved to ANOTHER board takes a new number there (its id, and so every link, stays); a copy gets its own.
 * - A card written before the migration has `number = null` and shows none.
 */
type Tx = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Reserve `count` consecutive numbers on the board and return the first one (the numbers are first .. first + count - 1).
 * Call it inside the same transaction that inserts the cards, after the board is known to be the caller's
 * (`boardId` + `workspaceId` are in the where, so a wrong pair reserves nothing and throws).
 */
export async function reserveCardNumbers(tx: Tx, boardId: number, workspaceId: number, count: number): Promise<number> {
  if (!Number.isInteger(count) || count < 1) throw new Error('count must be a positive integer');
  const rows = await tx.$queryRaw<{first: number}[]>`
    UPDATE boards SET next_card_number = next_card_number + ${count}::int
    WHERE id = ${boardId} AND workspace_id = ${workspaceId}
    RETURNING next_card_number - ${count}::int AS first`;
  if (!rows[0]) throw new Error('board vanished');
  return rows[0].first;
}

/** The numbers a batch gets, in order: `[first, first + 1, ...]`. */
export function numbersFrom(first: number, count: number): number[] {
  return Array.from({length: count}, (_, i) => first + i);
}

/** What the browser reads: `#42`, or null when the card has no number. */
export function formatCardNumber(n: number | null | undefined): string | null {
  return n == null ? null : `#${n}`;
}

/** `#42`, `42` or `# 42` → 42; anything else (or a number that is not a safe positive Int4) → null. For search. */
export function parseCardNumber(text: string): number | null {
  const m = /^#?\s*(\d{1,9})$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 2_147_483_647 ? n : null;
}
