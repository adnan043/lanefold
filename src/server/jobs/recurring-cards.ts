import {generateKeyBetween} from 'fractional-indexing';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {isFrequency, nextAfter, type RepeatRule} from '../../lib/recurrence';
import {reserveCardNumbers} from '../card-number';
import {getEntitlements, MAX_CARDS_PER_LANE} from '../entitlements';

/**
 * Recurring cards: the job behind `card_recurrences` (list and hourly schedule `recurring-cards` in background.json).
 *
 * Each run takes the enabled rules that are due (`next_run_on <= today`, UTC) in a bounded batch, oldest first, and for
 * each one makes ONE fresh copy of the rule's card and moves the rule on. Rules left over are picked up by the next run.
 *
 * Safe to repeat (a job may run twice, and two runs may overlap):
 *   - the rule row is locked (`FOR UPDATE`) and re-checked (`next_run_on` still the due day) inside the same transaction
 *     that makes the copy and moves the rule, so a second run finds nothing due;
 *   - the copy carries the key `recurring` + `<card id>:<due day>` (import_id / external_id, unique per board), so even a
 *     lost race cannot make two copies of one day.
 * A long outage never floods a board: one copy per rule per run, then the rule jumps to its first day after today.
 * A rule whose card is archived is switched off; a rule that cannot make a copy today (archived workspace, board or lane,
 * a read-only workspace, a full lane, the inbox) skips this occurrence and waits for the next one.
 */
export const RECURRING_CARDS_LIST = 'recurring-cards';
export const RULES_PER_PAGE = 25;
export const MAX_RULES_PER_RUN = 200;
/** A run stops taking new rules after this long (the platform allows 60 s per run). */
export const RUN_BUDGET_MS = 40_000;
export const RECURRING_KEY = 'recurring';
const DAY = 86_400_000;
const MAX_OFFSET_DAYS = 366;

export type RecurringResult = {created: number; skipped: number; disabled: number; failed: number; scanned: number};

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
const day = (d: Date) => d.toISOString().slice(0, 10);
const dayDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export async function runRecurringCards(db: PrismaClient, now: Date = new Date()): Promise<RecurringResult> {
  const today = day(now);
  const result: RecurringResult = {created: 0, skipped: 0, disabled: 0, failed: 0, scanned: 0};
  const readOnly = new Map<number, boolean>();
  const started = Date.now();
  let cursor: {on: Date; id: number} | null = null;
  while (result.scanned < MAX_RULES_PER_RUN && Date.now() - started < RUN_BUDGET_MS) {
    const rules: {cardId: number; nextRunOn: Date}[] = await db.cardRecurrence.findMany({
      where: {
        enabled: true,
        nextRunOn: {lte: dayDate(today)},
        ...(cursor ? {OR: [{nextRunOn: {gt: cursor.on}}, {nextRunOn: cursor.on, cardId: {gt: cursor.id}}]} : {}),
      },
      orderBy: [{nextRunOn: 'asc'}, {cardId: 'asc'}],
      take: Math.min(RULES_PER_PAGE, MAX_RULES_PER_RUN - result.scanned),
      select: {cardId: true, nextRunOn: true},
    });
    for (const rule of rules) {
      result.scanned++;
      try {
        const outcome = await runOne(db, rule.cardId, day(rule.nextRunOn), today, readOnly);
        result[outcome]++;
      } catch (error) {
        result.failed++;
        // The message only (an error object can carry query parameters). The rule stays due: the next run tries again.
        console.error(`recurring-cards card ${rule.cardId}: ${(error as Error).message}`);
      }
    }
    if (rules.length < RULES_PER_PAGE) break;
    const last = rules[rules.length - 1]!;
    cursor = {on: last.nextRunOn, id: last.cardId};
  }
  return result;
}

async function workspaceReadOnly(db: PrismaClient, workspaceId: number, memo: Map<number, boolean>): Promise<boolean> {
  const known = memo.get(workspaceId);
  if (known !== undefined) return known;
  const ent = await getEntitlements(db, workspaceId);
  const value = !ent || ent.readOnly;
  memo.set(workspaceId, value);
  return value;
}

async function runOne(db: PrismaClient, cardId: number, due: string, today: string, readOnly: Map<number, boolean>): Promise<'created' | 'skipped' | 'disabled'> {
  // Cheap reads first (outside the transaction): who owns it and may it be written to at all.
  const head = await db.card.findFirst({where: {id: cardId}, select: {workspaceId: true}});
  const frozen = head ? await workspaceReadOnly(db, head.workspaceId, readOnly) : false;
  return db.$transaction(async tx => {
    const locked = await tx.$queryRaw<
      {frequency: string; interval_count: number; anchor_on: Date; ends_on: Date | null; created_by: number | null}[]
    >`SELECT frequency, interval_count, anchor_on, ends_on, created_by FROM card_recurrences
      WHERE card_id = ${cardId} AND enabled AND next_run_on = ${dayDate(due)}::date FOR UPDATE`;
    const row = locked[0];
    if (!row) return 'skipped'; // another run already moved it on
    const rule: RepeatRule | null = isFrequency(row.frequency)
      ? {frequency: row.frequency, interval: row.interval_count, anchor: day(row.anchor_on), endsOn: row.ends_on ? day(row.ends_on) : null}
      : null;
    const settle = async (made: boolean, off = false) => {
      const next = rule && !off ? nextAfter(rule, today) : null;
      await tx.cardRecurrence.update({
        where: {cardId},
        data: {nextRunOn: dayDate(next ?? due), ...(made ? {lastRunOn: dayDate(due)} : {}), enabled: next !== null},
      });
      return made ? ('created' as const) : next === null ? ('disabled' as const) : ('skipped' as const);
    };
    if (!rule) return settle(false, true);

    const src = await tx.card.findFirst({
      where: {id: cardId},
      select: {
        title: true, descriptionMd: true, priority: true, estimateMinutes: true, startDate: true, dueDate: true,
        boardId: true, laneId: true, workspaceId: true, archivedAt: true, createdBy: true,
        board: {select: {archivedAt: true, inboxOf: true, workspace: {select: {archivedAt: true}}}},
        lane: {select: {archivedAt: true}},
        labels: {select: {labelId: true}, take: 50},
        members: {select: {userId: true}, take: 50},
        fieldValues: {select: {fieldId: true, textValue: true, numberValue: true, dateValue: true, boolValue: true, optionId: true}, take: 50},
        checklists: {orderBy: [{position: 'asc'}, {id: 'asc'}], take: 20, select: {title: true, position: true, items: {orderBy: [{position: 'asc'}, {id: 'asc'}], take: 100, select: {text: true, position: true}}}},
      },
    });
    if (!src || src.archivedAt) return settle(false, true); // an archived card stops repeating (restoring it does not bring the rule back)
    if (src.board.archivedAt || src.board.inboxOf !== null || src.board.workspace.archivedAt || src.lane.archivedAt || frozen) return settle(false);
    if (rule.endsOn && due > rule.endsOn) return settle(false, true);

    const key = `${cardId}:${due}`;
    const made = await tx.card.findFirst({where: {boardId: src.boardId, importId: RECURRING_KEY, externalId: key}, select: {id: true}});
    if (made) return settle(true);

    const rev = await bumpRev(tx, src.boardId, src.workspaceId);
    if (rev === null) return settle(false, true);
    const room = await tx.$queryRaw<{id: number}[]>`
      UPDATE lanes SET card_count = card_count + 1, updated_rev = ${rev}
      WHERE id = ${src.laneId} AND board_id = ${src.boardId} AND workspace_id = ${src.workspaceId}
        AND archived_at IS NULL AND card_count + 1 <= ${MAX_CARDS_PER_LANE}::int
      RETURNING id`;
    if (!room[0]) return settle(false); // lane full: skip this day (the board rev bump rolls back with nothing else to do; harmless)
    const last = await tx.card.findFirst({where: {workspaceId: src.workspaceId, laneId: src.laneId, archivedAt: null}, orderBy: [{position: 'desc'}, {id: 'desc'}], select: {position: true}});
    const shifted = (d: Date | null) => {
      if (!d) return null;
      const offset = Math.min(MAX_OFFSET_DAYS, Math.max(0, Math.round((d.getTime() - dayDate(rule.anchor).getTime()) / DAY)));
      return new Date(dayDate(due).getTime() + offset * DAY);
    };
    const items = src.checklists.reduce((n, l) => n + l.items.length, 0);
    const number = await reserveCardNumbers(tx, src.boardId, src.workspaceId, 1);
    const copy = await tx.card.create({
      data: {
        number,
        boardId: src.boardId, laneId: src.laneId, workspaceId: src.workspaceId,
        title: src.title, descriptionMd: src.descriptionMd, priority: src.priority, estimateMinutes: src.estimateMinutes,
        startDate: shifted(src.startDate), dueDate: shifted(src.dueDate),
        position: generateKeyBetween(last?.position ?? null, null),
        checklistTotal: items, checklistDone: 0, updatedRev: rev, createdBy: src.createdBy,
        importId: RECURRING_KEY, externalId: key,
        labels: {create: src.labels.map(l => ({labelId: l.labelId}))},
        members: {create: src.members.map(m => ({userId: m.userId, workspaceId: src.workspaceId}))},
        fieldValues: {create: src.fieldValues.map(v => ({...v, workspaceId: src.workspaceId}))},
        checklists: {create: src.checklists.map(l => ({workspaceId: src.workspaceId, title: l.title, position: l.position, items: {create: l.items.map(i => ({workspaceId: src.workspaceId, text: i.text, position: i.position}))}}))},
      },
      select: {id: true},
    });
    await tx.activity.create({
      data: {workspaceId: src.workspaceId, boardId: src.boardId, cardId: copy.id, actorId: row.created_by, kind: 'card.created', meta: {title: src.title, recurring: true, copiedFrom: cardId}},
    });
    return settle(true);
  });
}

/** `boards.rev + 1`, row-locked (the same statement as the routes; null when the board is gone). */
async function bumpRev(tx: Tx, boardId: number, workspaceId: number): Promise<bigint | null> {
  const rows = await tx.$queryRaw<{rev: bigint}[]>`UPDATE boards SET rev = rev + 1, updated_at = now() WHERE id = ${boardId} AND workspace_id = ${workspaceId} RETURNING rev`;
  return rows[0]?.rev ?? null;
}
