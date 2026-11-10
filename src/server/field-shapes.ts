import type {Prisma} from '../generated/prisma/client';

/** Wire shapes of a board's custom fields and a card's values (shared by the card detail answer and the field routes). */
export const FIELD_TYPES = ['dropdown', 'text', 'number', 'date', 'checkbox'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_LIMITS = {perBoard: 20, optionsPerField: 30};
/** A board's fields in the order its people arranged them (ties: oldest first). */
export const FIELD_ORDER = [{position: 'asc'}, {id: 'asc'}] as const satisfies Prisma.CustomFieldOrderByWithRelationInput[];

export const fieldCols = {
  id: true,
  name: true,
  type: true,
  options: {orderBy: {id: 'asc'}, take: FIELD_LIMITS.optionsPerField, select: {id: true, name: true, colorHex: true}},
} as const satisfies Prisma.CustomFieldSelect;
type FieldRow = Prisma.CustomFieldGetPayload<{select: typeof fieldCols}>;

export const fieldShape = (f: FieldRow) => ({id: f.id, name: f.name, type: f.type as FieldType, options: f.options.map(o => ({id: o.id, name: o.name, colorHex: o.colorHex}))});

export const valueCols = {fieldId: true, textValue: true, numberValue: true, dateValue: true, boolValue: true, optionId: true} as const;
type ValueRow = Prisma.CardFieldValueGetPayload<{select: typeof valueCols}>;

export type FieldValue = string | number | boolean | null;

/** One value per field id, in the shape its type uses; a field with no row has no key. */
export function valueMap(rows: ValueRow[], fields: {id: number; type: string}[]): Record<string, FieldValue> {
  const type = new Map(fields.map(f => [f.id, f.type]));
  const out: Record<string, FieldValue> = {};
  for (const r of rows) {
    const t = type.get(r.fieldId);
    const v = t === 'text' ? r.textValue : t === 'number' ? r.numberValue : t === 'date' ? (r.dateValue ? r.dateValue.toISOString().slice(0, 10) : null) : t === 'checkbox' ? r.boolValue : t === 'dropdown' ? r.optionId : null;
    if (v !== null && v !== undefined) out[String(r.fieldId)] = v;
  }
  return out;
}
