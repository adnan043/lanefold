import type {FieldT} from '../cards/use-card';

type Value = string | number | boolean;
type Values = Record<string, Record<string, Value>>;

/** What the Table view holds: the board's fields, the values by card id, the revision they are at, and whether some are missing. */
export type FieldValuesT = {fields: FieldT[]; values: Values; rev: string; partial: boolean};

/** The wire shape of `GET /boards/:id/field-values` (`src/server/routes/card-fields.ts`). */
export type FieldValuesPage = {fields: FieldT[]; values: Values; rev: string; nextAfter?: number | null; changed?: number[]; reset?: boolean};

/** Pages of a full read, at most this many (x 5000 values): past that the view says some values are not shown. */
export const MAX_PAGES = 10;

/** Is revision `a` newer than `b`? Revisions are bigint strings. */
export const revNewer = (a: string, b: string) => BigInt(a) > BigInt(b);

/** A delta applied to what we hold: changed cards are replaced (an archived card, or one with no values left, drops out). */
export function mergeDelta(prev: FieldValuesT, delta: FieldValuesPage): FieldValuesT {
  const values = {...prev.values};
  for (const id of delta.changed ?? []) delete values[String(id)];
  Object.assign(values, delta.values);
  return {fields: delta.fields, values, rev: delta.rev, partial: prev.partial};
}

/**
 * The board's values: only what changed since `prev` when we have it, else every page from the start. The revision
 * kept is the FIRST page's (the oldest any page is at), so the next delta covers whatever moved while paging.
 */
export async function loadFieldValues(get: (query: string) => Promise<FieldValuesPage>, prev: FieldValuesT | undefined): Promise<FieldValuesT> {
  if (prev) {
    const delta = await get(`since=${encodeURIComponent(prev.rev)}`);
    if (!delta.reset) return mergeDelta(prev, delta);
  }
  const first = await get('');
  const values: Values = {...first.values};
  let next = first.nextAfter ?? null;
  for (let page = 1; next !== null && page < MAX_PAGES; page++) {
    const more = await get(`after=${next}`);
    Object.assign(values, more.values);
    next = more.nextAfter ?? null;
  }
  return {fields: first.fields, values, rev: first.rev, partial: next !== null};
}
