import type {PrismaClient} from '../../generated/prisma/client';
import {getEntitlements} from '../entitlements';
import {readConfig} from '../flows/config';
import {applyFlow, newRun, runFlows} from '../flows/engine';

/**
 * The daily Flows job: `daily_due` flows ("a card is due in N days"). Scheduled hourly in background.json; every
 * flow is CLAIMED once per UTC day (`flows.last_run_on`, one conditional update), so a repeat or a retry never runs it
 * twice and a run that stops early (time budget) is finished by the next hour. A flow claimed but not finished
 * (the process died) is not retried that day: at most once beats twice for comments and notifications.
 * Bounded: FLOWS_PER_PAGE flows per page, CARDS_PER_FLOW cards per flow, MAX_PAGES pages, a time budget.
 */

export const FLOWS_LIST = 'flows-daily';
const FLOWS_PER_PAGE = 20;
const CARDS_PER_FLOW = 200;
const MAX_PAGES = 10;
const TIME_BUDGET_MS = 40_000;

export const dayString = (d: Date) => d.toISOString().slice(0, 10);
const dayDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const addDays = (day: string, n: number) => dayString(new Date(dayDate(day).getTime() + n * 86_400_000));

export async function runDailyFlows(db: PrismaClient, now: Date = new Date()): Promise<{claimed: number; cards: number}> {
  const today = dayString(now);
  const todayDate = dayDate(today);
  const started = Date.now();
  let cursor = 0;
  let claimed = 0;
  let cards = 0;
  for (let page = 0; page < MAX_PAGES && Date.now() - started < TIME_BUDGET_MS; page++) {
    const flows = await db.flow.findMany({
      where: {triggerKind: 'daily_due', enabled: true, id: {gt: cursor}, OR: [{lastRunOn: null}, {lastRunOn: {lt: todayDate}}]},
      select: {id: true, name: true, config: true, boardId: true, workspaceId: true},
      orderBy: {id: 'asc'},
      take: FLOWS_PER_PAGE,
    });
    if (flows.length === 0) break;
    cursor = flows.at(-1)!.id;
    for (const flow of flows) {
      if (Date.now() - started >= TIME_BUDGET_MS) return {claimed, cards};
      const config = readConfig(flow.config);
      if (!config || config.trigger.kind !== 'daily_due') continue;
      // The claim: whoever flips last_run_on from an older day to today owns this day's run.
      const won = await db.flow.updateMany({
        where: {id: flow.id, enabled: true, OR: [{lastRunOn: null}, {lastRunOn: {lt: todayDate}}]},
        data: {lastRunOn: todayDate},
      });
      if (!won.count) continue;
      claimed++;
      try {
        const ent = await getEntitlements(db, flow.workspaceId);
        if (!ent || !ent.features.flows || ent.readOnly) continue;
        const board = await db.board.findFirst({
          where: {id: flow.boardId, workspaceId: flow.workspaceId, archivedAt: null, inboxOf: null, workspace: {archivedAt: null}},
          select: {id: true, workspaceId: true, visibility: true},
        });
        if (!board) continue;
        const rows = await db.card.findMany({
          where: {
            workspaceId: flow.workspaceId,
            boardId: board.id,
            dueDate: dayDate(addDays(today, config.trigger.dueInDays)),
            completedAt: null,
            archivedAt: null,
            ...(config.trigger.laneId ? {laneId: config.trigger.laneId} : {}),
          },
          select: {id: true},
          orderBy: {id: 'asc'},
          take: CARDS_PER_FLOW,
        });
        if (rows.length === 0) continue;
        cards += rows.length;
        // One shared run per flow: its budget caps the actions (a move may chain card_moved flows).
        const run = newRun();
        run.budget.left = rows.length * config.actions.length;
        await applyFlow(db, board, flow, 'daily_due', rows.map(r => r.id), run, ev => runFlows(db, [ev], {...run, depth: 1}));
      } catch (err) {
        console.error(`flows-daily ${flow.id}: ${(err as Error).message}`);
      }
    }
    if (flows.length < FLOWS_PER_PAGE) break;
  }
  return {claimed, cards};
}
