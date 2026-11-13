import {generateKeyBetween} from 'fractional-indexing';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {getEntitlements, MAX_CARDS_PER_LANE} from '../entitlements';
import {notify} from '../notifications';
import {type FlowAction, type FlowConfig, MAX_FLOWS_PER_BOARD, readConfig, type TriggerKind} from './config';

/**
 * The Flows engine (Phase 7). A small, bounded interpreter that runs AFTER a card write has committed
 * (create cards, move card) and, once a day, from the scheduled job (src/server/jobs/flows.ts).
 *
 * Rules it keeps:
 *  - NEVER throws into the caller: a broken flow must not fail the user's action. Failures are logged (no card text).
 *  - System actor: activity rows have `actor_id` null and `meta.flowId`; comments have `author_id` null.
 *  - Never exceeds the board: every read and write carries `board_id` and `workspace_id`; lanes, labels and people a
 *    flow names are re-checked at run time (they may have been deleted, archived or left since it was saved).
 *  - Loop-safe: chain depth <= MAX_DEPTH, a flow runs at most once per card per chain (`seen`), and one user action
 *    spends at most MAX_ACTIONS_PER_RUN actions in total (`budget`).
 *  - Idempotent actions: assigning or labelling twice is a no-op (no rev bump, no activity).
 *  - One transaction per card per flow (board row lock via `bump`, once), each action in its own SAVEPOINT so a
 *    skipped or failed action is undone alone. Notifications and chained flows run after the commit.
 */

export const MAX_DEPTH = 3;
export const MAX_ACTIONS_PER_RUN = 20;
/** Cards one event batch may carry (the create route adds at most 20). */
const MAX_EVENT_CARDS = 20;
const MAX_ASSIGNEES = 50;

export type FlowEvent = {
  kind: Exclude<TriggerKind, 'daily_due'>;
  workspaceId: number;
  boardId: number;
  cardId: number;
  /** The lane the card is in NOW (created in / moved into). */
  laneId: number;
  /** A move only: the lane it came from. */
  fromLaneId?: number;
};

export type Run = {
  depth: number;
  /** `flowId:cardId` pairs already run in this chain. */
  seen: Set<string>;
  budget: {left: number};
};

export const newRun = (depth = 0): Run => ({depth, seen: new Set(), budget: {left: MAX_ACTIONS_PER_RUN}});

type StoredFlow = {id: number; name: string; config: unknown};
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** Thrown inside a transaction to roll it back when the step no longer applies. */
class Skip extends Error {}

type BoardInfo = {id: number; workspaceId: number; visibility: string};

async function loadBoard(db: PrismaClient, boardId: number, workspaceId: number): Promise<BoardInfo | null> {
  const b = await db.board.findFirst({
    where: {id: boardId, workspaceId, archivedAt: null, inboxOf: null, workspace: {archivedAt: null}},
    select: {id: true, workspaceId: true, visibility: true},
  });
  return b;
}

async function mayRun(db: PrismaClient, workspaceId: number): Promise<boolean> {
  const ent = await getEntitlements(db, workspaceId);
  return !!ent && ent.features.flows && !ent.readOnly;
}

/** Of `ids`, the active workspace members who can see this board. */
async function eligible(db: PrismaClient | Tx, board: BoardInfo, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const seat =
    board.visibility === 'private'
      ? Prisma.sql`AND (m.role IN ('owner', 'admin') OR EXISTS (SELECT 1 FROM board_members b WHERE b.board_id = ${board.id} AND b.user_id = m.user_id))`
      : Prisma.empty;
  const rows = await db.$queryRaw<{id: number}[]>`
    SELECT u.id FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${board.workspaceId} AND u.status = 'active' AND u.id IN (${Prisma.join(ids)}) ${seat}
    LIMIT ${MAX_ASSIGNEES}`;
  return rows.map(r => r.id);
}

async function bump(tx: Tx, boardId: number, workspaceId: number): Promise<bigint> {
  const rows = await tx.$queryRaw<{rev: bigint}[]>`
    UPDATE boards SET rev = rev + 1, updated_at = now() WHERE id = ${boardId} AND workspace_id = ${workspaceId} RETURNING rev`;
  if (!rows[0]) throw new Skip();
  return rows[0].rev;
}

type Ctx = {
  db: PrismaClient;
  board: BoardInfo;
  cardId: number;
  flow: {id: number; name: string};
  kind: TriggerKind;
  run: Run;
};

/**
 * One card's actions for one flow share ONE transaction (one socket, one board-row lock, one rev bump) instead of
 * one each. `rev` is bumped lazily by the first action that writes; `after` holds work for after the commit
 * (notifications, which run outside the lock).
 */
type Batch = {tx: Tx; rev: bigint | null; after: Array<() => Promise<unknown>>};

async function revOf(b: Batch, ctx: Ctx): Promise<bigint> {
  if (b.rev === null) b.rev = await bump(b.tx, ctx.board.id, ctx.board.workspaceId);
  return b.rev;
}

const meta = (ctx: Ctx, extra: Record<string, unknown> = {}): Prisma.InputJsonValue => ({...extra, flowId: ctx.flow.id, flowName: ctx.flow.name}) as Prisma.InputJsonValue;

/** Stamps the card (so the board's delta poll sees it); throws Skip when it is gone or archived. */
async function touch(tx: Tx, ctx: Ctx, rev: bigint, data: Prisma.CardUpdateManyMutationInput = {}): Promise<void> {
  const {count} = await tx.card.updateMany({
    where: {id: ctx.cardId, boardId: ctx.board.id, workspaceId: ctx.board.workspaceId, archivedAt: null},
    data: {...data, updatedRev: rev},
  });
  if (!count) throw new Skip();
}

const activity = (tx: Tx, ctx: Ctx, kind: string, m: Prisma.InputJsonValue) =>
  tx.activity.create({data: {workspaceId: ctx.board.workspaceId, boardId: ctx.board.id, cardId: ctx.cardId, actorId: null, kind, meta: m}});

/** What an action did: `moved` is the new lane id when the card changed lane (it may fire further flows). */
type Outcome = {moved?: number; from?: number} | void;

async function doAssign(ctx: Ctx, b: Batch, userId: number): Promise<Outcome> {
  const {board, cardId} = ctx;
  const {tx} = b;
  const [ok] = await eligible(tx, board, [userId]);
  if (!ok) return;
  const has = await tx.cardMember.findMany({where: {cardId, workspaceId: board.workspaceId}, select: {userId: true}, take: MAX_ASSIGNEES});
  if (has.some(m => m.userId === userId) || has.length >= MAX_ASSIGNEES) return;
  await touch(tx, ctx, await revOf(b, ctx));
  const made = await tx.cardMember.createMany({data: [{cardId, userId, workspaceId: board.workspaceId}], skipDuplicates: true});
  if (!made.count) throw new Skip();
  await activity(tx, ctx, 'card.member_added', meta(ctx, {userId}));
  b.after.push(() => notify(ctx.db, [userId], {workspaceId: board.workspaceId, actorId: null, boardId: board.id, cardId, kind: 'assigned'}));
}

async function doLabel(ctx: Ctx, b: Batch, labelId: number): Promise<Outcome> {
  const {board, cardId} = ctx;
  const {tx} = b;
  const label = await tx.label.findFirst({where: {id: labelId, boardId: board.id, workspaceId: board.workspaceId}, select: {id: true, name: true}});
  if (!label) return;
  if (await tx.cardLabel.findFirst({where: {cardId, labelId}, select: {cardId: true}})) return;
  await touch(tx, ctx, await revOf(b, ctx));
  const made = await tx.cardLabel.createMany({data: [{cardId, labelId}], skipDuplicates: true});
  if (!made.count) throw new Skip();
  await activity(tx, ctx, 'card.label_added', meta(ctx, {labelId, name: label.name}));
}

async function doComment(ctx: Ctx, b: Batch, body: string): Promise<Outcome> {
  const {board, cardId} = ctx;
  const {tx} = b;
  await touch(tx, ctx, await revOf(b, ctx), {commentCount: {increment: 1}});
  const created = await tx.comment.create({data: {workspaceId: board.workspaceId, cardId, authorId: null, bodyMd: body}, select: {id: true}});
  await activity(tx, ctx, 'comment.created', meta(ctx, {commentId: created.id}));
}

async function doMove(ctx: Ctx, b: Batch, laneId: number): Promise<Outcome> {
  const {board, cardId} = ctx;
  const {tx} = b;
  const rev = await revOf(b, ctx);
  const card = await tx.card.findFirst({where: {id: cardId, boardId: board.id, workspaceId: board.workspaceId, archivedAt: null}, select: {laneId: true}});
  if (!card || card.laneId === laneId) throw new Skip();
  const last = await tx.card.findFirst({
    where: {workspaceId: board.workspaceId, laneId, archivedAt: null},
    orderBy: [{position: 'desc'}, {id: 'desc'}],
    select: {position: true},
  });
  // The target takes the card only while it is open and below the cap (one conditional update, as the move route does).
  const into = await tx.lane.updateMany({
    where: {id: laneId, boardId: board.id, workspaceId: board.workspaceId, archivedAt: null, cardCount: {lt: MAX_CARDS_PER_LANE}},
    data: {cardCount: {increment: 1}, updatedRev: rev},
  });
  if (!into.count) throw new Skip();
  const moved = await tx.card.updateMany({
    where: {id: cardId, boardId: board.id, workspaceId: board.workspaceId, laneId: card.laneId, archivedAt: null},
    data: {laneId, position: generateKeyBetween(last?.position ?? null, null), updatedRev: rev},
  });
  if (!moved.count) throw new Skip();
  await tx.lane.updateMany({where: {id: card.laneId, boardId: board.id, workspaceId: board.workspaceId}, data: {cardCount: {decrement: 1}, updatedRev: rev}});
  await activity(tx, ctx, 'card.moved', meta(ctx, {from: card.laneId, to: laneId}));
  return {moved: laneId, from: card.laneId};
}

async function doNotify(ctx: Ctx, b: Batch, action: Extract<FlowAction, {type: 'notify'}>): Promise<Outcome> {
  const {board, cardId} = ctx;
  const {tx} = b;
  const wanted =
    action.target === 'user' && action.userId
      ? [action.userId]
      : (await tx.cardMember.findMany({where: {cardId, workspaceId: board.workspaceId}, select: {userId: true}, take: MAX_ASSIGNEES})).map(m => m.userId);
  const people = await eligible(tx, board, wanted);
  if (people.length === 0) return;
  b.after.push(() => notify(ctx.db, people, {workspaceId: board.workspaceId, actorId: null, boardId: board.id, cardId, kind: ctx.kind === 'daily_due' ? 'due_soon' : 'comment'}));
}

async function perform(ctx: Ctx, b: Batch, action: FlowAction): Promise<Outcome> {
  switch (action.type) {
    case 'assign':
      return doAssign(ctx, b, action.userId);
    case 'add_label':
      return doLabel(ctx, b, action.labelId);
    case 'comment':
      return doComment(ctx, b, action.body);
    case 'move':
      return doMove(ctx, b, action.laneId);
    case 'notify':
      return doNotify(ctx, b, action);
  }
}

/**
 * One flow's actions on one card, in one transaction. Each action sits in its own SAVEPOINT, so an action that no
 * longer applies (Skip) or fails is undone alone and the others keep, as when each had its own transaction.
 * A failure stops this card's remaining actions. Returns the lane moves (for chained card_moved flows, run after
 * the commit) and whether the run's action budget ran out.
 */
async function runCard(ctx: Ctx, actions: readonly FlowAction[]): Promise<{moves: FlowEvent[]; spent: boolean}> {
  const moves: FlowEvent[] = [];
  let spent = false;
  const after: Batch['after'] = [];
  await ctx.db.$transaction(async tx => {
    const b: Batch = {tx, rev: null, after};
    for (const action of actions) {
      if (ctx.run.budget.left <= 0) {
        spent = true;
        break;
      }
      ctx.run.budget.left--;
      const hadRev = b.rev !== null;
      const queued = after.length;
      await tx.$executeRaw`SAVEPOINT flow_step`;
      try {
        const out = await perform(ctx, b, action);
        await tx.$executeRaw`RELEASE SAVEPOINT flow_step`;
        if (out && out.moved) moves.push({kind: 'card_moved', workspaceId: ctx.board.workspaceId, boardId: ctx.board.id, cardId: ctx.cardId, laneId: out.moved, fromLaneId: out.from});
      } catch (err) {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT flow_step`;
        // The rolled-back step may have made the bump or queued a notification: forget both.
        if (!hadRev) b.rev = null;
        after.length = queued;
        if (err instanceof Skip) continue;
        // Words for the log only: never the card text, never a secret.
        console.error(`flow ${ctx.flow.id} ${action.type} failed: ${(err as Error).message}`);
        break;
      }
    }
  });
  for (const send of after) {
    try {
      await send();
    } catch (err) {
      console.error(`flow ${ctx.flow.id} notify failed: ${(err as Error).message}`);
    }
  }
  return {moves, spent};
}

/** True when the card passes the flow's conditions right now (one small read, only when a condition is set). */
async function passes(db: PrismaClient, board: BoardInfo, cardId: number, config: FlowConfig): Promise<boolean> {
  if (!config.conditions.labelId) return true;
  const has = await db.cardLabel.findFirst({
    where: {cardId, labelId: config.conditions.labelId, label: {boardId: board.id, workspaceId: board.workspaceId}},
    select: {cardId: true},
  });
  return !!has;
}

/**
 * Runs ONE flow on the given cards (already known to be on the board). Used by the event runner and the daily job.
 * `onMove` lets the event runner chain card_moved flows for cards a `move` action relocated.
 */
export async function applyFlow(
  db: PrismaClient,
  board: BoardInfo,
  flow: StoredFlow,
  kind: TriggerKind,
  cardIds: readonly number[],
  run: Run,
  onMove?: (event: FlowEvent) => Promise<void>
): Promise<void> {
  const config = readConfig(flow.config);
  if (!config) return;
  for (const cardId of cardIds) {
    const key = `${flow.id}:${cardId}`;
    if (run.seen.has(key)) continue;
    run.seen.add(key);
    if (!(await passes(db, board, cardId, config))) continue;
    if (run.budget.left <= 0) return;
    const ctx: Ctx = {db, board, cardId, flow: {id: flow.id, name: flow.name}, kind, run};
    let result: {moves: FlowEvent[]; spent: boolean};
    try {
      result = await runCard(ctx, config.actions);
    } catch (err) {
      // The transaction itself failed (nothing of this card was kept): log it and go on with the next card.
      console.error(`flow ${flow.id} failed: ${(err as Error).message}`);
      continue;
    }
    if (onMove) for (const event of result.moves) await onMove(event);
    if (result.spent) return;
  }
}

/**
 * Runs the enabled flows of a board for events that just committed. All events share one board and one kind
 * (the create route adds up to 20 cards at once). Never throws.
 */
export async function runFlows(db: PrismaClient, events: readonly FlowEvent[], run: Run = newRun()): Promise<void> {
  try {
    const first = events[0];
    if (!first || run.depth >= MAX_DEPTH || run.budget.left <= 0) return;
    const batch = events.slice(0, MAX_EVENT_CARDS);
    const flows = await db.flow.findMany({
      where: {boardId: first.boardId, workspaceId: first.workspaceId, triggerKind: first.kind, enabled: true},
      select: {id: true, name: true, config: true},
      orderBy: {id: 'asc'},
      take: MAX_FLOWS_PER_BOARD,
    });
    if (flows.length === 0) return;
    if (!(await mayRun(db, first.workspaceId))) return;
    const board = await loadBoard(db, first.boardId, first.workspaceId);
    if (!board) return;
    // The cards must still be live on this board (one read for the whole batch).
    const live = await db.card.findMany({
      where: {id: {in: batch.map(e => e.cardId)}, boardId: board.id, workspaceId: board.workspaceId, archivedAt: null},
      select: {id: true, laneId: true},
      take: MAX_EVENT_CARDS,
    });
    const lane = new Map(live.map(c => [c.id, c.laneId]));
    const next = {...run, depth: run.depth + 1};
    for (const flow of flows) {
      const config = readConfig(flow.config);
      if (!config || (config.trigger.kind !== 'card_created' && config.trigger.kind !== 'card_moved')) continue;
      const wanted = config.trigger.laneId;
      const ids = batch.filter(e => lane.has(e.cardId) && (!wanted || e.laneId === wanted) && e.fromLaneId !== e.laneId).map(e => e.cardId);
      if (ids.length === 0) continue;
      await applyFlow(db, board, flow, first.kind, ids, run, ev => runFlows(db, [ev], next));
    }
  } catch (err) {
    console.error(`flows: ${(err as Error).message}`);
  }
}
