import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {audit} from '../../platform/auth';
import {problem, requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {getEntitlements} from '../entitlements';
import {
  type Errors,
  type FlowAction,
  type FlowConfig,
  MAX_FLOWS_PER_BOARD,
  parseActions,
  parseConditions,
  parseName,
  parseTrigger,
  readConfig,
  selfLoop,
} from '../flows/config';
import {PERMISSIONS} from '../permissions';
import {idOf, invalid, objectOf} from '../validation';
import {boardAccess, notFound} from '../workspaces';
import {noStore} from './boards';

/**
 * Flows (board automations), Phase 7: the builder's routes (docs/product/flows-api.md). Mounted ONCE at `/` in `app.ts`.
 *
 *   GET    /boards/:id/flows    this board's flows + plan usage
 *   POST   /boards/:id/flows    create one
 *   PATCH  /flows/:id           change name, switch, trigger, conditions or actions
 *   DELETE /flows/:id
 *
 * Guards: withViewer, requireAuth, requirePermission('board:flows'), withDb, then board access (the visitor's
 * workspace membership is IN its query: another workspace's board or flow is a 404) and board ADMIN (403).
 * Writes also refuse an archived board, a personal Inbox and a read-only workspace. The engine that RUNS flows is
 * src/server/flows/engine.ts; nothing here executes an action.
 */

type Refusal = {status: 403 | 404 | 409; body: ReturnType<typeof problem>};
const refuse = (status: Refusal['status'], error: string, message: string): Refusal => ({status, body: problem(error, message)});
const refused = (r: object): r is Refusal => 'status' in r;

type BoardCtx = {boardId: number; workspaceId: number; visibility: string};

/** The board and the right to manage its flows (`write`: also open, not an Inbox, workspace not read-only). */
async function boardFor(db: PrismaClient, userId: number, boardId: number | undefined, write: boolean): Promise<Refusal | BoardCtx> {
  const access = boardId ? await boardAccess(db, boardId, userId) : null;
  if (!boardId || !access) return refuse(404, 'not_found', 'No such board.');
  if (!access.canAdmin) return refuse(403, 'forbidden', 'You do not have access to this.');
  if (write) {
    if (access.archived) return refuse(409, 'board_archived', 'This board is archived.');
    const inbox = await db.board.findFirst({where: {id: boardId, workspaceId: access.workspaceId, inboxOf: null}, select: {id: true}});
    if (!inbox) return refuse(409, 'inbox_board', 'Flows are not available on your personal Inbox.');
    const ent = await getEntitlements(db, access.workspaceId);
    if (ent?.readOnly) return refuse(409, 'workspace_read_only', 'This workspace is read-only until its plan limits are fixed.');
  }
  return {boardId, workspaceId: access.workspaceId, visibility: access.visibility};
}

const planBlocked = (c: {json: (b: unknown, s: 403) => Response}) =>
  c.json(problem('plan_feature', 'Flows are not part of this workspace\'s plan. Upgrade the plan to use them.'), 403);

/* ------------------------------------------------------------- references */

type Ref = {field: string; kind: 'lane' | 'label' | 'user'; id: number};

function refsOf(config: FlowConfig): Ref[] {
  const out: Ref[] = [];
  if (config.trigger.laneId) out.push({field: 'trigger.laneId', kind: 'lane', id: config.trigger.laneId});
  if (config.conditions.labelId) out.push({field: 'conditions.labelId', kind: 'label', id: config.conditions.labelId});
  config.actions.forEach((a: FlowAction, i) => {
    if (a.type === 'move') out.push({field: `actions.${i}.laneId`, kind: 'lane', id: a.laneId});
    else if (a.type === 'add_label') out.push({field: `actions.${i}.labelId`, kind: 'label', id: a.labelId});
    else if (a.type === 'assign') out.push({field: `actions.${i}.userId`, kind: 'user', id: a.userId});
    else if (a.type === 'notify' && a.userId) out.push({field: `actions.${i}.userId`, kind: 'user', id: a.userId});
  });
  return out;
}

/** Which of the named lanes, labels and people really belong to this board (3 reads, whatever the number of flows). */
async function existing(db: PrismaClient, board: BoardCtx, refs: Ref[]) {
  const ids = (kind: Ref['kind']) => [...new Set(refs.filter(r => r.kind === kind).map(r => r.id))];
  const [laneIds, labelIds, userIds] = [ids('lane'), ids('label'), ids('user')];
  const [lanes, labels, users] = await Promise.all([
    laneIds.length ? db.lane.findMany({where: {id: {in: laneIds}, boardId: board.boardId, workspaceId: board.workspaceId, archivedAt: null}, select: {id: true}, take: 100}) : [],
    labelIds.length ? db.label.findMany({where: {id: {in: labelIds}, boardId: board.boardId, workspaceId: board.workspaceId}, select: {id: true}, take: 100}) : [],
    userIds.length
      ? db.$queryRaw<{id: number}[]>`
          SELECT u.id FROM workspace_members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = ${board.workspaceId} AND u.status = 'active' AND u.id IN (${Prisma.join(userIds)})
            ${board.visibility === 'private' ? Prisma.sql`AND (m.role IN ('owner', 'admin') OR EXISTS (SELECT 1 FROM board_members b WHERE b.board_id = ${board.boardId} AND b.user_id = m.user_id))` : Prisma.empty}
          LIMIT 100`
      : [],
  ]);
  return {lane: new Set(lanes.map(r => r.id)), label: new Set(labels.map(r => r.id)), user: new Set(users.map(r => r.id))};
}

/* ----------------------------------------------------------------- shapes */

const flowCols = {id: true, boardId: true, name: true, enabled: true, config: true, lastRunOn: true, createdAt: true, updatedAt: true} as const;
type FlowRow = Prisma.FlowGetPayload<{select: typeof flowCols}>;
const PROBLEM_CODE = {lane: 'lane_gone', label: 'label_gone', user: 'user_gone'} as const;

function flowShape(row: FlowRow, found: Awaited<ReturnType<typeof existing>>) {
  const config = readConfig(row.config);
  const problems = config ? [...new Set(refsOf(config).filter(r => !found[r.kind].has(r.id)).map(r => PROBLEM_CODE[r.kind]))] : ['invalid_config'];
  return {
    id: row.id,
    boardId: row.boardId,
    name: row.name,
    enabled: row.enabled,
    trigger: config?.trigger ?? null,
    conditions: config?.conditions ?? {labelId: null},
    actions: config?.actions ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastRunOn: row.lastRunOn ? row.lastRunOn.toISOString().slice(0, 10) : null,
    problems,
  };
}

async function shapeOne(db: PrismaClient, board: BoardCtx, row: FlowRow) {
  const config = readConfig(row.config);
  return flowShape(row, await existing(db, board, config ? refsOf(config) : []));
}

/* ------------------------------------------------------------- validation */

type Input = {name?: string; enabled?: boolean; trigger?: FlowConfig['trigger']; conditions?: FlowConfig['conditions']; actions?: FlowAction[]};

const flowBody = (partial: boolean) =>
  validator('json', (value, c) => {
    const v = objectOf(value) ?? {};
    const errors: Errors = {};
    const out: Input = {};
    if (!partial || v.name !== undefined) out.name = parseName(v.name, errors) ?? undefined;
    if (v.enabled !== undefined) {
      if (typeof v.enabled !== 'boolean') errors.enabled = {code: 'invalid', message: 'Use true or false.'};
      else out.enabled = v.enabled;
    }
    if (!partial || v.trigger !== undefined) out.trigger = parseTrigger(v.trigger, errors) ?? undefined;
    if (!partial || v.conditions !== undefined) out.conditions = parseConditions(v.conditions, errors);
    if (!partial || v.actions !== undefined) out.actions = parseActions(v.actions, errors) ?? undefined;
    if (partial && Object.keys(v).length === 0) errors.input = {code: 'invalid', message: 'Nothing to change.'};
    if (Object.keys(errors).length) return invalid(c, errors);
    return out;
  });

/** Pure + database checks for the config the saved flow will have. Returns field errors (empty = fine). */
async function checkConfig(db: PrismaClient, board: BoardCtx, config: FlowConfig): Promise<Errors> {
  const errors: Errors = {};
  if (selfLoop(config.trigger, config.actions)) {
    const i = config.actions.findIndex(a => a.type === 'move' && config.trigger.laneId === a.laneId);
    errors[`actions.${i}.laneId`] = {code: 'invalid', message: 'This flow would move the card back into the lane that started it. Pick another lane.'};
  }
  const refs = refsOf(config);
  const found = await existing(db, board, refs);
  for (const r of refs) if (!found[r.kind].has(r.id)) errors[r.field] ??= {code: 'not_found', message: r.kind === 'user' ? 'That person is not on this board.' : `That ${r.kind} is not on this board.`};
  return errors;
}

/* ----------------------------------------------------------------- routes */

export const flowRoutes = new Hono()
  .get('/boards/:id/flows', withViewer, requireAuth, requirePermission(PERMISSIONS.BOARD_FLOWS), withDb, noStore, async c => {
    const db = c.var.db;
    const ctx = await boardFor(db, c.var.viewer.id!, idOf(c.req.param('id')), false);
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const [rows, ent, used] = await Promise.all([
      db.flow.findMany({where: {boardId: ctx.boardId, workspaceId: ctx.workspaceId}, select: flowCols, orderBy: {id: 'asc'}, take: MAX_FLOWS_PER_BOARD}),
      getEntitlements(db, ctx.workspaceId),
      db.flow.count({where: {workspaceId: ctx.workspaceId}}),
    ]);
    const configs = rows.map(r => readConfig(r.config));
    const found = await existing(db, ctx, configs.flatMap(cfg => (cfg ? refsOf(cfg) : [])));
    return c.json({
      items: rows.map(r => flowShape(r, found)),
      limit: {max: ent?.limits.maxFlows ?? 0, used, boardMax: MAX_FLOWS_PER_BOARD},
      enabled: !!ent?.features.flows,
    });
  })

  .post('/boards/:id/flows', flowBody(false), withViewer, requireAuth, requirePermission(PERMISSIONS.BOARD_FLOWS), withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await boardFor(db, userId, idOf(c.req.param('id')), true);
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const input = c.req.valid('json') as Required<Pick<Input, 'name' | 'trigger' | 'conditions' | 'actions'>> & Input;
    const ent = await getEntitlements(db, ctx.workspaceId);
    if (!ent?.features.flows) return planBlocked(c);
    const errors = await checkConfig(db, ctx, input);
    if (Object.keys(errors).length) return invalid(c, errors);
    const config: FlowConfig = {trigger: input.trigger, conditions: input.conditions, actions: input.actions};
    const made = await db.$transaction(async tx => {
      // The workspace row lock makes the two caps below race-free (two parallel creates cannot both pass).
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${ctx.workspaceId} FOR UPDATE`;
      const [inBoard, inWorkspace] = await Promise.all([
        tx.flow.count({where: {boardId: ctx.boardId, workspaceId: ctx.workspaceId}}),
        tx.flow.count({where: {workspaceId: ctx.workspaceId}}),
      ]);
      if (inBoard >= MAX_FLOWS_PER_BOARD) return 'board_limit' as const;
      if (inWorkspace >= ent.limits.maxFlows) return 'plan_limit' as const;
      return tx.flow.create({
        data: {boardId: ctx.boardId, workspaceId: ctx.workspaceId, name: input.name, triggerKind: config.trigger.kind, enabled: input.enabled ?? true, config: config as unknown as Prisma.InputJsonValue, createdBy: userId},
        select: flowCols,
      });
    });
    if (made === 'board_limit') return c.json(problem('limit_reached', `A board holds up to ${MAX_FLOWS_PER_BOARD} flows.`), 409);
    if (made === 'plan_limit') return c.json(problem('limit_reached', 'This workspace has reached the number of flows its plan allows. Upgrade the plan or delete a flow.'), 409);
    await audit(db, {actorUserId: userId, action: 'flow.create', target: ['flow', made.id], meta: {workspaceId: ctx.workspaceId, boardId: ctx.boardId, trigger: config.trigger.kind}});
    return c.json({flow: await shapeOne(db, ctx, made)}, 201);
  })

  .patch('/flows/:id', flowBody(true), withViewer, requireAuth, requirePermission(PERMISSIONS.BOARD_FLOWS), withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const found = await findFlow(db, userId, idOf(c.req.param('id')));
    if (!found) return notFound(c, 'flow');
    const ctx = await boardFor(db, userId, found.boardId, true);
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const input = c.req.valid('json') as Input;
    const current = readConfig(found.config);
    const config: FlowConfig = {
      trigger: input.trigger ?? current?.trigger ?? ({kind: 'card_created', laneId: null} as const),
      conditions: input.conditions ?? current?.conditions ?? {labelId: null},
      actions: input.actions ?? current?.actions ?? [],
    };
    if (config.actions.length === 0) return invalid(c, {actions: {code: 'out_of_range', message: 'Add 1 to 3 actions.'}});
    const touchesConfig = input.trigger !== undefined || input.conditions !== undefined || input.actions !== undefined;
    if (touchesConfig || input.enabled === true) {
      const ent = await getEntitlements(db, ctx.workspaceId);
      if (!ent?.features.flows) return planBlocked(c);
    }
    if (touchesConfig) {
      const errors = await checkConfig(db, ctx, config);
      if (Object.keys(errors).length) return invalid(c, errors);
    }
    const {count} = await db.flow.updateMany({
      where: {id: found.id, boardId: ctx.boardId, workspaceId: ctx.workspaceId},
      data: {
        ...(input.name === undefined ? {} : {name: input.name}),
        ...(input.enabled === undefined ? {} : {enabled: input.enabled}),
        ...(touchesConfig ? {triggerKind: config.trigger.kind, config: config as unknown as Prisma.InputJsonValue} : {}),
        // A changed trigger starts fresh: today's claim must not hide a flow the owner just edited.
        ...(input.trigger !== undefined || input.enabled === true ? {lastRunOn: null} : {}),
      },
    });
    if (!count) return notFound(c, 'flow');
    const row = await db.flow.findFirst({where: {id: found.id, boardId: ctx.boardId, workspaceId: ctx.workspaceId}, select: flowCols});
    if (!row) return notFound(c, 'flow');
    await audit(db, {actorUserId: userId, action: 'flow.update', target: ['flow', found.id], meta: {workspaceId: ctx.workspaceId, boardId: ctx.boardId, fields: Object.keys(input)}});
    return c.json({flow: await shapeOne(db, ctx, row)});
  })

  .delete('/flows/:id', withViewer, requireAuth, requirePermission(PERMISSIONS.BOARD_FLOWS), withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const found = await findFlow(db, userId, idOf(c.req.param('id')));
    if (!found) return notFound(c, 'flow');
    // Deleting stays possible on an archived board or read-only workspace (it only frees room); admin is still required.
    const ctx = await boardFor(db, userId, found.boardId, false);
    if (refused(ctx)) return c.json(ctx.body, ctx.status);
    const {count} = await db.flow.deleteMany({where: {id: found.id, boardId: ctx.boardId, workspaceId: ctx.workspaceId}});
    if (!count) return notFound(c, 'flow');
    await audit(db, {actorUserId: userId, action: 'flow.delete', target: ['flow', found.id], meta: {workspaceId: ctx.workspaceId, boardId: ctx.boardId}});
    return c.json({ok: true});
  });

/** A flow of a workspace the visitor belongs to (membership IN the query); the board check decides what they may do. */
async function findFlow(db: PrismaClient, userId: number, flowId: number | undefined) {
  if (!flowId) return null;
  return db.flow.findFirst({
    where: {id: flowId, board: {workspace: {archivedAt: null, members: {some: {userId}}}}},
    select: {id: true, boardId: true, config: true},
  });
}
