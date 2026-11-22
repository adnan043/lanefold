import type {PrismaClient} from '../generated/prisma/client';
import {cache} from '../platform/cache';
import {FILE_CEILING_BYTES} from '../lib/file-limits';
import {MAX_BOARDS_CAP, UNLIMITED_MEMBERS} from '../lib/plan-limits';

/**
 * Entitlements: THE only place that decides what a workspace may do (docs/product/SPEC.md §10).
 * Routes ask `getEntitlements(db, workspaceId)` and read limits from it; they never read `plan_limits`,
 * `app_settings` or `workspaces.plan` themselves.
 *
 *  - `FREE_FOR_ALL`: every feature unlocked, plan limits NOT enforced (only the safety caps below), never read-only.
 *  - `PAID` (default): the workspace's plan limits are enforced (like Trello: members, open boards, file size, flow runs
 *    a month; no storage limit). A workspace over its MEMBER limit is in
 *    grace until `workspaces.grace_until`; after it passes, it is READ-ONLY (`readOnly: true`). It heals by itself
 *    once the workspace is back under its limits. Nothing is ever deleted by a mode switch or a downgrade.
 *
 * Cost: ONE database read (workspace LEFT JOIN plan_limits) in parallel with the cached `app_settings` row;
 * memoized per request (per database client, which is per request).
 */

export type BillingMode = 'PAID' | 'FREE_FOR_ALL';

export type PlanLimits = {
  plan: string;
  /** At SAFETY_CAPS.maxMembers or more = unlimited. */
  maxMembers: number;
  /** Open boards; null = unlimited. */
  maxBoards: number | null;
  maxFileBytes: number;
  /** Flow runs (one flow on one card) per calendar month (UTC); null = unlimited. */
  flowRunsPerMonth: number | null;
  auditLog: boolean;
};

export type AppSettingsValue = {billingMode: BillingMode; graceDays: number; maintenanceMessage: string};

/** What FREE_FOR_ALL still caps, so nothing runs away (never shown as a plan limit). */
export const SAFETY_CAPS = {
  /** The most members any workspace may have: a plan at this number is shown as "Unlimited". */
  maxMembers: UNLIMITED_MEMBERS,
  /** The most open boards any workspace may have ("Unlimited" on a plan is this). */
  maxBoards: MAX_BOARDS_CAP,
  /** The per-file ceiling (src/lib/file-limits.ts): 250 MB, Trello's paid limit. */
  maxFileBytes: FILE_CEILING_BYTES,
  /** No cap on flow runs a month (each run is still bounded by the engine's action budgets). */
  flowRunsPerMonth: null,
} as const;

/** Safety cap on live cards in one lane (not a plan limit: it stops a script from filling the database). */
export const MAX_CARDS_PER_LANE = 500;

/** Used only when a workspace's plan row is missing (a deleted plan): the strictest sensible plan. */
const FALLBACK_LIMITS: PlanLimits = {
  plan: 'free',
  maxMembers: 10,
  maxBoards: 10,
  maxFileBytes: 10 * 1024 * 1024,
  flowRunsPerMonth: 0,
  auditLog: false,
};

export type EntitlementWorkspace = {
  id: number;
  plan: string;
  memberCount: number;
  graceUntil: Date | null;
};

export type Entitlements = {
  workspaceId: number;
  billingMode: BillingMode;
  plan: string;
  /** What the workspace may use right now (plan limits when PAID, safety caps when FREE_FOR_ALL). Always enforceable
   *  numbers, except `flowRunsPerMonth` (null = unlimited). */
  limits: {maxMembers: number; maxBoards: number; maxFileBytes: number; flowRunsPerMonth: number | null};
  /** Which limits are "Unlimited" to show (the number behind them is only the safety cap). */
  unlimited: {members: boolean; boards: boolean; flowRuns: boolean};
  /** Features unlocked (all of them when FREE_FOR_ALL). */
  features: {auditLog: boolean; flows: boolean};
  usage: {members: number};
  /** Over the PAID member limit: until `graceUntil` (null = clock not started yet) the workspace still works. */
  overLimit: boolean;
  inGrace: boolean;
  graceUntil: string | null;
  /** Writes are refused (PAID, over a limit, grace over). Reads keep working. */
  readOnly: boolean;
  /** Show upgrade prompts and the pricing UI (PAID only). */
  upgradeUi: boolean;
};

export type ComputeInput = {
  limits: PlanLimits | null;
  workspace: EntitlementWorkspace;
  mode: BillingMode;
  now?: Date;
};

/** Pure: no I/O. `getEntitlements` feeds it; the unit tests call it directly. */
export function computeEntitlements({limits, workspace, mode, now = new Date()}: ComputeInput): Entitlements {
  const plan = limits ?? FALLBACK_LIMITS;
  const free = mode === 'FREE_FOR_ALL';
  const effective = free
    ? {maxMembers: SAFETY_CAPS.maxMembers, maxBoards: SAFETY_CAPS.maxBoards, maxFileBytes: SAFETY_CAPS.maxFileBytes, flowRunsPerMonth: SAFETY_CAPS.flowRunsPerMonth}
    : {
        maxMembers: Math.min(plan.maxMembers, SAFETY_CAPS.maxMembers),
        maxBoards: Math.min(plan.maxBoards ?? SAFETY_CAPS.maxBoards, SAFETY_CAPS.maxBoards),
        maxFileBytes: Math.min(plan.maxFileBytes, SAFETY_CAPS.maxFileBytes),
        flowRunsPerMonth: plan.flowRunsPerMonth,
      };
  const overLimit = !free && workspace.memberCount > effective.maxMembers;
  const graceOver = overLimit && workspace.graceUntil !== null && workspace.graceUntil.getTime() <= now.getTime();
  return {
    workspaceId: workspace.id,
    billingMode: mode,
    plan: workspace.plan,
    limits: effective,
    unlimited: {
      members: effective.maxMembers >= SAFETY_CAPS.maxMembers,
      boards: effective.maxBoards >= SAFETY_CAPS.maxBoards,
      flowRuns: effective.flowRunsPerMonth === null,
    },
    features: {auditLog: free || plan.auditLog, flows: free || plan.flowRunsPerMonth !== 0},
    usage: {members: workspace.memberCount},
    overLimit,
    inGrace: overLimit && !graceOver,
    graceUntil: overLimit && workspace.graceUntil ? workspace.graceUntil.toISOString() : null,
    readOnly: graceOver,
    upgradeUi: !free,
  };
}

/* ------------------------------------------------------------- app settings */

const SETTINGS_KEY = 'app:settings';
const CONFIG_KEY = 'app:config';
/** Cleared by the route that saves (`invalidateAppSettings`), so long; the hour is the safety net. */
const SETTINGS_TTL = 3600;

const DEFAULT_SETTINGS: AppSettingsValue = {billingMode: 'PAID', graceDays: 14, maintenanceMessage: ''};

/** `app_settings` (the single row), through the Site Cache. Shared by every visitor: nothing personal in it. */
export function getAppSettings(db: PrismaClient): Promise<AppSettingsValue> {
  return cache.getOrSet(SETTINGS_KEY, SETTINGS_TTL, async () => {
    const row = await db.appSettings.findUnique({
      where: {id: 1},
      select: {billingMode: true, graceDays: true, maintenanceMessage: true},
    });
    if (!row) return DEFAULT_SETTINGS;
    return {
      billingMode: row.billingMode === 'FREE_FOR_ALL' ? 'FREE_FOR_ALL' : 'PAID',
      graceDays: row.graceDays,
      maintenanceMessage: row.maintenanceMessage,
    } satisfies AppSettingsValue;
  });
}

/** Call right after `app_settings` or `plan_limits` changed. */
export async function invalidateAppSettings(): Promise<void> {
  await Promise.all([cache.del(SETTINGS_KEY), cache.del(CONFIG_KEY)]);
}

export const APP_CONFIG_KEY = CONFIG_KEY;

/* ------------------------------------------------------------ the one read */

type Row = {
  id: number;
  plan: string;
  member_count: number;
  grace_until: Date | null;
  max_members: number | null;
  max_boards: number | null;
  max_file_bytes: bigint | null;
  flow_runs_per_month: number | null;
  audit_log: boolean | null;
};

const memo = new WeakMap<PrismaClient, Map<number, Promise<Entitlements | null>>>();

/** Forget this request's answer after a write that changes it (a member joined, a plan changed). */
export function forgetEntitlements(db: PrismaClient, workspaceId: number): void {
  memo.get(db)?.delete(workspaceId);
}

function limitsOf(row: Row): PlanLimits | null {
  return row.max_members === null
    ? null
    : {
        plan: row.plan,
        maxMembers: row.max_members,
        maxBoards: row.max_boards,
        // Never above the app's ceiling, whatever an older plan row says.
        maxFileBytes: Math.min(Number(row.max_file_bytes), FILE_CEILING_BYTES),
        flowRunsPerMonth: row.flow_runs_per_month,
        auditLog: row.audit_log ?? false,
      };
}

function buildFrom(row: Row, mode: BillingMode, graceUntil: Date | null): Entitlements {
  return computeEntitlements({
    limits: limitsOf(row),
    mode,
    workspace: {
      id: row.id,
      plan: row.plan,
      memberCount: row.member_count,
      graceUntil,
    },
  });
}

async function load(db: PrismaClient, workspaceId: number): Promise<Entitlements | null> {
  const [rows, settings] = await Promise.all([
    db.$queryRaw<Row[]>`
      SELECT w.id, w.plan, w.member_count, w.grace_until,
             p.max_members, p.max_boards, p.max_file_bytes, p.flow_runs_per_month, p.audit_log
      FROM workspaces w LEFT JOIN plan_limits p ON p.plan = w.plan
      WHERE w.id = ${workspaceId} LIMIT 1`,
    getAppSettings(db),
  ]);
  const row = rows[0];
  if (!row) return null;
  const build = (graceUntil: Date | null) => buildFrom(row, settings.billingMode, graceUntil);
  const result = build(row.grace_until);
  // Over a PAID limit with no clock running (a failed sweep, a missed hook): start it now, so the workspace can never
  // stay over its limit forever. One idempotent UPDATE, only in that state; a failure never breaks the read.
  if (result.overLimit && row.grace_until === null) {
    try {
      const started = await startGraceForOverLimit(db, {workspaceId});
      // Nothing started (no settings row, a race): count the default grace in memory, never retry the writes per request.
      if (!started) return build(new Date(Date.now() + settings.graceDays * 86_400_000));
      const fresh = await db.$queryRaw<{grace_until: Date | null}[]>`SELECT grace_until FROM workspaces WHERE id = ${workspaceId} LIMIT 1`;
      return build(fresh[0]?.grace_until ?? null);
    } catch {
      return result;
    }
  }
  // Back under the limits with an old clock still set (members removed, a plan raised): drop it now,
  // not at the next daily sweep, so a later overage (a downgrade the same day) starts a FRESH grace instead of
  // reading the expired date as "grace over". One idempotent UPDATE, only in that state; a failure never breaks the read.
  // Only when the plan has a plan_limits row: the UPDATE joins it, so without one it could never clear the clock and
  // would run again on every request (the fallback limits already ignore the old clock).
  if (!result.overLimit && row.grace_until !== null && row.max_members !== null) {
    try {
      await startGraceForOverLimit(db, {workspaceId});
    } catch {
      /* the daily sweep clears it */
    }
  }
  return result;
}

/** Null when the workspace does not exist. Call it AFTER the membership check (it does not check access). */
export function getEntitlements(db: PrismaClient, workspaceId: number): Promise<Entitlements | null> {
  let perDb = memo.get(db);
  if (!perDb) memo.set(db, (perDb = new Map()));
  let found = perDb.get(workspaceId);
  if (!found) {
    const pending = load(db, workspaceId);
    perDb.set(workspaceId, (found = pending));
    // A failed read must not stay memoized for the rest of the request.
    pending.catch(() => perDb.get(workspaceId) === pending && perDb.delete(workspaceId));
  }
  return found;
}

/** Most workspaces one `getEntitlementsMany` call reads (the jobs page through workspaces in batches below this). */
export const MAX_ENTITLEMENTS_BATCH = 500;

/**
 * `getEntitlements` for many workspaces in ONE read (the scheduled jobs, which otherwise ask once per workspace in a
 * loop). Same answers: a workspace missing from the map does not exist. The rare workspace over a PAID limit with no
 * grace clock yet goes through `getEntitlements` (which starts the clock). Answers are memoized like single reads.
 * Does not check access: call it for workspaces the caller already scoped. At most MAX_ENTITLEMENTS_BATCH ids.
 */
export async function getEntitlementsMany(db: PrismaClient, workspaceIds: readonly number[]): Promise<Map<number, Entitlements>> {
  const ids = [...new Set(workspaceIds)].slice(0, MAX_ENTITLEMENTS_BATCH);
  const out = new Map<number, Entitlements>();
  if (ids.length === 0) return out;
  const [rows, settings] = await Promise.all([
    db.$queryRaw<Row[]>`
      SELECT w.id, w.plan, w.member_count, w.grace_until,
             p.max_members, p.max_boards, p.max_file_bytes, p.flow_runs_per_month, p.audit_log
      FROM workspaces w LEFT JOIN plan_limits p ON p.plan = w.plan
      WHERE w.id = ANY(${ids}::int[])
      LIMIT ${ids.length}`,
    getAppSettings(db),
  ]);
  let perDb = memo.get(db);
  if (!perDb) memo.set(db, (perDb = new Map()));
  const slow: number[] = [];
  for (const row of rows) {
    const ent = buildFrom(row, settings.billingMode, row.grace_until);
    // Rare states that need a write (start the clock, or drop an old one): through getEntitlements.
    if ((ent.overLimit && row.grace_until === null) || (!ent.overLimit && row.grace_until !== null && row.max_members !== null)) {
      slow.push(row.id);
      continue;
    }
    out.set(row.id, ent);
    if (!perDb.has(row.id)) perDb.set(row.id, Promise.resolve(ent));
  }
  for (const id of slow) {
    const ent = await getEntitlements(db, id);
    if (ent) out.set(id, ent);
  }
  return out;
}

/**
 * For the scheduled jobs: of `workspaceIds`, the ones that make nothing (missing, or read-only: over a plan limit,
 * grace over). Ids already in `memo` (workspace id -> frozen) cost nothing; the rest are read in ONE query per
 * MAX_ENTITLEMENTS_BATCH ids and added to it.
 */
export async function frozenWorkspaces(db: PrismaClient, workspaceIds: Iterable<number>, memo: Map<number, boolean> = new Map()): Promise<Set<number>> {
  const ids = [...new Set(workspaceIds)];
  const unknown = ids.filter(id => !memo.has(id));
  for (let i = 0; i < unknown.length; i += MAX_ENTITLEMENTS_BATCH) {
    const chunk = unknown.slice(i, i + MAX_ENTITLEMENTS_BATCH);
    const found = await getEntitlementsMany(db, chunk);
    for (const id of chunk) {
      const ent = found.get(id);
      memo.set(id, !ent || ent.readOnly);
    }
  }
  const out = new Set<number>();
  for (const id of ids) if (memo.get(id)) out.add(id);
  return out;
}

/**
 * Starts the grace clock (once) for PAID workspaces now over a limit: after a switch to PAID, a plan's limits
 * lowered, or a downgrade. One statement; `plan` narrows it to one plan's workspaces.
 * `restartExpired`: the call follows a PLAN CHANGE (a new over-limit event), so a clock that already ran out (left
 * from an earlier overage the sweep had not cleared yet) starts again instead of making the workspace read-only at
 * once. Never set it for a plain re-check: a workspace that stays over its limits must not get a new grace.
 */
export async function startGraceForWorkspaces(db: PrismaClient, ids: number[], {restartExpired = false}: {restartExpired?: boolean} = {}): Promise<void> {
  if (ids.length === 0) return;
  await db.$executeRaw`
    UPDATE workspaces w
    SET grace_until = now() + make_interval(days => s.grace_days)
    FROM plan_limits p, app_settings s
    WHERE p.plan = w.plan AND s.id = 1 AND s.billing_mode = 'PAID'
      AND (w.grace_until IS NULL OR (${restartExpired}::boolean AND w.grace_until <= now()))
      AND w.member_count > p.max_members
      AND w.id = ANY(${ids}::int[])`;
  await db.$executeRaw`
    UPDATE workspaces w SET grace_until = NULL
    FROM plan_limits p, app_settings s
    WHERE p.plan = w.plan AND s.id = 1 AND w.grace_until IS NOT NULL
      AND (s.billing_mode = 'FREE_FOR_ALL' OR w.member_count <= p.max_members)
      AND w.id = ANY(${ids}::int[])`;
}

/** `startGraceForWorkspaces` by plan or workspace (or all). `restartExpired`: see there (plan changes only). */
export async function startGraceForOverLimit(db: PrismaClient, options: {plan?: string; workspaceId?: number; restartExpired?: boolean} = {}): Promise<number> {
  const plan = options.plan ?? null;
  const workspaceId = options.workspaceId ?? null;
  const restartExpired = options.restartExpired ?? false;
  const started = await db.$executeRaw`
    UPDATE workspaces w
    SET grace_until = now() + make_interval(days => s.grace_days)
    FROM plan_limits p, app_settings s
    WHERE p.plan = w.plan AND s.id = 1 AND s.billing_mode = 'PAID'
      AND (w.grace_until IS NULL OR (${restartExpired}::boolean AND w.grace_until <= now()))
      AND w.member_count > p.max_members
      AND (${plan}::text IS NULL OR w.plan = ${plan})
      AND (${workspaceId}::int IS NULL OR w.id = ${workspaceId})`;
  // Back under the limits (or FREE_FOR_ALL): drop an old clock so a later overage starts a fresh grace.
  await db.$executeRaw`
    UPDATE workspaces w SET grace_until = NULL
    FROM plan_limits p, app_settings s
    WHERE p.plan = w.plan AND s.id = 1 AND w.grace_until IS NOT NULL
      AND (s.billing_mode = 'FREE_FOR_ALL' OR w.member_count <= p.max_members)
      AND (${plan}::text IS NULL OR w.plan = ${plan})
      AND (${workspaceId}::int IS NULL OR w.id = ${workspaceId})`;
  return Number(started);
}

/** Safety cap on saved card templates per workspace (not a plan limit: every plan gets the feature). */
export const MAX_CARD_TEMPLATES = 50;

/**
 * The plan's open-board limit (Trello: 10 open boards per Free workspace; archived boards don't count). Call INSIDE the
 * transaction that adds or un-archives a board: the workspace row lock queues parallel creates, so two can never both
 * pass the count. The count is bounded (it reads at most `max` rows of boards(workspace_id, archived_at, id)).
 */
export async function boardLimitReached(
  tx: Pick<PrismaClient, '$queryRaw'>,
  workspaceId: number,
  max: number,
): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId}::int FOR UPDATE`;
  const [row] = await tx.$queryRaw<{n: number}[]>`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM boards WHERE workspace_id = ${workspaceId}::int AND archived_at IS NULL LIMIT ${max}::int
    ) open_boards`;
  return (row?.n ?? 0) >= max;
}

/** The refusal every board-adding route sends when `boardLimitReached`. */
export const boardLimitMessage = (max: number) =>
  `This workspace has reached its plan's limit of ${max} open boards. Archive a board or upgrade the plan.`;
