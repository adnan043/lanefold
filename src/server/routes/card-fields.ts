import {type Context, Hono} from 'hono';
import {generateKeyBetween} from 'fractional-indexing';

import type {PrismaClient} from '../../generated/prisma/client';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {reserveCardNumbers} from '../card-number';
import {copyCardParts} from '../card-copy';
import {accessSelect, resolveAccess} from '../board-access-via';
import {getEntitlements, MAX_CARDS_PER_LANE} from '../entitlements';
import {FIELD_LIMITS, FIELD_ORDER, FIELD_TYPES, type FieldType, type FieldValue, fieldCols, fieldShape, valueCols, valueMap} from '../field-shapes';
import {boardAccess, notFound, boardReachable} from '../workspaces';
import {idOf, invalid, textField, type FieldError} from '../validation';
import {atomically, body, bumpRev, cardCtx, dateOnly, errAt, finish, Gone, hexOf, badHex, noStore, refused, send, type Parsed} from './card-detail';

/**
 * Custom fields (Trello's "Custom Fields"): a board defines them, every card on it can hold a value.
 *
 *   POST   /boards/:id/fields          name, type (+ dropdown options)       PATCH|DELETE /fields/:id
 *   PUT    /boards/:id/fields/order    { ids } every field of the board, in its new order
 *   POST   /fields/:id/options         PATCH|DELETE /field-options/:id
 *   PUT    /cards/:id/fields/:fieldId  { value } for the field's type; null clears it
 *   POST   /cards/:id/copy             a copy of the card at the end of its lane (labels, people, fields, checklists)
 *
 * Same rules as card-detail.ts: the visitor's workspace membership is IN the first query, every write carries
 * `workspace_id`, runs in ONE transaction that bumps `boards.rev` and writes an `activity` row.
 */

type Fail = {status: 403 | 404 | 409; body: ReturnType<typeof problem>};
const fail = (status: Fail['status'], error: string, message: string): Fail => ({status, body: problem(error, message)});

/** The board and the right to edit its fields (any member who can write; read-only workspaces and archived boards refuse). */
async function boardWrite(db: PrismaClient, userId: number, boardId: number | undefined) {
  const access = boardId ? await boardAccess(db, boardId, userId) : null;
  if (!boardId || !access) return fail(404, 'not_found', 'No such board.');
  if (!access.canWrite) return fail(403, 'forbidden', 'You do not have access to this.');
  if (access.archived) return fail(409, 'board_archived', 'This board is archived.');
  const ent = await getEntitlements(db, access.workspaceId);
  if (ent?.readOnly) return fail(409, 'workspace_read_only', 'This workspace is read-only until its plan limits are fixed.');
  return {boardId, workspaceId: access.workspaceId};
}
const failed = (r: object): r is Fail => 'status' in r;

const MEMBER_OF = (userId: number) => ({board: boardReachable(userId)});

const optionInput = (v: Record<string, unknown>): Parsed<{name: string; colorHex: string}> => {
  const name = textField(v.name, 1, 40);
  if (!name.ok) return errAt('name', name.error);
  const hex = hexOf(v.colorHex);
  return hex ? {ok: true, value: {name: name.value, colorHex: hex}} : errAt('colorHex', badHex);
};

const fieldBody = body(v => {
  const name = textField(v.name, 1, 40);
  if (!name.ok) return errAt('name', name.error);
  const type = v.type;
  if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) return errAt('type', {code: 'invalid', message: 'Unknown field type.'});
  const options: {name: string; colorHex: string}[] = [];
  if (v.options !== undefined) {
    if (!Array.isArray(v.options) || v.options.length > FIELD_LIMITS.optionsPerField || (v.options.length > 0 && type !== 'dropdown')) {
      return errAt('options', {code: 'invalid', message: `Only dropdowns take options, up to ${FIELD_LIMITS.optionsPerField}.`});
    }
    for (const raw of v.options) {
      const o = optionInput(raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {});
      if (!o.ok) return {ok: false, errors: o.errors};
      options.push(o.value);
    }
  }
  return {ok: true, value: {name: name.value, type: type as FieldType, options}};
});
const renameBody = body(v => {
  const name = textField(v.name, 1, 40);
  return name.ok ? {ok: true, value: {name: name.value}} : errAt('name', name.error);
});
/** The board's whole field list in its new order: unique ids, at most a board's worth. */
const orderBody = body(v => {
  const ids = Array.isArray(v.ids) ? v.ids : null;
  if (!ids || ids.length < 1 || ids.length > FIELD_LIMITS.perBoard || !ids.every(id => Number.isSafeInteger(id) && (id as number) > 0) || new Set(ids).size !== ids.length) {
    return errAt('ids', {code: 'invalid', message: `Send the board's field ids (1 to ${FIELD_LIMITS.perBoard}), each once.`});
  }
  return {ok: true, value: {ids: ids as number[]}};
});
const optionBody = body(optionInput);
const optionPatchBody = body(v => {
  const out: {name?: string; colorHex?: string} = {};
  if (v.name !== undefined) {
    const name = textField(v.name, 1, 40);
    if (!name.ok) return errAt('name', name.error);
    out.name = name.value;
  }
  if (v.colorHex !== undefined) {
    const hex = hexOf(v.colorHex);
    if (!hex) return errAt('colorHex', badHex);
    out.colorHex = hex;
  }
  return Object.keys(out).length ? {ok: true, value: out} : errAt('name', {code: 'required', message: 'Nothing to change.'});
});
const valueBody = body(v => ('value' in v ? {ok: true, value: {value: v.value}} : errAt('value', {code: 'required', message: 'Send a value (or null to clear it).'})));

/** A field the visitor can edit, reached through its board. */
async function fieldFor(db: PrismaClient, userId: number, fieldId: number | undefined) {
  const field = fieldId ? await db.customField.findFirst({where: {id: fieldId, ...MEMBER_OF(userId)}, select: {id: true, boardId: true, workspaceId: true, name: true}}) : null;
  if (!field) return fail(404, 'not_found', 'No such field.');
  const ctx = await boardWrite(db, userId, field.boardId);
  if (failed(ctx)) return ctx;
  return {...ctx, field};
}

/**
 * One page of a board's values: whole cards only, at most VALUES_TAKE values (20 fields x 250 cards). The Table view
 * reads the pages in turn (`?after=<last card id>`), then only what changed (`?since=<rev>`).
 */
export const VALUES_TAKE = 5000;
/** A delta covers at most this many changed cards (x 20 fields = VALUES_TAKE values); more and the client reads it all again. */
export const DELTA_CARDS = 250;

type ValueRow = Parameters<typeof valueMap>[0][number] & {cardId: number};
const byCard = (rows: ValueRow[], fields: Parameters<typeof valueMap>[1]) => {
  const grouped = new Map<number, ValueRow[]>();
  for (const r of rows) grouped.set(r.cardId, [...(grouped.get(r.cardId) ?? []), r]);
  const values: Record<string, Record<string, FieldValue>> = {};
  for (const [cardId, list] of grouped) values[String(cardId)] = valueMap(list, fields);
  return values;
};
/** `?after=`: absent is 0 (the first page); anything but a card id is null (refused). */
const cursorOf = (raw: string | undefined) => (raw === undefined ? 0 : /^\d{1,10}$/.test(raw) && Number(raw) <= 2_147_483_647 ? Number(raw) : null);

export const cardFieldRoutes = new Hono()
  /* ---- the board's fields and every card's values (the Table view's columns) ---- */
  // `?after=<card id>`: the next page of a full read (answer `nextAfter`, null on the last page).
  // `?since=<rev>`: only the cards changed after that revision (`changed`: their ids, archived ones included, so the
  // client drops them; `values`: the live ones' values; `reset: true` when too much changed: read it all again).
  // Every answer carries `rev`, read FIRST (as /boards/:id/changes does), so a change landing meanwhile is in this
  // answer or comes with the next delta, never skipped.
  .get('/boards/:id/field-values', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    const after = cursorOf(c.req.query('after'));
    const rawSince = c.req.query('since');
    if (!boardId) return notFound(c, 'board');
    if (after === null) return invalid(c, {after: {code: 'invalid', message: 'Send the last card id you have.'}});
    if (rawSince !== undefined && !/^\d{1,15}$/.test(rawSince)) return invalid(c, {since: {code: 'invalid', message: 'Send the revision you have.'}});
    // The board with boardAccess()'s columns (its revision too) and its fields, in one query: nothing more is read
    // unless boardAccess()'s rules pass.
    const board = await db.board.findFirst({
      where: {id: boardId, ...boardReachable(userId)},
      select: {...accessSelect(userId), customFields: {orderBy: [...FIELD_ORDER], take: FIELD_LIMITS.perBoard, select: {...fieldCols, workspaceId: true}}},
    });
    const access = board ? resolveAccess(board, userId) : null;
    if (!board || !access) return notFound(c, 'board');
    const {workspaceId} = access;
    const rev = String(board.rev);
    const fields = board.customFields.filter(f => f.workspaceId === workspaceId);
    if (!fields.length) return c.json({fields: [], values: {}, rev, nextAfter: null, changed: []});
    const shapes = fields.map(fieldShape);

    if (rawSince !== undefined) {
      const since = BigInt(rawSince);
      if (since > board.rev) return c.json({fields: shapes, values: {}, rev, reset: true});
      const upto = {gt: since, lte: board.rev};
      const [changed, rows] = await Promise.all([
        db.card.findMany({where: {workspaceId, boardId, updatedRev: upto}, orderBy: {updatedRev: 'asc'}, take: DELTA_CARDS + 1, select: {id: true}}),
        db.cardFieldValue.findMany({
          where: {workspaceId, field: {boardId}, card: {workspaceId, boardId, archivedAt: null, updatedRev: upto}},
          orderBy: [{cardId: 'asc'}, {fieldId: 'asc'}],
          take: DELTA_CARDS * FIELD_LIMITS.perBoard,
          select: {cardId: true, ...valueCols},
        }),
      ]);
      if (changed.length > DELTA_CARDS) return c.json({fields: shapes, values: {}, rev, reset: true});
      return c.json({fields: shapes, values: byCard(rows, fields), changed: changed.map(r => r.id), rev});
    }

    const rows = await db.cardFieldValue.findMany({
      where: {workspaceId, field: {boardId}, card: {workspaceId, boardId, archivedAt: null}, ...(after ? {cardId: {gt: after}} : {})},
      orderBy: [{cardId: 'asc'}, {fieldId: 'asc'}],
      take: VALUES_TAKE + 1,
      select: {cardId: true, ...valueCols},
    });
    // One row past the page says whether there is more, and whether the page's last card goes on past it: then that
    // card is left for the next page, so every card comes whole (a card holds at most 20 values, far below a page).
    let nextAfter: number | null = null;
    if (rows.length > VALUES_TAKE) {
      const extra = rows.pop()!;
      while (rows.length && rows[rows.length - 1]!.cardId === extra.cardId) rows.pop();
      nextAfter = rows.length ? rows[rows.length - 1]!.cardId : null;
    }
    return c.json({fields: shapes, values: byCard(rows, fields), rev, nextAfter});
  })

  .post('/boards/:id/fields', fieldBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await boardWrite(c.var.db, userId, idOf(c.req.param('id')));
    if (failed(ctx)) return c.json(ctx.body, ctx.status);
    const input = c.req.valid('json');
    const out = await atomically(c.var.db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const {_count, _max} = await tx.customField.aggregate({where: {workspaceId: ctx.workspaceId, boardId: ctx.boardId}, _count: {_all: true}, _max: {position: true}});
      if (_count._all >= FIELD_LIMITS.perBoard) return 'limit' as const;
      const field = await tx.customField.create({
        data: {
          workspaceId: ctx.workspaceId,
          boardId: ctx.boardId,
          name: input.name,
          type: input.type,
          position: (_max.position ?? 0) + 1,
          options: {create: input.options.map(o => ({workspaceId: ctx.workspaceId, name: o.name, colorHex: o.colorHex}))},
        },
        select: fieldCols,
      });
      await tx.activity.create({data: {workspaceId: ctx.workspaceId, boardId: ctx.boardId, actorId: userId, kind: 'field.created', meta: {fieldId: field.id, name: field.name}}});
      return {field: fieldShape(field), rev: String(rev)};
    });
    if (out === 'limit') return c.json(problem('limit_reached', `A board holds up to ${FIELD_LIMITS.perBoard} custom fields.`), 409);
    return out ? c.json(out, 201) : notFound(c, 'board');
  })

  /* The whole list, so two people dragging at once can't interleave: a list that no longer matches the board is refused (409 stale). */
  .put('/boards/:id/fields/order', orderBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await boardWrite(c.var.db, userId, idOf(c.req.param('id')));
    if (failed(ctx)) return c.json(ctx.body, ctx.status);
    const {ids} = c.req.valid('json');
    const out = await atomically(c.var.db, async tx => {
      const current = await tx.customField.findMany({where: {boardId: ctx.boardId, workspaceId: ctx.workspaceId}, take: FIELD_LIMITS.perBoard + 1, select: {id: true}});
      const known = new Set(current.map(f => f.id));
      if (current.length !== ids.length || !ids.every(id => known.has(id))) return 'stale' as const;
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      await tx.$executeRaw`
        UPDATE custom_fields f SET position = v.pos::int
        FROM unnest(${ids}::int[]) WITH ORDINALITY AS v(id, pos)
        WHERE f.id = v.id AND f.board_id = ${ctx.boardId} AND f.workspace_id = ${ctx.workspaceId}`;
      await tx.activity.create({data: {workspaceId: ctx.workspaceId, boardId: ctx.boardId, actorId: userId, kind: 'field.reordered', meta: {count: ids.length}}});
      return {ids, rev: String(rev)};
    });
    if (out === 'stale') return c.json(problem('stale', 'The fields changed meanwhile. Reload and try again.'), 409);
    return out ? c.json(out) : notFound(c, 'board');
  })

  .patch('/fields/:id', renameBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await fieldFor(c.var.db, userId, idOf(c.req.param('id')));
    if (failed(ctx)) return c.json(ctx.body, ctx.status);
    const {name} = c.req.valid('json');
    const out = await atomically(c.var.db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const {count} = await tx.customField.updateMany({where: {id: ctx.field.id, boardId: ctx.boardId, workspaceId: ctx.workspaceId}, data: {name}});
      if (!count) throw new Gone();
      await tx.activity.create({data: {workspaceId: ctx.workspaceId, boardId: ctx.boardId, actorId: userId, kind: 'field.renamed', meta: {fieldId: ctx.field.id, name}}});
      return {rev: String(rev)};
    });
    return out ? c.json({field: {id: ctx.field.id, name}, ...out}) : notFound(c, 'field');
  })

  .delete('/fields/:id', withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await fieldFor(c.var.db, userId, idOf(c.req.param('id')));
    if (failed(ctx)) return c.json(ctx.body, ctx.status);
    const out = await atomically(c.var.db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      await tx.customField.deleteMany({where: {id: ctx.field.id, boardId: ctx.boardId, workspaceId: ctx.workspaceId}});
      await tx.activity.create({data: {workspaceId: ctx.workspaceId, boardId: ctx.boardId, actorId: userId, kind: 'field.deleted', meta: {name: ctx.field.name}}});
      return {rev: String(rev)};
    });
    return out ? c.json(out) : notFound(c, 'field');
  })

  .post('/fields/:id/options', optionBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await fieldFor(c.var.db, userId, idOf(c.req.param('id')));
    if (failed(ctx)) return c.json(ctx.body, ctx.status);
    const input = c.req.valid('json');
    const out = await atomically(c.var.db, async tx => {
      const field = await tx.customField.findFirst({where: {id: ctx.field.id, boardId: ctx.boardId, workspaceId: ctx.workspaceId}, select: {type: true}});
      if (!field) return null;
      if (field.type !== 'dropdown') return 'type' as const;
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      if ((await tx.customFieldOption.count({where: {fieldId: ctx.field.id, workspaceId: ctx.workspaceId}})) >= FIELD_LIMITS.optionsPerField) return 'limit' as const;
      const option = await tx.customFieldOption.create({data: {fieldId: ctx.field.id, workspaceId: ctx.workspaceId, ...input}, select: {id: true, name: true, colorHex: true}});
      return {option, rev: String(rev)};
    });
    if (out === 'limit') return c.json(problem('limit_reached', `A dropdown holds up to ${FIELD_LIMITS.optionsPerField} options.`), 409);
    if (out === 'type') return invalid(c, {type: {code: 'invalid', message: 'Only dropdown fields have options.'}});
    return out ? c.json(out, 201) : notFound(c, 'field');
  })

  .patch('/field-options/:id', optionPatchBody, withViewer, requireAuth, withDb, noStore, async c => optionWrite(c, 'update'))
  .delete('/field-options/:id', withViewer, requireAuth, withDb, noStore, async c => optionWrite(c, 'delete'))

  /* ---- copy: the same card, last in its lane. Comments, attachments and the done mark stay behind. ---- */
  .post('/cards/:id/copy', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    const src = await db.card.findFirst({
      where: {id: ctx.cardId, boardId: ctx.boardId, workspaceId: ctx.workspaceId},
      select: {
        title: true, laneId: true, descriptionMd: true, priority: true, estimateMinutes: true, startDate: true, dueDate: true,
        labels: {select: {labelId: true}, take: 50},
        members: {select: {userId: true}, take: 50},
        fieldValues: {select: {fieldId: true, textValue: true, numberValue: true, dateValue: true, boolValue: true, optionId: true}, take: FIELD_LIMITS.perBoard},
        checklists: {orderBy: [{position: 'asc'}, {id: 'asc'}], take: 20, select: {title: true, position: true, items: {orderBy: [{position: 'asc'}, {id: 'asc'}], take: 100, select: {text: true, position: true}}}},
      },
    });
    if (!src) return notFound(c, 'card');
    const out = await atomically(db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const last = await tx.card.findFirst({where: {workspaceId: ctx.workspaceId, laneId: src.laneId, archivedAt: null}, orderBy: [{position: 'desc'}, {id: 'desc'}], select: {position: true}});
      const room = await tx.$queryRaw<{id: number}[]>`
        UPDATE lanes SET card_count = card_count + 1, updated_rev = ${rev}
        WHERE id = ${src.laneId} AND board_id = ${ctx.boardId} AND workspace_id = ${ctx.workspaceId} AND card_count + 1 <= ${MAX_CARDS_PER_LANE}::int
        RETURNING id`;
      if (!room[0]) return 'full' as const;
      const items = src.checklists.reduce((n, l) => n + l.items.length, 0);
      const number = await reserveCardNumbers(tx, ctx.boardId, ctx.workspaceId, 1);
      const copy = await tx.card.create({
        data: {
          number,
          boardId: ctx.boardId, laneId: src.laneId, workspaceId: ctx.workspaceId,
          title: `${src.title} (copy)`.slice(0, 200),
          descriptionMd: src.descriptionMd, priority: src.priority, estimateMinutes: src.estimateMinutes, startDate: src.startDate, dueDate: src.dueDate,
          position: generateKeyBetween(last?.position ?? null, null),
          checklistTotal: items, checklistDone: 0, updatedRev: rev, createdBy: userId,
        },
        select: {id: true},
      });
      await copyCardParts(tx, ctx.workspaceId, copy.id, src);
      await tx.activity.create({data: {workspaceId: ctx.workspaceId, boardId: ctx.boardId, cardId: copy.id, actorId: userId, kind: 'card.created', meta: {title: `${src.title} (copy)`, copiedFrom: ctx.cardId}}});
      return {cardId: copy.id, rev: String(rev)};
    });
    if (out === 'full') return c.json(problem('lane_card_limit', `A lane holds up to ${MAX_CARDS_PER_LANE} cards.`), 409);
    return out ? c.json(out, 201) : notFound(c, 'card');
  })

  /* ---- a card's value ---- */
  .put('/cards/:id/fields/:fieldId', valueBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    const fieldId = idOf(c.req.param('fieldId'));
    const field = fieldId ? await db.customField.findFirst({where: {id: fieldId, boardId: ctx.boardId, workspaceId: ctx.workspaceId}, select: {id: true, name: true, type: true}}) : null;
    if (!field) return notFound(c, 'field');
    const {value} = c.req.valid('json') as {value: unknown};
    const bad = (message: string) => invalid(c, {value: {code: 'invalid', message} as FieldError});
    // One typed column per kind; `null` (or an empty text) clears the value.
    const row: {textValue?: string; numberValue?: number; dateValue?: Date; boolValue?: boolean; optionId?: number} = {};
    if (value !== null) {
      if (field.type === 'text') {
        const text = typeof value === 'string' ? value.trim() : null;
        if (text === null || text.length > 200) return bad('Use at most 200 characters.');
        if (text) row.textValue = text;
      } else if (field.type === 'number') {
        if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12) return bad('Enter a number.');
        row.numberValue = value;
      } else if (field.type === 'date') {
        const d = dateOnly(value);
        if (!d.ok || !d.value) return bad('Use a date like 2026-12-31.');
        row.dateValue = d.value;
      } else if (field.type === 'checkbox') {
        if (typeof value !== 'boolean') return bad('Use true or false.');
        row.boolValue = value;
      } else {
        const optionId = idOf(typeof value === 'number' ? String(value) : value);
        const ok = optionId ? await db.customFieldOption.findFirst({where: {id: optionId, fieldId: field.id, workspaceId: ctx.workspaceId}, select: {id: true}}) : null;
        if (!ok) return bad('Pick one of the options.');
        row.optionId = ok.id;
      }
    }
    const clears = Object.keys(row).length === 0;
    const out = await atomically(db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const key = {cardId: ctx.cardId, fieldId: field.id};
      if (clears) await tx.cardFieldValue.deleteMany({where: {...key, workspaceId: ctx.workspaceId}});
      else {
        const full = {textValue: null, numberValue: null, dateValue: null, boolValue: null, optionId: null, ...row};
        await tx.cardFieldValue.upsert({where: {cardId_fieldId: key}, create: {...key, workspaceId: ctx.workspaceId, ...full}, update: full});
      }
      return finish(tx, ctx, userId, rev, 'card.field_set', {fieldId: field.id, name: field.name, cleared: clears});
    });
    return out ? c.json(out) : notFound(c, 'card');
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the two option routes share this body; Hono's context type is per route
async function optionWrite(c: Context<any>, mode: 'update' | 'delete') {
  const db = c.var.db;
  const userId = c.var.viewer.id!;
  const optionId = idOf(c.req.param('id'));
  const option = optionId ? await db.customFieldOption.findFirst({where: {id: optionId, field: MEMBER_OF(userId)}, select: {id: true, fieldId: true, workspaceId: true, field: {select: {boardId: true}}}}) : null;
  if (!option) return notFound(c, 'option');
  const ctx = await boardWrite(db, userId, option.field.boardId);
  if (failed(ctx)) return c.json(ctx.body, ctx.status);
  if (ctx.workspaceId !== option.workspaceId) return notFound(c, 'option');
  const patch = mode === 'update' ? ((c.req as unknown as {valid: (t: 'json') => unknown}).valid('json') as {name?: string; colorHex?: string}) : null;
  const out = await atomically(db, async tx => {
    const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
    const where = {id: option.id, fieldId: option.fieldId, workspaceId: ctx.workspaceId};
    if (patch) await tx.customFieldOption.updateMany({where, data: patch});
    else await tx.customFieldOption.deleteMany({where});
    return {rev: String(rev)};
  });
  if (!out) return notFound(c, 'option');
  if (!patch) return c.json(out);
  const fresh = await db.customFieldOption.findFirst({where: {id: option.id, workspaceId: ctx.workspaceId}, select: {id: true, name: true, colorHex: true}});
  return fresh ? c.json({option: fresh, ...out}) : notFound(c, 'option');
}

