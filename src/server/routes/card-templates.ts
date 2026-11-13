import {generateKeyBetween} from 'fractional-indexing';
import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {getEntitlements, MAX_CARD_TEMPLATES} from '../entitlements';
import {idOf, invalid, objectOf, textField, type FieldError} from '../validation';
import {membership, notFound, rankOf} from '../workspaces';
import {atomically, bumpRev, cardCtx, finish, Gone, noStore, refused, send} from './card-detail';

/**
 * Card templates: a card's title pattern, description, priority, estimate, checklists and label names, saved per
 * workspace and applied to a card (the create-card dialog makes the card, then applies the template).
 *
 *   GET    /workspaces/:id/card-templates   every member: the templates (newest first, at most MAX_CARD_TEMPLATES)
 *   POST   /workspaces/:id/card-templates   {name, payload}: member or above
 *   POST   /cards/:id/save-template         {name}: a template from this card (member or above)
 *   POST   /cards/:id/apply-template        {templateId}: fills THIS card (a card you may write to)
 *   DELETE /card-templates/:id              its author, or a workspace admin
 *
 * The workspace is IN every `where` (membership first); a template of another workspace answers 404. The stored
 * payload is parsed again on the way out, so a malformed row is never served. Labels are kept by NAME and matched
 * to the target board's labels on apply (names that do not exist there are skipped).
 */

export const TEMPLATE_LIMITS = {name: 80, title: 200, description: 20000, checklists: 20, checklistTitle: 100, items: 100, itemText: 300, totalItems: 200, labels: 20, labelName: 40, estimateMax: 1_000_000};
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

export type TemplatePayload = {
  title: string;
  description: string;
  priority: (typeof PRIORITIES)[number];
  estimateMinutes: number | null;
  checklists: {title: string; items: string[]}[];
  labels: string[];
};

const err = (code: string, message: string): {ok: false; error: FieldError} => ({ok: false, error: {code, message}});

/** The payload, strictly: known keys only, each of the right type and size, bounded counts. */
export function parsePayload(value: unknown): {ok: true; value: TemplatePayload} | {ok: false; error: FieldError} {
  const v = objectOf(value);
  if (!v) return err('invalid', 'Send the template as an object.');
  const L = TEMPLATE_LIMITS;
  const allowed = new Set(['title', 'description', 'priority', 'estimateMinutes', 'checklists', 'labels']);
  if (Object.keys(v).some(k => !allowed.has(k))) return err('invalid', 'That template has fields Lanefold does not know.');
  const title = textField(v.title ?? '', 0, L.title);
  if (!title.ok) return title;
  const description = typeof (v.description ?? '') === 'string' && ((v.description ?? '') as string).length <= L.description ? ((v.description ?? '') as string).trim() : null;
  if (description === null) return err('too_long', `Use at most ${L.description} characters.`);
  const priority = v.priority ?? 'none';
  if (typeof priority !== 'string' || !(PRIORITIES as readonly string[]).includes(priority)) return err('invalid', 'Unknown priority.');
  let estimate: number | null = null;
  if (v.estimateMinutes !== undefined && v.estimateMinutes !== null) {
    if (typeof v.estimateMinutes !== 'number' || !Number.isSafeInteger(v.estimateMinutes) || v.estimateMinutes < 0 || v.estimateMinutes > L.estimateMax) return err('out_of_range', 'Use a whole number of minutes.');
    estimate = v.estimateMinutes;
  }
  const rawLists = v.checklists ?? [];
  if (!Array.isArray(rawLists) || rawLists.length > L.checklists) return err('too_many', `Use at most ${L.checklists} checklists.`);
  const checklists: TemplatePayload['checklists'] = [];
  let total = 0;
  for (const raw of rawLists) {
    const o = objectOf(raw);
    const t = textField(o?.title, 1, L.checklistTitle);
    if (!o || !t.ok) return err('invalid', `Each checklist needs a title of up to ${L.checklistTitle} characters.`);
    if (!Array.isArray(o.items) || o.items.length > L.items) return err('too_many', `A checklist holds up to ${L.items} items.`);
    const items: string[] = [];
    for (const item of o.items) {
      const text = textField(item, 1, L.itemText);
      if (!text.ok) return err('invalid', `Each item needs 1 to ${L.itemText} characters.`);
      items.push(text.value);
    }
    total += items.length;
    if (total > L.totalItems) return err('too_many', `A template holds up to ${L.totalItems} checklist items.`);
    checklists.push({title: t.value, items});
  }
  const rawLabels = v.labels ?? [];
  if (!Array.isArray(rawLabels) || rawLabels.length > L.labels) return err('too_many', `Use at most ${L.labels} labels.`);
  const labels: string[] = [];
  for (const raw of rawLabels) {
    const n = textField(raw, 1, L.labelName);
    if (!n.ok) return err('invalid', `A label name has 1 to ${L.labelName} characters.`);
    if (!labels.some(x => x.toLowerCase() === n.value.toLowerCase())) labels.push(n.value);
  }
  return {ok: true, value: {title: title.value, description, priority: priority as TemplatePayload['priority'], estimateMinutes: estimate, checklists, labels}};
}

const nameOf = (value: unknown) => textField(value, 1, TEMPLATE_LIMITS.name);

const createBody = validator('json', (value, c) => {
  const v = objectOf(value) ?? {};
  const name = nameOf(v.name);
  const payload = parsePayload(v.payload);
  const errors: Record<string, FieldError> = {};
  if (!name.ok) errors.name = name.error;
  if (!payload.ok) errors.payload = payload.error;
  if (!name.ok || !payload.ok) return invalid(c, errors);
  return {name: name.value, payload: payload.value};
});
const nameBody = validator('json', (value, c) => {
  const name = nameOf(objectOf(value)?.name);
  return name.ok ? {name: name.value} : invalid(c, {name: name.error});
});
const applyBody = validator('json', (value, c) => {
  const id = objectOf(value)?.templateId;
  const n = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 2_147_483_647 ? id : 0;
  return n ? {templateId: n} : invalid(c, {templateId: {code: 'required', message: 'Pick a template.'}});
});

const SELECT = {id: true, name: true, payload: true, createdBy: true, createdAt: true} as const;
type Row = {id: number; name: string; payload: unknown; createdBy: number | null; createdAt: Date};
const present = (r: Row, me: number) => {
  const payload = parsePayload(r.payload);
  return payload.ok ? {id: r.id, name: r.name, payload: payload.value, mine: r.createdBy === me, createdAt: r.createdAt.toISOString()} : null;
};

const full = () => problem('limit_reached', `A workspace keeps up to ${MAX_CARD_TEMPLATES} card templates.`);
const readOnly = () => problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.');

export const cardTemplateRoutes = new Hono()
  .get('/workspaces/:id/card-templates', withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const workspaceId = idOf(c.req.param('id'));
    const member = workspaceId ? await membership(c.var.db, workspaceId, userId) : null;
    if (!workspaceId || !member) return notFound(c);
    const rows = await c.var.db.cardTemplate.findMany({where: {workspaceId, kind: 'card'}, orderBy: {id: 'desc'}, take: MAX_CARD_TEMPLATES, select: SELECT});
    return c.json({items: rows.map(r => present(r, userId)).filter(Boolean), max: MAX_CARD_TEMPLATES, canManage: member.rank >= rankOf('member')});
  })

  .post('/workspaces/:id/card-templates', createBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const workspaceId = idOf(c.req.param('id'));
    const member = workspaceId ? await membership(c.var.db, workspaceId, userId) : null;
    if (!workspaceId || !member) return notFound(c);
    if (member.rank < rankOf('member')) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    return store(c, workspaceId, userId, c.req.valid('json'));
  })

  .post('/cards/:id/save-template', nameBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    if (rankOf(ctx.access.workspaceRole) < rankOf('member')) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    const L = TEMPLATE_LIMITS;
    const where = {id: ctx.cardId, boardId: ctx.boardId, workspaceId: ctx.workspaceId};
    const card = await db.card.findFirst({
      where,
      select: {
        title: true,
        descriptionMd: true,
        priority: true,
        estimateMinutes: true,
        labels: {take: L.labels, select: {label: {select: {name: true}}}},
        checklists: {
          take: L.checklists,
          orderBy: [{position: 'asc'}, {id: 'asc'}],
          select: {title: true, items: {take: L.items, orderBy: [{position: 'asc'}, {id: 'asc'}], select: {text: true}}},
        },
      },
    });
    if (!card) return notFound(c, 'card');
    let left = L.totalItems;
    const checklists = card.checklists.map(list => {
      const items = list.items.map(i => i.text).slice(0, left);
      left -= items.length;
      return {title: list.title, items};
    });
    const payload = parsePayload({
      title: card.title,
      description: card.descriptionMd,
      priority: card.priority,
      estimateMinutes: card.estimateMinutes,
      checklists,
      labels: card.labels.map(l => l.label.name),
    });
    if (!payload.ok) return invalid(c, {payload: payload.error});
    return store(c, ctx.workspaceId, userId, {name: c.req.valid('json').name, payload: payload.value});
  })

  .post('/cards/:id/apply-template', applyBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    // Templates belong to the workspace: a guest (a seat on one shared board, no membership) can't list them,
    // so they can't apply one either (applying would copy its content onto a card they can read).
    if (ctx.access.guest) return notFound(c, 'template');
    const row = await db.cardTemplate.findFirst({where: {id: c.req.valid('json').templateId, workspaceId: ctx.workspaceId, kind: 'card'}, select: {payload: true}});
    const parsed = row ? parsePayload(row.payload) : null;
    if (!parsed?.ok) return notFound(c, 'template');
    const t = parsed.value;
    const out = await atomically(db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const where = {workspaceId: ctx.workspaceId, cardId: ctx.cardId};
      const card = await tx.card.findFirst({where: {id: ctx.cardId, boardId: ctx.boardId, workspaceId: ctx.workspaceId, archivedAt: null}, select: {descriptionMd: true, priority: true, estimateMinutes: true}});
      if (!card) throw new Gone();
      if ((await tx.checklist.count({where})) + t.checklists.length > TEMPLATE_LIMITS.checklists) return 'limit' as const;
      // Only empty fields are filled: applying a template never overwrites what the card already says.
      const data: {descriptionMd?: string; priority?: string; estimateMinutes?: number} = {};
      if (t.description && !card.descriptionMd.trim()) data.descriptionMd = t.description;
      if (t.priority !== 'none' && card.priority === 'none') data.priority = t.priority;
      if (t.estimateMinutes !== null && card.estimateMinutes === null) data.estimateMinutes = t.estimateMinutes;
      let itemCount = 0;
      if (t.checklists.length) {
        const last = await tx.checklist.findFirst({where, orderBy: [{position: 'desc'}, {id: 'desc'}], select: {position: true}});
        let prev = last?.position ?? null;
        const lists = await tx.checklist.createManyAndReturn({
          data: t.checklists.map(l => ({...where, title: l.title, position: (prev = generateKeyBetween(prev, null))})),
          select: {id: true},
        });
        const items = t.checklists.flatMap((l, i) => {
          let p: string | null = null;
          return l.items.map(text => ({workspaceId: ctx.workspaceId, checklistId: lists[i]!.id, text, position: (p = generateKeyBetween(p, null))}));
        });
        itemCount = items.length;
        if (items.length) await tx.checklistItem.createMany({data: items});
      }
      if (t.labels.length) {
        const labels = await tx.label.findMany({where: {boardId: ctx.boardId, workspaceId: ctx.workspaceId}, take: 50, select: {id: true, name: true}});
        const wanted = new Set(t.labels.map(n => n.toLowerCase()));
        const ids = labels.filter(l => wanted.has(l.name.toLowerCase())).map(l => ({cardId: ctx.cardId, labelId: l.id}));
        if (ids.length) await tx.cardLabel.createMany({data: ids, skipDuplicates: true});
      }
      return finish(tx, ctx, userId, rev, 'card.template_applied', {templateId: c.req.valid('json').templateId}, {...data, ...(itemCount ? {checklistTotal: {increment: itemCount}} : {})});
    });
    if (out === 'limit') return c.json(problem('limit_reached', `A card holds up to ${TEMPLATE_LIMITS.checklists} checklists.`), 409);
    return out ? c.json(out) : notFound(c, 'card');
  })

  .delete('/card-templates/:id', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const id = idOf(c.req.param('id'));
    const row = id ? await db.cardTemplate.findFirst({where: {id, kind: 'card', workspace: {archivedAt: null, members: {some: {userId}}}}, select: {workspaceId: true, createdBy: true}}) : null;
    if (!id || !row) return notFound(c, 'template');
    const member = await membership(db, row.workspaceId, userId);
    if (!member) return notFound(c, 'template');
    if (row.createdBy !== userId && member.rank < rankOf('admin')) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    // Deleting frees room, so it is allowed in a read-only workspace.
    const {count} = await db.cardTemplate.deleteMany({where: {id, workspaceId: row.workspaceId, kind: 'card'}});
    return count ? c.json({ok: true}) : notFound(c, 'template');
  });

async function store(c: {var: {db: import('../../generated/prisma/client').PrismaClient}; json: (b: unknown, s?: number) => Response}, workspaceId: number, userId: number, data: {name: string; payload: TemplatePayload}) {
  const db = c.var.db;
  const ent = await getEntitlements(db, workspaceId);
  if (ent?.readOnly) return c.json(readOnly(), 409);
  const created = await db.$transaction(async tx => {
    // Saves in one workspace take turns, so the cap holds under double clicks.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${workspaceId}::int, 7101)`;
    if ((await tx.cardTemplate.count({where: {workspaceId, kind: 'card'}})) >= MAX_CARD_TEMPLATES) return null;
    return tx.cardTemplate.create({data: {workspaceId, kind: 'card', name: data.name, payload: data.payload, createdBy: userId}, select: SELECT});
  });
  if (!created) return c.json(full(), 409);
  return c.json({item: present(created, userId)}, 201);
}
