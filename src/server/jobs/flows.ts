import type {PrismaClient} from '../../generated/prisma/client';
import {getEntitlements} from '../entitlements';
import {readConfig} from '../flows/config';
import {applyFlow, newRun, runFlows} from '../flows/engine';

/**
 * The daily Flows job: `daily_due` flows ("a card is due in N days"). Scheduled hourly in background.json; every
 * flow is CLAIMED once per UTC day (`flows.last_run_on`, one conditional update), so a repeat or a retry never runs it
 * twice. A run that reaches its time budget stops BETWEEN cards and records the last card it finished
 * (`flows.resume_after`); the next hourly run that day claims that position (one conditional update again) and goes on
 * from the next card, so no card is skipped and none runs twice. The same happens when a flow has more than
 * CARDS_PER_FLOW due cards. A flow claimed but not finished because the process died (no position recorded) is not
 * retried that day: at most once beats twice for comments and notifications.
 * Bounded: FLOWS_PER_PAGE flows per page, CARDS_PER_FLOW cards per flow and run, MAX_PAGES pages, a time budget.
 */

export const FLOWS_LIST = 'flows-daily';
const FLOWS_PER_PAGE = 20;
const CARDS_PER_FLOW = 200;
const MAX_PAGES = 10;
const TIME_BUDGET_MS = 40_000;

export const dayString = (d: Date) => d.toISOString().slice(0, 10);
const dayDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const addDays = (day: string, n: number) => dayString(new Date(dayDate(day).getTime() + n * 86_400_000));

/** `cardsPerFlow`: tests only (a small page shows the resume path without hundreds of cards). */
export async function runDailyFlows(
  db: PrismaClient,
  now: Date = new Date(),
  {cardsPerFlow = CARDS_PER_FLOW}: {cardsPerFlow?: number} = {}
): Promise<{claimed: number; cards: number}> {
  const today = dayString(now);
  const todayDate = dayDate(today);
  const deadline = Date.now() + TIME_BUDGET_MS;
  let cursor = 0;
  let claimed = 0;
  let cards = 0;
  // Not run yet today, or stopped part-way today with a recorded position.
  const due = [{lastRunOn: null}, {lastRunOn: {lt: todayDate}}, {lastRunOn: todayDate, resumeAfter: {not: null}}];
  for (let page = 0; page < MAX_PAGES && Date.now() < deadline; page++) {
    const flows = await db.flow.findMany({
      where: {triggerKind: 'daily_due', enabled: true, id: {gt: cursor}, OR: due},
      select: {id: true, name: true, config: true, boardId: true, workspaceId: true, lastRunOn: true, resumeAfter: true},
      orderBy: {id: 'asc'},
      take: FLOWS_PER_PAGE,
    });
    if (flows.length === 0) break;
    cursor = flows.at(-1)!.id;
    for (const flow of flows) {
      if (Date.now() >= deadline) return {claimed, cards};
      const config = readConfig(flow.config);
      if (!config || config.trigger.kind !== 'daily_due') continue;
      const resuming = flow.lastRunOn !== null && dayString(flow.lastRunOn) === today && flow.resumeAfter !== null;
      // The claim: whoever flips last_run_on from an older day to today owns this day's run; a run stopped part-way
      // today is owned by whoever takes its recorded position (set back to null while it runs).
      const won = resuming
        ? await db.flow.updateMany({where: {id: flow.id, enabled: true, lastRunOn: todayDate, resumeAfter: flow.resumeAfter}, data: {resumeAfter: null}})
        : await db.flow.updateMany({
            where: {id: flow.id, enabled: true, OR: [{lastRunOn: null}, {lastRunOn: {lt: todayDate}}]},
            data: {lastRunOn: todayDate, resumeAfter: null},
          });
      if (!won.count) continue;
      claimed++;
      const after = resuming ? flow.resumeAfter! : 0;
      try {
        const [ent, board] = await Promise.all([
          getEntitlements(db, flow.workspaceId),
          db.board.findFirst({
            where: {id: flow.boardId, workspaceId: flow.workspaceId, archivedAt: null, inboxOf: null, workspace: {archivedAt: null}},
            select: {id: true, workspaceId: true, visibility: true},
          }),
        ]);
        if (!ent || !ent.features.flows || ent.readOnly || !board) continue;
        const rows = await db.card.findMany({
          where: {
            workspaceId: flow.workspaceId,
            boardId: board.id,
            dueDate: dayDate(addDays(today, config.trigger.dueInDays)),
            completedAt: null,
            archivedAt: null,
            id: {gt: after},
            ...(config.trigger.laneId ? {laneId: config.trigger.laneId} : {}),
          },
          select: {id: true},
          orderBy: {id: 'asc'},
          take: cardsPerFlow,
        });
        if (rows.length === 0) continue;
        // One shared run per flow: its budget caps the actions (a move may chain card_moved flows).
        const run = newRun();
        run.budget.left = rows.length * config.actions.length;
        const stoppedAt = await applyFlow(db, board, flow, 'daily_due', rows.map(r => r.id), run, ev => runFlows(db, [ev], {...run, depth: 1}), deadline);
        // Cards are in id order: everything before the one it stopped at is done. A full page may have more after it.
        const resumeAfter = stoppedAt !== null ? stoppedAt - 1 : rows.length === cardsPerFlow ? rows.at(-1)!.id : null;
        cards += stoppedAt !== null ? rows.findIndex(r => r.id === stoppedAt) : rows.length;
        if (resumeAfter !== null) {
          await db.flow.updateMany({where: {id: flow.id, lastRunOn: todayDate, resumeAfter: null}, data: {resumeAfter}});
        }
      } catch (err) {
        console.error(`flows-daily ${flow.id}: ${(err as Error).message}`);
      }
    }
    if (flows.length < FLOWS_PER_PAGE) break;
  }
  return {claimed, cards};
}
