import type {PrismaClient} from '../generated/prisma/client';
import {cache} from '../platform/cache';

/**
 * Entitlements: THE only place that decides what a workspace may do (docs/product/SPEC.md §10).
 * Routes ask `getEntitlements(db, workspaceId)` and read limits from it; they never read `plan_limits`,
 * `app_settings` or `workspaces.plan` themselves.
 *
 *  - `FREE_FOR_ALL`: every feature unlocked, plan limits NOT enforced (only the safety caps below), never read-only.
 *  - `PAID` (default): the workspace's plan limits are enforced. A workspace over a limit (members or storage) is in
 *    grace until `workspaces.grace_until`; after it passes, it is READ-ONLY (`readOnly: true`). It heals by itself
 *    once the workspace is back under its limits. Nothing is ever deleted by a mode switch or a downgrade.
 *
 * Cost: ONE database read (workspace LEFT JOIN plan_limits) in parallel with the cached `app_settings` row;
 * memoized per request (per database client, which is per request).
 */

export type BillingMode = 'PAID' | 'FREE_FOR_ALL';

export type PlanLimits = {
  plan: string;
  maxMembers: number;
  maxFileBytes: number;
  storageQuotaBytes: number;
  maxFlows: number;
  auditLog: boolean;
};

/** `brandColor`: the admin's `#rrggbb` brand colour, null = the default green (src/lib/brand.ts). */
export type AppSettingsValue = {billingMode: BillingMode; graceDays: number; maintenanceMessage: string; brandColor: string | null};

/** What FREE_FOR_ALL still caps, so nothing runs away (never shown as a plan limit). */
export const SAFETY_CAPS = {
  maxMembers: 500,
  /** The platform's own per-file maximum (docs/agent/files.md). */
  maxFileBytes: 100 * 1024 * 1024,
  storageQuotaBytes: 200 * 1024 * 1024 * 1024,
  maxFlows: 200,
} as const;

/** Safety cap on live cards in one lane (not a plan limit: it stops a script from filling the database). */
export const MAX_CARDS_PER_LANE = 500;

/** Used only when a workspace's plan row is missing (a deleted plan): the strictest sensible plan. */
const FALLBACK_LIMITS: PlanLimits = {
  plan: 'free',
  maxMembers: 10,
  maxFileBytes: 10 * 1024 * 1024,
  storageQuotaBytes: 1024 * 1024 * 1024,
  maxFlows: 0,
  auditLog: false,
};

export type EntitlementWorkspace = {
  id: number;
  plan: string;
  memberCount: number;
  storageUsedBytes: number;
  graceUntil: Date | null;
};

export type Entitlements = {
  workspaceId: number;
  billingMode: BillingMode;
  plan: string;
  /** What the workspace may use right now (plan limits when PAID, safety caps when FREE_FOR_ALL). */
  limits: {maxMembers: number; maxFileBytes: number; storageQuotaBytes: number; maxFlows: number};
  /** Features unlocked (all of them when FREE_FOR_ALL). */
  features: {auditLog: boolean; flows: boolean};
  usage: {members: number; storageUsedBytes: number};
  /** Over a PAID limit: until `graceUntil` (null = clock not started yet) the workspace still works. */
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
    ? {...SAFETY_CAPS}
    : {
        maxMembers: plan.maxMembers,
        maxFileBytes: plan.maxFileBytes,
        storageQuotaBytes: plan.storageQuotaBytes,
        maxFlows: plan.maxFlows,
      };
  const overLimit = !free && (workspace.memberCount > effective.maxMembers || workspace.storageUsedBytes > effective.storageQuotaBytes);
  const graceOver = overLimit && workspace.graceUntil !== null && workspace.graceUntil.getTime() <= now.getTime();
  return {
    workspaceId: workspace.id,
    billingMode: mode,
    plan: workspace.plan,
    limits: effective,
    features: {auditLog: free || plan.auditLog, flows: free || plan.maxFlows > 0},
    usage: {members: workspace.memberCount, storageUsedBytes: workspace.storageUsedBytes},
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

const DEFAULT_SETTINGS: AppSettingsValue = {billingMode: 'PAID', graceDays: 14, maintenanceMessage: '', brandColor: null};

/** `app_settings` (the single row), through the Site Cache. Shared by every visitor: nothing personal in it. */
export function getAppSettings(db: PrismaClient): Promise<AppSettingsValue> {
  return cache.getOrSet(SETTINGS_KEY, SETTINGS_TTL, async () => {
    const row = await db.appSettings.findUnique({
      where: {id: 1},
      select: {billingMode: true, graceDays: true, maintenanceMessage: true, brandColor: true},
    });
    if (!row) return DEFAULT_SETTINGS;
    return {
      billingMode: row.billingMode === 'FREE_FOR_ALL' ? 'FREE_FOR_ALL' : 'PAID',
      graceDays: row.graceDays,
      maintenanceMessage: row.maintenanceMessage,
      brandColor: row.brandColor,
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
  storage_used_bytes: bigint;
  grace_until: Date | null;
  max_members: number | null;
  max_file_bytes: bigint | null;
  storage_quota_bytes: bigint | null;
  max_flows: number | null;
  audit_log: boolean | null;
};

const memo = new WeakMap<PrismaClient, Map<number, Promise<Entitlements | null>>>();

/** Forget this request's answer after a write that changes it (a member joined, a plan changed). */
export function forgetEntitlements(db: PrismaClient, workspaceId: number): void {
  memo.get(db)?.delete(workspaceId);
}

async function load(db: PrismaClient, workspaceId: number): Promise<Entitlements | null> {
  const [rows, settings] = await Promise.all([
    db.$queryRaw<Row[]>`
      SELECT w.id, w.plan, w.member_count, w.storage_used_bytes, w.grace_until,
             p.max_members, p.max_file_bytes, p.storage_quota_bytes, p.max_flows, p.audit_log
      FROM workspaces w LEFT JOIN plan_limits p ON p.plan = w.plan
      WHERE w.id = ${workspaceId} LIMIT 1`,
    getAppSettings(db),
  ]);
  const row = rows[0];
  if (!row) return null;
  const limits: PlanLimits | null =
    row.max_members === null
      ? null
      : {
          plan: row.plan,
          maxMembers: row.max_members,
          maxFileBytes: Number(row.max_file_bytes),
          storageQuotaBytes: Number(row.storage_quota_bytes),
          maxFlows: row.max_flows ?? 0,
          auditLog: row.audit_log ?? false,
        };
  const build = (graceUntil: Date | null) =>
    computeEntitlements({
      limits,
      mode: settings.billingMode,
      workspace: {
        id: row.id,
        plan: row.plan,
        memberCount: row.member_count,
        storageUsedBytes: Number(row.storage_used_bytes),
        graceUntil,
      },
    });
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

/**
 * Starts the grace clock (once) for PAID workspaces now over a limit: after a switch to PAID, a plan's limits
 * lowered, or a downgrade. One statement; `plan` narrows it to one plan's workspaces.
 */
export async function startGraceForWorkspaces(db: PrismaClient, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.$executeRaw`
    UPDATE workspaces w
    SET grace_until = now() + make_interval(days => s.grace_days)
    FROM plan_limits p, app_settings s
    WHERE p.plan = w.plan AND s.id = 1 AND s.billing_mode = 'PAID'
      AND w.grace_until IS NULL
      AND (w.member_count > p.max_members OR w.storage_used_bytes > p.storage_quota_bytes)
      AND w.id = ANY(${ids}::int[])`;
  await db.$executeRaw`
    UPDATE workspaces w SET grace_until = NULL
    FROM plan_limits p, app_settings s
    WHERE p.plan = w.plan AND s.id = 1 AND w.grace_until IS NOT NULL
      AND (s.billing_mode = 'FREE_FOR_ALL' OR (w.member_count <= p.max_members AND w.storage_used_bytes <= p.storage_quota_bytes))
      AND w.id = ANY(${ids}::int[])`;
}

export async function startGraceForOverLimit(db: PrismaClient, options: {plan?: string; workspaceId?: number} = {}): Promise<number> {
  const plan = options.plan ?? null;
  const workspaceId = options.workspaceId ?? null;
  const started = await db.$executeRaw`
    UPDATE workspaces w
    SET grace_until = now() + make_interval(days => s.grace_days)
    FROM plan_limits p, app_settings s
    WHERE p.plan = w.plan AND s.id = 1 AND s.billing_mode = 'PAID'
      AND w.grace_until IS NULL
      AND (w.member_count > p.max_members OR w.storage_used_bytes > p.storage_quota_bytes)
      AND (${plan}::text IS NULL OR w.plan = ${plan})
      AND (${workspaceId}::int IS NULL OR w.id = ${workspaceId})`;
  // Back under the limits (or FREE_FOR_ALL): drop an old clock so a later overage starts a fresh grace.
  await db.$executeRaw`
    UPDATE workspaces w SET grace_until = NULL
    FROM plan_limits p, app_settings s
    WHERE p.plan = w.plan AND s.id = 1 AND w.grace_until IS NOT NULL
      AND (s.billing_mode = 'FREE_FOR_ALL' OR (w.member_count <= p.max_members AND w.storage_used_bytes <= p.storage_quota_bytes))
      AND (${plan}::text IS NULL OR w.plan = ${plan})
      AND (${workspaceId}::int IS NULL OR w.id = ${workspaceId})`;
  return Number(started);
}

/** Safety cap on saved card templates per workspace (not a plan limit: every plan gets the feature). */
export const MAX_CARD_TEMPLATES = 50;
