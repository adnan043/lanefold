import {Hono} from 'hono';

import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {checkRule, MAX_RULES_PER_WORKSPACE} from '../../lib/recurrence';
import {idOf, invalid, type FieldError} from '../validation';
import {notFound} from '../workspaces';
import {atomically, body, bumpRev, cardCtx, finish, Gone, noStore, refused, send} from './card-detail';

/**
 * A card's repeat rule: every N days, weeks or months, optionally until a day. The scheduled job
 * (`src/server/jobs/recurring-cards.ts`) makes the copies; these routes only keep the rule.
 *
 *   GET    /cards/:id/recurrence   the rule or `{recurrence: null}`  (anyone who can see the card)
 *   PUT    /cards/:id/recurrence   { frequency, interval, startOn, endsOn? }  create or replace (writers)
 *   DELETE /cards/:id/recurrence   stop repeating (writers; allowed in a read-only workspace so it can be turned off)
 *
 * Access is cardCtx (membership IN its first query; 404 for a card of another workspace, 403 for a viewer, 409 for an
 * archived board). A copy carries no rule, and a card in a personal inbox cannot repeat.
 */

const RULE_FIELD_MESSAGES: Record<string, FieldError> = {
  frequency: {code: 'invalid', message: 'Use daily, weekly or monthly.'},
  interval: {code: 'invalid', message: 'Use a whole number from 1 to 99.'},
  startOn: {code: 'invalid', message: 'Use a date like 2026-12-31.'},
  endsOn: {code: 'invalid', message: 'Use a date like 2026-12-31.'},
};
const PAST: FieldError = {code: 'recurrence_past', message: 'Pick today or a later day.'};
const END_BEFORE: FieldError = {code: 'recurrence_end_before_start', message: 'The last day cannot be before the first.'};

const todayUtc = () => new Date().toISOString().slice(0, 10);
const dayDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const ruleBody = body(v => {
  const checked = checkRule({frequency: v.frequency, interval: v.interval, startOn: v.startOn, endsOn: v.endsOn}, todayUtc());
  if (checked.ok) return {ok: true, value: checked.value};
  const errors: Record<string, FieldError> = {};
  for (const [name, why] of Object.entries(checked.fields)) {
    errors[name] = why === 'past' ? PAST : why === 'before_start' ? END_BEFORE : RULE_FIELD_MESSAGES[name]!;
  }
  return {ok: false, errors};
});

const shape = (r: {frequency: string; intervalCount: number; anchorOn: Date; endsOn: Date | null; nextRunOn: Date; lastRunOn: Date | null; enabled: boolean}) => ({
  frequency: r.frequency,
  interval: r.intervalCount,
  startOn: dayOf(r.anchorOn)!,
  endsOn: dayOf(r.endsOn),
  nextRunOn: r.enabled ? dayOf(r.nextRunOn) : null,
  lastRunOn: dayOf(r.lastRunOn),
  enabled: r.enabled,
});
const select = {frequency: true, intervalCount: true, anchorOn: true, endsOn: true, nextRunOn: true, lastRunOn: true, enabled: true} as const;

export const cardRecurrenceRoutes = new Hono()
  .get('/cards/:id/recurrence', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const ctx = await cardCtx(db, c.var.viewer.id!, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return send(c, ctx);
    const rule = await db.cardRecurrence.findFirst({where: {cardId: ctx.cardId, workspaceId: ctx.workspaceId}, select});
    return c.json({recurrence: rule ? shape(rule) : null});
  })

  .put('/cards/:id/recurrence', ruleBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    if (ctx.inboxOf !== null) return c.json(problem('recurrence_inbox', 'Cards in an inbox cannot repeat.'), 409);
    const input = c.req.valid('json');
    const out = await atomically(db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId); // the board lock: two people editing the rule take turns
      const existing = await tx.cardRecurrence.findFirst({where: {cardId: ctx.cardId, workspaceId: ctx.workspaceId}, select: {cardId: true, enabled: true}});
      if (!existing?.enabled) {
        const live = await tx.cardRecurrence.count({where: {workspaceId: ctx.workspaceId, enabled: true}});
        if (live >= MAX_RULES_PER_WORKSPACE) return 'limit' as const;
      }
      const data = {
        frequency: input.frequency,
        intervalCount: input.interval,
        anchorOn: dayDate(input.startOn),
        nextRunOn: dayDate(input.startOn),
        endsOn: input.endsOn ? dayDate(input.endsOn) : null,
        enabled: true,
      };
      const rule = await tx.cardRecurrence.upsert({
        where: {cardId: ctx.cardId},
        create: {...data, cardId: ctx.cardId, workspaceId: ctx.workspaceId, boardId: ctx.boardId, createdBy: userId},
        update: data,
        select,
      });
      const done = await finish(tx, ctx, userId, rev, 'card.recurrence_set', {frequency: input.frequency, interval: input.interval});
      return {...done, recurrence: shape(rule)};
    });
    if (out === 'limit') return c.json(problem('recurrence_limit', `A workspace can have up to ${MAX_RULES_PER_WORKSPACE} repeating cards.`), 409);
    return out ? c.json(out) : notFound(c, 'card');
  })

  .delete('/cards/:id/recurrence', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'remove');
    if (refused(ctx)) return send(c, ctx);
    const out = await atomically(db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const {count} = await tx.cardRecurrence.deleteMany({where: {cardId: ctx.cardId, workspaceId: ctx.workspaceId}});
      if (!count) throw new Gone();
      const done = await finish(tx, ctx, userId, rev, 'card.recurrence_removed', null);
      return {...done, recurrence: null};
    });
    return out ? c.json(out) : notFound(c, 'recurrence');
  });
