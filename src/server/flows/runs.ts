import type {PrismaClient} from '../../generated/prisma/client';

/**
 * Flow runs a month, like Trello's command runs: one run is one flow acting on one card. The count lives in
 * `flow_run_counts` (one row per workspace per calendar month, UTC); the DATABASE decides what is left, in one
 * conditional statement, so two cards moved at once can never spend past the plan's limit.
 */

type Db = Pick<PrismaClient, '$executeRaw' | '$queryRaw'>;

/** The first day of this calendar month (UTC), as `YYYY-MM-01`. */
export const monthOf = (now = new Date()) => `${now.toISOString().slice(0, 7)}-01`;

/**
 * Reserve up to `want` runs this month for a workspace whose plan allows `limit` a month (null = unlimited: every run
 * is granted and still counted, for the usage line). Returns how many were granted (0 when the month's runs are spent).
 * Give back what was not used with `releaseFlowRuns`.
 */
export async function reserveFlowRuns(db: Db, workspaceId: number, want: number, limit: number | null): Promise<number> {
  if (want <= 0) return 0;
  const month = monthOf();
  if (limit === null) {
    await db.$executeRaw`
      INSERT INTO flow_run_counts (workspace_id, month, runs) VALUES (${workspaceId}::int, ${month}::date, ${want}::int)
      ON CONFLICT (workspace_id, month) DO UPDATE SET runs = flow_run_counts.runs + EXCLUDED.runs`;
    return want;
  }
  if (limit <= 0) return 0;
  await db.$executeRaw`
    INSERT INTO flow_run_counts (workspace_id, month, runs) VALUES (${workspaceId}::int, ${month}::date, 0)
    ON CONFLICT (workspace_id, month) DO NOTHING`;
  // The row lock (FOR UPDATE) makes a concurrent reservation wait and then read the fresh count.
  const rows = await db.$queryRaw<{granted: number}[]>`
    WITH cur AS (
      SELECT runs FROM flow_run_counts WHERE workspace_id = ${workspaceId}::int AND month = ${month}::date FOR UPDATE
    )
    UPDATE flow_run_counts f SET runs = f.runs + LEAST(${want}::int, ${limit}::int - cur.runs)
    FROM cur
    WHERE f.workspace_id = ${workspaceId}::int AND f.month = ${month}::date AND cur.runs < ${limit}::int
    RETURNING LEAST(${want}::int, ${limit}::int - cur.runs)::int AS granted`;
  return rows[0]?.granted ?? 0;
}

/** Give back runs reserved but not used (the cards no longer needed the flow, a budget or deadline stopped it). */
export async function releaseFlowRuns(db: Db, workspaceId: number, unused: number): Promise<void> {
  if (unused <= 0) return;
  await db.$executeRaw`
    UPDATE flow_run_counts SET runs = GREATEST(0, runs - ${unused}::int)
    WHERE workspace_id = ${workspaceId}::int AND month = ${monthOf()}::date`;
}

/** Runs used this month (0 when none yet). One primary-key read. */
export async function flowRunsUsed(db: Pick<PrismaClient, '$queryRaw'>, workspaceId: number): Promise<number> {
  const rows = await db.$queryRaw<{runs: number}[]>`
    SELECT runs FROM flow_run_counts WHERE workspace_id = ${workspaceId}::int AND month = ${monthOf()}::date LIMIT 1`;
  return rows[0]?.runs ?? 0;
}
