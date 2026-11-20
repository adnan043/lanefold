import {type Context, Hono} from 'hono';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {MAX_CARDS_PER_LANE} from '../entitlements';
import {runFlows} from '../flows/engine';
import {notify} from '../notifications';
import {idOf, invalid, type FieldError} from '../validation';
import {notFound} from '../workspaces';
import {body, dateOnly, errAt, noStore, type Parsed, seatFilter} from './card-detail';
import {boardFor, bumpRev, cardFinder, DUE_BEFORE_START, keysAtEnd, refused} from './boards';
import {afterResponse} from '../after-response';

/**
 * Bulk actions on the cards of ONE board (Trello's "select cards" bar).
 *
 *   POST /boards/:id/cards/bulk  {cardIds: 1..50, action, ...params}
 *   GET  /boards/:id/labels      the board's labels (the bar's "Labels" menu)
 *
 *   action        params        what it does to every selected card
 *   move          laneId        to the end of that lane (same board); the cards keep their order
 *   archive       -             archive
 *   label_add     labelId       add a label of this board
 *   label_remove  labelId       take it off
 *   assign        userId        assign a person who has a seat on this board
 *   unassign      userId        take them off
 *   set_due       dueDate       YYYY-MM-DD, or null to clear
 *   set_priority  priority      none | low | medium | high | urgent
 *   restore       -             the inverse of archive (only the Undo sends it): archived cards of THIS board come back
 *
 *   Optional `ifUnchangedSince: "<rev>"` (only the Undo sends it): every card is still checked against this board and
 *   workspace (an id of another board is the same 404), but a card that is in another state now or was written after
 *   that rev (`cards.updated_rev` > rev) is SKIPPED instead of failing the request, so an Undo never overwrites what
 *   someone did since. The answer then says `skipped`.
 *
 *   The answer carries `undo`: the exact inverse, ready to POST back, built from what the transaction READ under the
 *   board lock (so it is right even for labels or people the card face does not list). One step per distinct previous
 *   value, at most MAX_UNDO_STEPS (more: no `undo`). What an Undo does NOT take back: the follow and the bell
 *   notification an assignee got, and the exact position inside a lane (a move comes back to the END of the old lane).
 *
 * Rules (server side; the client only offers them):
 *  - Write access to the board (boardFor: 404 not visible, 403 viewer, 409 archived board or read-only workspace).
 *  - ALL or NOTHING. Every id must be a live card of THIS board and workspace, read under the board row lock; one id
 *    that is not (another board, another workspace, archived, missing) is a 404 for the whole request and the
 *    transaction (rev bump included) rolls back. A move that would pass the lane's cap is a 409 and changes nothing.
 *  - What does not depend on the cards' state (the target lane, the label, the person's seat, from the access boardFor
 *    already read) is checked BEFORE the transaction; under the board lock only the cards (and their labels or people)
 *    are read, side by side, then ONE statement writes everything (conditional on the lane, label and seat again).
 *  - One transaction, one board lock, ONE rev bump. Every write is set based (one UPDATE .. unnest / INSERT .. SELECT):
 *    no query per card.
 *  - `set_due`: a due day never before a card's start day (the card panel's rule, 422 on dueDate); an Undo skips such
 *    cards instead.
 *  - Side effects, bounded: ONE activity row for the whole action (`cards.bulk`, meta {action, count, cardIds}); an
 *    assignee follows the cards and gets ONE bell notification (pointing at the first card they were added to);
 *    followers of the cards are NOT told one by one (bulk edits would flood them); Flows run for the first 20 moved
 *    cards only (the engine's own batch size).
 */

export const MAX_BULK_CARDS = 50;
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
/** Same limit as the card panel's assignees. */
const MAX_ASSIGNEES = 50;

/** The most inverse requests an Undo may need (one per distinct previous value); more and no Undo is offered. */
export const MAX_UNDO_STEPS = 8;

export type BulkInput = {cardIds: number[]; since?: bigint} & (
  | {action: 'move'; laneId: number}
  | {action: 'archive'}
  | {action: 'restore'}
  | {action: 'label_add' | 'label_remove'; labelId: number}
  | {action: 'assign' | 'unassign'; userId: number}
  | {action: 'set_due'; dueDate: Date | null}
  | {action: 'set_priority'; priority: string}
);

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2_147_483_647;
const need = (name: string, message: string): Parsed<never> => errAt(name, {code: 'required', message});

/** Pure: the request body as a BulkInput, or the field errors (exported for the unit test). */
export function parseBulk(v: Record<string, unknown>): Parsed<BulkInput> {
  if (!Array.isArray(v.cardIds) || v.cardIds.length === 0) return need('cardIds', 'Select at least one card.');
  if (!v.cardIds.every(positive)) return errAt('cardIds', {code: 'invalid', message: 'Those cards are not valid.'});
  const cardIds = [...new Set(v.cardIds as number[])];
  if (cardIds.length > MAX_BULK_CARDS) return errAt('cardIds', {code: 'too_many', message: `Select up to ${MAX_BULK_CARDS} cards at a time.`});
  let since: bigint | undefined;
  if (v.ifUnchangedSince !== undefined) {
    if (typeof v.ifUnchangedSince !== 'string' || !/^\d{1,18}$/.test(v.ifUnchangedSince)) return errAt('ifUnchangedSince', {code: 'invalid', message: 'That is not a valid revision.'});
    since = BigInt(v.ifUnchangedSince);
  }
  const base = {cardIds, ...(since === undefined ? {} : {since})};
  switch (v.action) {
    case 'archive':
      return {ok: true, value: {...base, action: 'archive'}};
    case 'restore':
      return {ok: true, value: {...base, action: 'restore'}};
    case 'move':
      return positive(v.laneId) ? {ok: true, value: {...base, action: 'move', laneId: v.laneId}} : need('laneId', 'Choose a lane.');
    case 'label_add':
    case 'label_remove':
      return positive(v.labelId) ? {ok: true, value: {...base, action: v.action, labelId: v.labelId}} : need('labelId', 'Choose a label.');
    case 'assign':
    case 'unassign':
      return positive(v.userId) ? {ok: true, value: {...base, action: v.action, userId: v.userId}} : need('userId', 'Choose a person.');
    case 'set_due': {
      const d = dateOnly(v.dueDate);
      return d.ok ? {ok: true, value: {...base, action: 'set_due', dueDate: d.value}} : errAt('dueDate', {code: 'invalid', message: 'Use a date like 2026-12-31.'});
    }
    case 'set_priority':
      return typeof v.priority === 'string' && (PRIORITIES as readonly string[]).includes(v.priority)
        ? {ok: true, value: {...base, action: 'set_priority', priority: v.priority}}
        : errAt('priority', {code: 'invalid', message: 'Unknown priority.'} satisfies FieldError);
    default:
      return errAt('action', {code: 'invalid', message: 'Unknown action.'});
  }
}

/** One request that takes back part of a bulk action (the body of `POST /boards/:id/cards/bulk`, minus the guard). */
export type UndoStep = {cardIds: number[]} & (
  | {action: 'move'; laneId: number}
  | {action: 'archive' | 'restore'}
  | {action: 'label_add' | 'label_remove'; labelId: number}
  | {action: 'assign' | 'unassign'; userId: number}
  | {action: 'set_due'; dueDate: string | null}
  | {action: 'set_priority'; priority: string}
);

/** What the transaction read BEFORE it wrote, for the cards it really changed. */
export type Before = {
  /** Cards the action touched, with the values it may have replaced. */
  cards: {id: number; dueDate: Date | null; priority: string}[];
  /** `move`: the cards that left their lane and the lane they came from. */
  moved: {id: number; from: number}[];
  /** `label_add`: cards that did not carry the label. `label_remove`: cards that did. */
  labelCards: number[];
  /** `assign`: cards the person was newly put on. `unassign`: cards they were taken off. */
  personCards: number[];
};

const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Group card ids by a key, in the order the keys first appear. */
function grouped<K>(rows: {id: number; key: K}[]): Map<K, number[]> {
  const out = new Map<K, number[]>();
  for (const row of rows) (out.get(row.key) ?? out.set(row.key, []).get(row.key)!).push(row.id);
  return out;
}

/**
 * Pure: the requests that undo `input` on the cards in `ids`. `[]` when there is nothing to take back, or when it would
 * take more than MAX_UNDO_STEPS requests (the person then gets no Undo rather than a half one). Exported for the unit test.
 */
export function inverseSteps(input: BulkInput, ids: number[], before: Before): UndoStep[] {
  const steps: UndoStep[] = [];
  switch (input.action) {
    case 'move':
      for (const [laneId, cardIds] of grouped(before.moved.map(m => ({id: m.id, key: m.from})))) steps.push({action: 'move', laneId, cardIds});
      break;
    case 'archive':
      if (ids.length) steps.push({action: 'restore', cardIds: ids});
      break;
    case 'restore':
      if (ids.length) steps.push({action: 'archive', cardIds: ids});
      break;
    case 'label_add':
      if (before.labelCards.length) steps.push({action: 'label_remove', labelId: input.labelId, cardIds: before.labelCards});
      break;
    case 'label_remove':
      if (before.labelCards.length) steps.push({action: 'label_add', labelId: input.labelId, cardIds: before.labelCards});
      break;
    case 'assign':
      if (before.personCards.length) steps.push({action: 'unassign', userId: input.userId, cardIds: before.personCards});
      break;
    case 'unassign':
      if (before.personCards.length) steps.push({action: 'assign', userId: input.userId, cardIds: before.personCards});
      break;
    case 'set_due': {
      const now = dayOf(input.dueDate);
      for (const [dueDate, cardIds] of grouped(before.cards.filter(c => dayOf(c.dueDate) !== now).map(c => ({id: c.id, key: dayOf(c.dueDate)})))) steps.push({action: 'set_due', dueDate, cardIds});
      break;
    }
    case 'set_priority':
      for (const [priority, cardIds] of grouped(before.cards.filter(c => c.priority !== input.priority).map(c => ({id: c.id, key: c.priority})))) steps.push({action: 'set_priority', priority, cardIds});
      break;
  }
  return steps.length > MAX_UNDO_STEPS ? [] : steps;
}

/** Thrown inside the transaction: rolls the rev bump back and names the answer. */
class Stop extends Error {
  constructor(readonly why: 'cards' | 'lane' | 'label' | 'person' | 'full' | 'assignees' | 'unchanged' | 'dates') {
    super(why);
  }
}

/**
 * What the action needs that does not depend on the cards' state, read BEFORE the transaction (and so before the board
 * lock): the board's open lanes (move), the label (label_*), the person's seat (assign). The writes under the lock are
 * still conditional on them (the lane open and below its cap, the label of this board, the seat), so a change in
 * between can only make the write do less, never break a rule.
 */
async function precheck(db: PrismaClient, input: BulkInput, boardId: number, workspaceId: number, seat: Prisma.Sql): Promise<Stop | {laneOrder?: Map<number, number>}> {
  switch (input.action) {
    case 'move': {
      const lanes = await db.lane.findMany({where: {boardId, workspaceId, archivedAt: null}, select: {id: true}, orderBy: [{position: 'asc'}, {id: 'asc'}], take: 100});
      if (!lanes.some(l => l.id === input.laneId)) return new Stop('lane');
      return {laneOrder: new Map(lanes.map((l, i) => [l.id, i]))};
    }
    case 'label_add':
    case 'label_remove': {
      const label = await db.label.findFirst({where: {id: input.labelId, boardId, workspaceId}, select: {id: true}});
      return label ? {} : new Stop('label');
    }
    case 'assign': {
      // Who may be assigned: an active member of the workspace with a seat on THIS board (the same rule as the card panel).
      const rows = await db.$queryRaw<{id: number}[]>`
        SELECT u.id FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = ${workspaceId}::int AND u.status = 'active' AND u.id = ${input.userId}::int ${seat}
        LIMIT 1`;
      return rows[0] ? {} : new Stop('person');
    }
    default:
      return {};
  }
}

export const cardBulkRoutes = new Hono()
  /** The board's labels (at most 50), so the bulk bar can offer one no card carries yet. Read access; ids, names and colours only. */
  .get('/boards/:id/labels', withViewer, requireAuth, withDb, noStore, async c => {
    const ctx = await boardFor(c.var.db, c.var.viewer.id!, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const items = await c.var.db.label.findMany({
      where: {boardId: ctx.boardId, workspaceId: ctx.access.workspaceId},
      select: {id: true, name: true, colorHex: true},
      orderBy: [{name: 'asc'}, {id: 'asc'}],
      take: 50,
    });
    return c.json({items});
  })

  .post('/boards/:id/cards/bulk', body(parseBulk), withViewer, requireAuth, withDb, noStore, async c => {
  const userId = c.var.viewer.id!;
  const db = c.var.db;
  const ctx = await boardFor(db, userId, idOf(c.req.param('id')), 'write');
  if (refused(ctx)) return c.json(ctx.body, ctx.status);
  const {boardId, access} = ctx;
  const {workspaceId} = access;
  const input = c.req.valid('json') as BulkInput;
  const {cardIds} = input;
  // The seat rule of this board from the access already read (visibility; a personal Inbox is only its owner's, and
  // boardFor let us in, so its owner is us): no second board read.
  const seat = seatFilter({visibility: access.visibility, boardId, inboxOf: access.inbox ? userId : null, guest: access.guest});

  const pre = await precheck(db, input, boardId, workspaceId, seat);
  if (pre instanceof Stop) return answerStop(c, pre.why, cardIds.length);

  /** ONE activity row for the whole action (a row per card would be 50 writes), as a CTE of the action's statement. */
  const activity = (meta: object) => Prisma.sql`
    INSERT INTO activity (workspace_id, board_id, actor_id, kind, meta)
    VALUES (${workspaceId}::int, ${boardId}::int, ${userId}::int, 'cards.bulk', ${JSON.stringify(meta)}::jsonb)`;

  const out = await db
    .$transaction(async tx => {
      const rev = await bumpRev(tx, boardId, workspaceId);
      // Read AFTER the board lock, side by side with what the action reads of the cards' relations. Every id must be a
      // card of THIS board and workspace, whatever its state (anything else is a 404 for the whole request, the Undo
      // included: an id of another board never changes).
      const [found, last, people, counts, labelled] = await Promise.all([
        tx.card.findMany({
          where: {id: {in: cardIds}, boardId, workspaceId},
          select: {id: true, laneId: true, position: true, archivedAt: true, updatedRev: true, startDate: true, dueDate: true, priority: true},
          take: MAX_BULK_CARDS,
        }),
        input.action === 'move' ? cardFinder(tx, workspaceId, input.laneId)({}, 'desc') : null,
        input.action === 'assign' || input.action === 'unassign'
          ? tx.cardMember.findMany({where: {cardId: {in: cardIds}, userId: input.userId, workspaceId}, select: {cardId: true}, take: MAX_BULK_CARDS})
          : [],
        input.action === 'assign' ? tx.cardMember.groupBy({by: ['cardId'], where: {cardId: {in: cardIds}, workspaceId}, _count: {_all: true}}) : [],
        input.action === 'label_add' || input.action === 'label_remove'
          ? tx.cardLabel.findMany({where: {cardId: {in: cardIds}, labelId: input.labelId}, select: {cardId: true}, take: MAX_BULK_CARDS})
          : [],
      ]);
      if (found.length !== cardIds.length) throw new Stop('cards');
      // The state the action needs: live cards (restore: archived ones). Without the Undo guard a card in another state is a 404.
      const inState = found.filter(card => (card.archivedAt !== null) === (input.action === 'restore'));
      if (input.since === undefined && inState.length !== found.length) throw new Stop('cards');
      // The Undo guard: skip what was written after the action it takes back.
      let cards = input.since === undefined ? inState : inState.filter(card => card.updatedRev <= input.since!);
      if (input.action === 'set_due' && input.dueDate) {
        // The card panel's rule: a due day never before the start day, against the start as it is now (under the lock).
        const due = input.dueDate;
        const fits = cards.filter(card => !card.startDate || card.startDate <= due);
        // A new action is refused whole (422); an Undo skips the cards it can no longer put back.
        if (input.since === undefined && fits.length !== cards.length) throw new Stop('dates');
        cards = fits;
      }
      if (!cards.length) throw new Stop('unchanged');
      const ids = cards.map(card => card.id);
      let changed = cards.length;
      let notifyCard: number | null = null;
      let moved: {id: number; from: number}[] = [];
      let labelCards: number[] = [];
      let personCards: number[] = [];
      const meta = () => ({action: input.action, count: changed, cardIds: ids, ...(input.since === undefined ? {} : {undo: true})});

      // Each action is ONE statement: its writes, the lane counters and the activity row (data-modifying CTEs all run).
      switch (input.action) {
        case 'move': {
          const laneOrder = pre.laneOrder!;
          // The cards keep their on-screen order: by lane, then position; the ones already in the target stay put.
          const moving = cards
            .filter(card => card.laneId !== input.laneId)
            .sort((a, b) => (laneOrder.get(a.laneId) ?? 0) - (laneOrder.get(b.laneId) ?? 0) || (a.position < b.position ? -1 : a.position > b.position ? 1 : a.id - b.id));
          changed = moving.length;
          if (!moving.length) {
            await tx.$executeRaw`${activity(meta())}`;
            break;
          }
          const keys = keysAtEnd(last?.position ?? null, moving.length);
          const per = perLane(moving);
          // The target's cap and its being open are ONE conditional update (the same as the single move), so a parallel
          // add or archive cannot get past it; the cards and the source counters move only when it applied.
          const [row] = await tx.$queryRaw<{room: boolean; open: boolean}[]>`
            WITH t AS (
              UPDATE lanes SET card_count = card_count + ${moving.length}::int, updated_rev = ${rev}::bigint
              WHERE id = ${input.laneId}::int AND board_id = ${boardId}::int AND workspace_id = ${workspaceId}::int
                AND archived_at IS NULL AND card_count + ${moving.length}::int <= ${MAX_CARDS_PER_LANE}::int
              RETURNING id
            ), k AS (
              UPDATE cards SET lane_id = ${input.laneId}::int, position = u.k, updated_rev = ${rev}::bigint
              FROM unnest(${moving.map(m => m.id)}::int[], ${keys}::text[]) AS u(id, k)
              WHERE EXISTS (SELECT 1 FROM t)
                AND cards.id = u.id AND cards.workspace_id = ${workspaceId}::int AND cards.board_id = ${boardId}::int AND cards.archived_at IS NULL
              RETURNING cards.id
            ), f AS (
              UPDATE lanes SET card_count = GREATEST(card_count - u.n, 0), updated_rev = ${rev}::bigint
              FROM unnest(${per.ids}::int[], ${per.counts}::int[]) AS u(id, n)
              WHERE EXISTS (SELECT 1 FROM t)
                AND lanes.id = u.id AND lanes.board_id = ${boardId}::int AND lanes.workspace_id = ${workspaceId}::int
              RETURNING lanes.id
            ), a AS (${activity(meta())})
            SELECT EXISTS (SELECT 1 FROM t) AS room,
                   EXISTS (SELECT 1 FROM lanes WHERE id = ${input.laneId}::int AND board_id = ${boardId}::int AND archived_at IS NULL) AS open`;
          if (!row?.room) throw new Stop(row?.open ? 'full' : 'lane');
          moved = moving.map(m => ({id: m.id, from: m.laneId}));
          break;
        }
        case 'archive': {
          const per = perLane(cards);
          await tx.$executeRaw`
            WITH k AS (
              UPDATE cards SET archived_at = now(), updated_rev = ${rev}::bigint, updated_at = now()
              WHERE id = ANY(${ids}::int[]) AND board_id = ${boardId}::int AND workspace_id = ${workspaceId}::int AND archived_at IS NULL
              RETURNING id
            ), f AS (
              UPDATE lanes SET card_count = GREATEST(card_count - u.n, 0), updated_rev = ${rev}::bigint
              FROM unnest(${per.ids}::int[], ${per.counts}::int[]) AS u(id, n)
              WHERE lanes.id = u.id AND lanes.board_id = ${boardId}::int AND lanes.workspace_id = ${workspaceId}::int
              RETURNING lanes.id
            ), a AS (${activity(meta())})
            SELECT 1`;
          break;
        }
        case 'restore': {
          // The counters go up ONLY for open lanes with room (one conditional statement, like the single restore); else
          // the whole transaction, the rev bump included, rolls back and the person is told why.
          const per = perLane(cards);
          const [row] = await tx.$queryRaw<{room: number; open: number}[]>`
            WITH r AS (
              UPDATE lanes SET card_count = card_count + u.n, updated_rev = ${rev}::bigint
              FROM unnest(${per.ids}::int[], ${per.counts}::int[]) AS u(id, n)
              WHERE lanes.id = u.id AND lanes.board_id = ${boardId}::int AND lanes.workspace_id = ${workspaceId}::int
                AND lanes.archived_at IS NULL AND lanes.card_count + u.n <= ${MAX_CARDS_PER_LANE}::int
              RETURNING lanes.id
            ), k AS (
              UPDATE cards SET archived_at = NULL, updated_rev = ${rev}::bigint, updated_at = now()
              WHERE id = ANY(${ids}::int[]) AND board_id = ${boardId}::int AND workspace_id = ${workspaceId}::int AND archived_at IS NOT NULL
              RETURNING id
            ), a AS (${activity(meta())})
            SELECT (SELECT count(*)::int FROM r) AS room,
                   (SELECT count(*)::int FROM lanes
                    WHERE id = ANY(${per.ids}::int[]) AND board_id = ${boardId}::int AND workspace_id = ${workspaceId}::int AND archived_at IS NULL) AS open`;
          if (!row || row.room !== per.ids.length) throw new Stop(row && row.open === per.ids.length ? 'full' : 'lane');
          break;
        }
        case 'label_add':
        case 'label_remove': {
          // What the Undo needs: which cards carried the label BEFORE (read under the board lock).
          const had = new Set(labelled.map(r => r.cardId));
          labelCards = input.action === 'label_add' ? ids.filter(id => !had.has(id)) : ids.filter(id => had.has(id));
          // The insert joins the label of THIS board, so a label deleted since the precheck adds nothing.
          const write =
            input.action === 'label_add'
              ? Prisma.sql`
                  INSERT INTO card_labels (card_id, label_id)
                  SELECT u.id, l.id FROM unnest(${ids}::int[]) AS u(id)
                  JOIN labels l ON l.id = ${input.labelId}::int AND l.board_id = ${boardId}::int AND l.workspace_id = ${workspaceId}::int
                  ON CONFLICT DO NOTHING`
              : Prisma.sql`DELETE FROM card_labels WHERE card_id = ANY(${ids}::int[]) AND label_id = ${input.labelId}::int`;
          await tx.$executeRaw`
            WITH w AS (${write}), t AS (${touch(ids, boardId, workspaceId, rev)}), a AS (${activity(meta())})
            SELECT 1`;
          break;
        }
        case 'assign': {
          const already = new Set(people.map(r => r.cardId));
          const fresh = ids.filter(id => !already.has(id));
          if (counts.some(r => ids.includes(r.cardId) && !already.has(r.cardId) && r._count._all >= MAX_ASSIGNEES)) throw new Stop('assignees');
          changed = fresh.length;
          personCards = fresh;
          if (!fresh.length) {
            await tx.$executeRaw`${activity(meta())}`;
            break;
          }
          // The seat again, IN the statement: someone who lost it since the precheck is not assigned (404, rolled back).
          // Whoever is assigned follows the cards.
          const [row] = await tx.$queryRaw<{seated: boolean}[]>`
            WITH s AS (
              SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id
              WHERE m.workspace_id = ${workspaceId}::int AND u.status = 'active' AND u.id = ${input.userId}::int ${seat}
              LIMIT 1
            ), cm AS (
              INSERT INTO card_members (card_id, user_id, workspace_id)
              SELECT u.id, ${input.userId}::int, ${workspaceId}::int FROM unnest(${fresh}::int[]) AS u(id) WHERE EXISTS (SELECT 1 FROM s)
              ON CONFLICT DO NOTHING
            ), cw AS (
              INSERT INTO card_watchers (card_id, user_id)
              SELECT u.id, ${input.userId}::int FROM unnest(${fresh}::int[]) AS u(id) WHERE EXISTS (SELECT 1 FROM s)
              ON CONFLICT DO NOTHING
            ), t AS (${touch(fresh, boardId, workspaceId, rev)}), a AS (${activity(meta())})
            SELECT EXISTS (SELECT 1 FROM s) AS seated`;
          if (!row?.seated) throw new Stop('person');
          notifyCard = fresh[0]!;
          break;
        }
        case 'unassign': {
          const inIds = new Set(ids);
          personCards = people.map(r => r.cardId).filter(id => inIds.has(id));
          changed = personCards.length;
          if (!personCards.length) {
            await tx.$executeRaw`${activity(meta())}`;
            break;
          }
          await tx.$executeRaw`
            WITH d AS (
              DELETE FROM card_members WHERE card_id = ANY(${personCards}::int[]) AND user_id = ${input.userId}::int AND workspace_id = ${workspaceId}::int
            ), t AS (${touch(personCards, boardId, workspaceId, rev)}), a AS (${activity(meta())})
            SELECT 1`;
          break;
        }
        case 'set_due': {
          const day = dayOf(input.dueDate);
          await tx.$executeRaw`
            WITH k AS (
              UPDATE cards SET due_date = ${day}::date, updated_rev = ${rev}::bigint, updated_at = now()
              WHERE id = ANY(${ids}::int[]) AND board_id = ${boardId}::int AND workspace_id = ${workspaceId}::int AND archived_at IS NULL
                AND (${day}::date IS NULL OR start_date IS NULL OR start_date <= ${day}::date)
              RETURNING id
            ), a AS (${activity(meta())})
            SELECT 1`;
          break;
        }
        case 'set_priority':
          await tx.$executeRaw`
            WITH k AS (
              UPDATE cards SET priority = ${input.priority}, updated_rev = ${rev}::bigint, updated_at = now()
              WHERE id = ANY(${ids}::int[]) AND board_id = ${boardId}::int AND workspace_id = ${workspaceId}::int AND archived_at IS NULL
              RETURNING id
            ), a AS (${activity(meta())})
            SELECT 1`;
          break;
      }

      const undo = inverseSteps(input, ids, {cards, moved, labelCards, personCards});
      return {rev, changed, notifyCard, moved, undo, skipped: cardIds.length - cards.length};
    })
    .catch(err => {
      if (err instanceof Stop) return err.why;
      throw err;
    });

  if (typeof out === 'string') return answerStop(c, out, cardIds.length);

  // After the answer, never failing the request.
  if (input.action === 'assign' && out.notifyCard) {
    const cardId = out.notifyCard;
    const assignee = input.userId;
    await afterResponse(c, 'bulk assign', () => notify(db, [assignee], {workspaceId, actorId: userId, boardId, cardId, kind: 'assigned'}));
  }
  if (out.moved.length && input.action === 'move') {
    const events = out.moved.map(m => ({kind: 'card_moved' as const, workspaceId, boardId, cardId: m.id, laneId: input.laneId, fromLaneId: m.from}));
    await afterResponse(c, 'flows', () => runFlows(db, events));
  }
  return c.json({
    changed: out.changed,
    rev: String(out.rev),
    ...(out.skipped ? {skipped: out.skipped} : {}),
    // The exact inverse, each step guarded by this rev so it skips cards written since.
    ...(out.undo.length ? {undo: out.undo.map(step => ({...step, ifUnchangedSince: String(out.rev)}))} : {}),
  });
});

/** The answer for a refusal (a precheck's or one thrown under the lock). */
function answerStop(c: Context, why: Stop['why'], requested: number) {
  if (why === 'cards') return notFound(c, 'card');
  if (why === 'lane') return notFound(c, 'lane');
  if (why === 'label') return notFound(c, 'label');
  if (why === 'person') return notFound(c, 'person');
  if (why === 'full') return c.json(problem('lane_card_limit', `A lane holds up to ${MAX_CARDS_PER_LANE} cards.`), 409);
  if (why === 'assignees') return c.json(problem('limit_reached', `A card holds up to ${MAX_ASSIGNEES} assignees.`), 409);
  if (why === 'dates') return invalid(c, {dueDate: {code: 'invalid', message: DUE_BEFORE_START}});
  // An Undo whose cards were all written since: nothing to take back, nothing changed (the rev bump rolled back).
  return c.json({changed: 0, skipped: requested});
}

/** The cards' rows follow the change (the board sync sends rows by `updated_rev`): a CTE of the action's statement. */
function touch(ids: number[], boardId: number, workspaceId: number, rev: bigint) {
  return Prisma.sql`
    UPDATE cards SET updated_rev = ${rev}::bigint, updated_at = now()
    WHERE id = ANY(${ids}::int[]) AND board_id = ${boardId}::int AND workspace_id = ${workspaceId}::int`;
}

/** How many of the cards sit in each lane (the lanes they leave or come back to), as two parallel arrays for unnest. */
function perLane(cards: {laneId: number}[]): {ids: number[]; counts: number[]} {
  const per = new Map<number, number>();
  for (const card of cards) per.set(card.laneId, (per.get(card.laneId) ?? 0) + 1);
  return {ids: [...per.keys()], counts: [...per.values()]};
}
