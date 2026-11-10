import {Hono, type Context} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';
import {generateKeyBetween} from 'fractional-indexing';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {
  checkCard,
  checkLabels,
  checkLanes,
  IMPORT_LIMITS,
  isImportId,
  type ImpCard,
  type ImpLabel,
  type ImpLane,
} from '../../lib/trello-import';
import {audit} from '../../platform/auth';
import type {Viewer} from '../../platform/types';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {reserveCardNumbers} from '../card-number';
import {getEntitlements, MAX_CARDS_PER_LANE} from '../entitlements';
import {CSV_COLUMNS, csvRow, safeFileBase} from '../export-format';
import {invalid, idOf, intField, objectOf, textField, type FieldError} from '../validation';
import {boardAccess, membership, notFound, rankOf} from '../workspaces';

/**
 * Phase 8: import from a Trello export, export to JSON and CSV (docs/product/SPEC.md §5b). Mounted ONCE at `/` in `app.ts`.
 *
 *   POST /workspaces/:id/import/trello/dry-run   counts in, "can this be imported?" out (member and up). Writes NOTHING.
 *   POST /workspaces/:id/import/trello/start     create the board, its lanes and labels (member and up). Idempotent per `importId`.
 *   POST /boards/:id/import/trello/cards         one chunk (1 to 40 cards, 48 KB) with checklists, comments, links. Idempotent.
 *   GET  /boards/:id/export.json                 the whole board, streamed (board admin / workspace admin)
 *   GET  /boards/:id/export.csv                  one row per card, streamed, formula-safe (board admin / workspace admin)
 *
 * The browser parses the Trello file (the Site API body limit is 64 KB, so nothing big goes through the API),
 * shows the dry run, then sends the chunks. Every chunk is re-validated here with the same strict rules
 * (`src/lib/trello-import.ts`). No new table: the import key lives in an `audit_events` row (`target = import:<importId>`,
 * `meta` = the board id and the external-id to row-id maps), and `cards (board_id, import_id, external_id)` is unique,
 * so a retried chunk skips the cards it already made. Comments are written as the IMPORTING user's comments with the
 * original author named in the text (nobody is impersonated); no one's email address is read or written.
 * Attachments are links only: nothing is downloaded.
 *
 * Authorization: ids in URLs only SELECT. `membership()` / `boardAccess()` put the visitor's workspace membership IN
 * their query (not a member: 404). Export asks `canAdmin` (board admins and workspace owners/admins); a seat below: 403.
 */

const IMPORT_START = 'board.import_started';
const BOARDS_PER_HOUR = 20;
const EXPORTS_PER_HOUR = 20;
/** Largest export: more cards stop the stream and say `truncated`. */
const EXPORT_CARD_CAP = 5000;
const EXPORT_BATCH = 100;
const EXPORT_COMMENTS_PER_CARD = 200;

const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

const forbidden = (c: {json: (b: unknown, s: 403) => Response}) => c.json(problem('forbidden', 'You do not have access to this.'), 403);
const readOnly = (c: {json: (b: unknown, s: 409) => Response}) =>
  c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** `boards.rev + 1`, row-locked (the same statement as boards.ts: concurrent chunks queue here). */
async function bumpRev(tx: Tx, boardId: number, workspaceId: number): Promise<bigint> {
  const rows = await tx.$queryRaw<{rev: bigint}[]>`
    UPDATE boards SET rev = rev + 1, updated_at = now()
    WHERE id = ${boardId} AND workspace_id = ${workspaceId} RETURNING rev`;
  if (!rows[0]) throw new Error('board vanished');
  return rows[0].rev;
}

function keysAtEnd(last: string | null, n: number): string[] {
  const keys: string[] = [];
  let prev = last;
  for (let i = 0; i < n; i++) {
    prev = generateKeyBetween(prev, null);
    keys.push(prev);
  }
  return keys;
}

/** Boards this person created in this workspace in the last hour (bounded read). */
async function recentBoards(db: PrismaClient, workspaceId: number, userId: number): Promise<number> {
  const rows = await db.board.findMany({
    where: {workspaceId, createdBy: userId, createdAt: {gt: new Date(Date.now() - 3_600_000)}},
    select: {id: true},
    take: BOARDS_PER_HOUR,
  });
  return rows.length;
}

/* ------------------------------------------------------------- validators */

type DryRunCounts = {lanes: number; labels: number; cards: number; maxLaneCards: number; checklists: number; comments: number};
const dryRunBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const errors: Record<string, FieldError> = {};
  const out: Record<string, number> = {};
  const caps: Record<string, number> = {lanes: 1000, labels: 1000, cards: 100_000, maxLaneCards: 100_000, checklists: 1_000_000, comments: 1_000_000};
  for (const key of Object.keys(caps)) {
    const n = intField(v?.[key], 0, caps[key]!);
    if (n.ok) out[key] = n.value;
    else errors[key] = n.error;
  }
  if (Object.keys(errors).length) return invalid(c, errors);
  return out as DryRunCounts;
});

type StartBody = {importId: string; name: string; lanes: ImpLane[]; labels: ImpLabel[]; totalCards: number};
const startBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const errors: Record<string, FieldError> = {};
  if (!isImportId(v?.importId)) errors.importId = {code: 'invalid', message: 'Start the import again.'};
  const name = textField(v?.name, 1, IMPORT_LIMITS.name);
  if (!name.ok) errors.name = name.error;
  const lanes = checkLanes(v?.lanes);
  if (!lanes.ok) errors.lanes = {code: 'invalid', message: 'The lanes are not valid.'};
  const labels = checkLabels(v?.labels);
  if (!labels.ok) errors.labels = {code: 'invalid', message: 'The labels are not valid.'};
  const total = intField(v?.totalCards, 0, IMPORT_LIMITS.cards);
  if (!total.ok) errors.totalCards = total.error;
  if (Object.keys(errors).length) return invalid(c, errors);
  return {
    importId: v!.importId as string,
    name: (name as {value: string}).value,
    lanes: (lanes as {value: ImpLane[]}).value,
    labels: (labels as {value: ImpLabel[]}).value,
    totalCards: (total as {value: number}).value,
  } satisfies StartBody;
});

type ChunkBody = {importId: string; cards: ImpCard[]};
const chunkBody = validator('json', (value, c) => {
  const v = objectOf(value);
  if (!isImportId(v?.importId)) return invalid(c, {importId: {code: 'invalid', message: 'Start the import again.'}});
  if (!Array.isArray(v?.cards) || v.cards.length < 1 || v.cards.length > IMPORT_LIMITS.chunkCards) {
    return invalid(c, {cards: {code: 'out_of_range', message: `Send 1 to ${IMPORT_LIMITS.chunkCards} cards at a time.`}});
  }
  const cards: ImpCard[] = [];
  const seen = new Set<string>();
  for (const raw of v.cards) {
    const checked = checkCard(raw);
    if (!checked.ok) return invalid(c, {cards: {code: 'invalid', message: 'A card in this chunk is not valid.'}});
    if (seen.has(checked.value.ext)) return invalid(c, {cards: {code: 'invalid', message: 'A card is repeated in this chunk.'}});
    seen.add(checked.value.ext);
    cards.push(checked.value);
  }
  return {importId: v.importId as string, cards} satisfies ChunkBody;
});

/* ---------------------------------------------------------- import record */

type StartMeta = {workspaceId: number; boardId: number; totalCards: number; lanes: Record<string, number>; labels: Record<string, number>};

const isIdMap = (v: unknown): v is Record<string, number> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(n => Number.isSafeInteger(n));

function readMeta(meta: unknown): StartMeta | null {
  const m = objectOf(meta);
  if (!m || !Number.isSafeInteger(m.workspaceId) || !Number.isSafeInteger(m.boardId) || !Number.isSafeInteger(m.totalCards)) return null;
  if (!isIdMap(m.lanes) || !isIdMap(m.labels)) return null;
  return m as unknown as StartMeta;
}

/** The start record of ONE import of THIS user (the actor is IN the where: nobody reads another person's import). */
const startRecord = (db: PrismaClient | Tx, userId: number, importId: string) =>
  db.auditEvent.findFirst({
    where: {actorUserId: userId, action: IMPORT_START, targetType: 'import', targetId: importId},
    orderBy: {id: 'asc'},
    select: {meta: true},
  });

class TooManyCards extends Error {}
class LaneFull extends Error {}
class UnknownLane extends Error {}

/* ----------------------------------------------------------------- export */

type ExportCard = {
  id: number;
  number: number | null;
  title: string;
  description: string;
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  completed: boolean;
  archived: boolean;
  createdAt: string;
  labels: string[];
  assignees: string[];
  checklists: {title: string; items: {text: string; done: boolean; assignee: string | null; dueDate: string | null}[]}[];
  comments: {author: string | null; createdAt: string; text: string}[];
  attachments: {name: string; url: string | null}[];
};

type ExportEvent =
  | {kind: 'lane'; name: string; archived: boolean; wipLimit: number | null}
  | {kind: 'card'; laneName: string; card: ExportCard}
  | {kind: 'lane_end'}
  | {kind: 'end'; truncated: boolean; cards: number};

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/** Cards in keyset batches of `EXPORT_BATCH` over the WHOLE board (lane, position, id): empty lanes cost no query; children in 5 parallel reads plus one name read per batch. */
async function* exportEvents(db: PrismaClient, workspaceId: number, boardId: number, labelNames: Map<number, string>): AsyncGenerator<ExportEvent> {
  const lanes = await db.lane.findMany({
    where: {workspaceId, boardId},
    orderBy: [{position: 'asc'}, {id: 'asc'}],
    take: 200,
    select: {id: true, name: true, archivedAt: true, wipLimit: true},
  });
  let total = 0;
  let truncated = false;
  // ONE keyset read over the whole board (cards joined to their lane, in lane order): empty lanes cost no query and a batch is never cut at a lane edge.
  let laneAt = -1;
  const openLane = function* (upTo: number): Generator<ExportEvent> {
    while (laneAt < upTo) {
      if (laneAt >= 0) yield {kind: 'lane_end'};
      laneAt++;
      const l = lanes[laneAt]!;
      yield {kind: 'lane', name: l.name, archived: l.archivedAt !== null, wipLimit: l.wipLimit};
    }
  };
  const laneIndex = new Map(lanes.map((l, i) => [l.id, i]));
  const laneIds = lanes.map(l => l.id);
  let cursor: {lanePosition: string; laneId: number; position: string; id: number} | null = null;
  while (laneIds.length) {
    const take = Math.min(EXPORT_BATCH, EXPORT_CARD_CAP - total);
    if (take <= 0) {
      truncated = true;
      break;
    }
    const rows: {
      id: number; number: number | null; lane_id: number; lane_position: string; title: string; description_md: string; position: string; priority: string;
      start_date: Date | null; due_date: Date | null; completed_at: Date | null; archived_at: Date | null; created_at: Date;
    }[] = await db.$queryRaw`
      SELECT c.id, c.number, c.lane_id, l.position AS lane_position, c.title, c.description_md, c.position, c.priority,
             c.start_date, c.due_date, c.completed_at, c.archived_at, c.created_at
      FROM cards c JOIN lanes l ON l.id = c.lane_id
      WHERE c.workspace_id = ${workspaceId} AND c.board_id = ${boardId} AND c.lane_id IN (${Prisma.join(laneIds)})
        ${cursor ? Prisma.sql`AND (l.position, l.id, c.position, c.id) > (${cursor.lanePosition}::text COLLATE "C", ${cursor.laneId}::int, ${cursor.position}::text COLLATE "C", ${cursor.id}::int)` : Prisma.empty}
      ORDER BY l.position, l.id, c.position, c.id
      LIMIT ${take}`;
    const cards = rows.map(r => ({
      id: r.id, number: r.number, laneId: r.lane_id, title: r.title, descriptionMd: r.description_md, position: r.position, priority: r.priority,
      startDate: r.start_date, dueDate: r.due_date, completedAt: r.completed_at, archivedAt: r.archived_at, createdAt: r.created_at,
    }));
      if (!cards.length) break;
      const ids = cards.map(c => c.id);
      const [cardLabels, cardMembers, checklists, comments, attachments] = await Promise.all([
        db.cardLabel.findMany({where: {cardId: {in: ids}}, select: {cardId: true, labelId: true}, take: ids.length * 50}),
        db.cardMember.findMany({where: {workspaceId, cardId: {in: ids}}, select: {cardId: true, userId: true}, take: ids.length * 50}),
        db.checklist.findMany({
          where: {workspaceId, cardId: {in: ids}},
          orderBy: [{position: 'asc'}, {id: 'asc'}],
          take: ids.length * 20,
          select: {cardId: true, title: true, items: {orderBy: [{position: 'asc'}, {id: 'asc'}], take: 100, select: {text: true, doneAt: true, assigneeId: true, dueDate: true}}},
        }),
        db.$queryRaw<{card_id: number; author_id: number | null; body_md: string; created_at: Date}[]>`
          SELECT card_id, author_id, body_md, created_at FROM (
            SELECT card_id, author_id, body_md, created_at, id,
                   row_number() OVER (PARTITION BY card_id ORDER BY id) AS rn
            FROM comments
            WHERE workspace_id = ${workspaceId} AND card_id IN (${Prisma.join(ids)})
          ) t WHERE rn <= ${EXPORT_COMMENTS_PER_CARD} ORDER BY card_id, id`,
        db.attachment.findMany({
          where: {workspaceId, cardId: {in: ids}, ready: true},
          orderBy: {id: 'asc'},
          take: ids.length * 50,
          select: {cardId: true, name: true, url: true},
        }),
      ]);
      // Names only, never an email: members and comment authors in ONE read.
      const wanted = [
        ...new Set([
          ...cardMembers.map(m => m.userId),
          ...comments.flatMap(c => (c.author_id === null ? [] : [c.author_id])),
          ...checklists.flatMap(cl => cl.items.flatMap(i => (i.assigneeId === null ? [] : [i.assigneeId]))),
        ]),
      ];
      const names = new Map<number, string>();
      if (wanted.length) {
        for (const u of await db.user.findMany({where: {id: {in: wanted}}, select: {id: true, name: true}, take: wanted.length})) names.set(u.id, u.name);
      }
      const group = <T extends {cardId: number}>(rows: T[]) => {
        const m = new Map<number, T[]>();
        for (const r of rows) (m.get(r.cardId) ?? m.set(r.cardId, []).get(r.cardId)!).push(r);
        return m;
      };
      const labelsBy = group(cardLabels);
      const membersBy = group(cardMembers);
      const checklistsBy = group(checklists);
      const attachmentsBy = group(attachments.flatMap(a => (a.cardId === null ? [] : [{...a, cardId: a.cardId}])));
      const commentsBy = group(comments.map(c => ({...c, cardId: c.card_id})));
      for (const card of cards) {
        const li = laneIndex.get(card.laneId) ?? laneAt;
        yield* openLane(li);
        yield {
          kind: 'card',
          laneName: lanes[li]!.name,
          card: {
            id: card.id,
            number: card.number,
            title: card.title,
            description: card.descriptionMd,
            priority: card.priority,
            startDate: day(card.startDate),
            dueDate: day(card.dueDate),
            completed: card.completedAt !== null,
            archived: card.archivedAt !== null,
            createdAt: card.createdAt.toISOString(),
            labels: (labelsBy.get(card.id) ?? []).flatMap(l => (labelNames.has(l.labelId) ? [labelNames.get(l.labelId)!] : [])),
            assignees: (membersBy.get(card.id) ?? []).flatMap(m => (names.has(m.userId) ? [names.get(m.userId)!] : [])),
            checklists: (checklistsBy.get(card.id) ?? []).map(cl => ({title: cl.title, items: cl.items.map(i => ({text: i.text, done: i.doneAt !== null, assignee: i.assigneeId === null ? null : (names.get(i.assigneeId) ?? null), dueDate: day(i.dueDate)}))})),
            comments: (commentsBy.get(card.id) ?? []).map(c => ({
              author: c.author_id === null ? null : (names.get(c.author_id) ?? null),
              createdAt: c.created_at.toISOString(),
              text: c.body_md,
            })),
            // Uploaded files are private: only their name is exported, never a link to the bytes.
            attachments: (attachmentsBy.get(card.id) ?? []).map(a => ({name: a.name, url: a.url})),
          },
        };
      }
      total += cards.length;
      const lastCard = cards[cards.length - 1]!;
      const lastRow = rows[rows.length - 1]!;
      cursor = {lanePosition: lastRow.lane_position, laneId: lastRow.lane_id, position: lastCard.position, id: lastCard.id};
      if (cards.length < take) break;
    }
  // Remaining (empty) lanes, then close the last open one.
  yield* openLane(lanes.length - 1);
  if (laneAt >= 0) yield {kind: 'lane_end'};
  yield {kind: 'end', truncated, cards: total};
}

async function* jsonParts(head: Record<string, unknown>, events: AsyncGenerator<ExportEvent>): AsyncGenerator<string> {
  const lead = JSON.stringify(head);
  yield `${lead.slice(0, -1)},"lanes":[`;
  let lanes = 0;
  let cards = 0;
  for await (const e of events) {
    if (e.kind === 'lane') {
      yield `${lanes++ ? ',' : ''}{"name":${JSON.stringify(e.name)},"archived":${e.archived},"wipLimit":${e.wipLimit ?? 'null'},"cards":[`;
      cards = 0;
    } else if (e.kind === 'card') {
      yield `${cards++ ? ',' : ''}${JSON.stringify(e.card)}`;
    } else if (e.kind === 'lane_end') yield ']}';
    else yield `],"truncated":${e.truncated},"cardCount":${e.cards}}`;
  }
}

async function* csvParts(events: AsyncGenerator<ExportEvent>): AsyncGenerator<string> {
  yield `﻿${csvRow(CSV_COLUMNS)}`;
  for await (const e of events) {
    if (e.kind !== 'card') continue;
    const c = e.card;
    const total = c.checklists.reduce((n, cl) => n + cl.items.length, 0);
    const done = c.checklists.reduce((n, cl) => n + cl.items.filter(i => i.done).length, 0);
    yield csvRow([
      e.laneName,
      c.id,
      c.title,
      c.description,
      c.labels.join('; '),
      c.priority,
      c.assignees.join('; '),
      c.startDate,
      c.dueDate,
      c.completed ? 'yes' : 'no',
      c.archived ? 'yes' : 'no',
      done,
      total,
      c.comments.length,
      c.attachments.map(a => a.url ?? a.name).join('; '),
      c.createdAt,
      c.number ?? '',
    ]);
  }
}

function streamOf(parts: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await parts.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (err) {
        console.error(`export stream: ${(err as Error).message}`);
        controller.error(err);
      }
    },
    async cancel() {
      await parts.return(undefined);
    },
  });
}

/** Board admin (or workspace admin) only; the refusal is the answer to send. */
async function exportAccess(db: PrismaClient, userId: number, boardId: number | undefined) {
  if (!boardId) return {status: 404 as const, body: problem('not_found', 'No such board.')};
  const access = await boardAccess(db, boardId, userId);
  if (!access) return {status: 404 as const, body: problem('not_found', 'No such board.')};
  if (!access.canAdmin) return {status: 403 as const, body: problem('forbidden', 'You do not have access to this.')};
  return {boardId, access};
}

async function exportResponse(c: Context<{Variables: {db: PrismaClient; viewer: Viewer}}, any, any>, format: 'json' | 'csv') {
  const db = c.var.db;
  const userId = c.var.viewer.id!;
  const ctx = await exportAccess(db, userId, idOf(c.req.param('id')));
  if ('status' in ctx) return c.json(ctx.body, ctx.status);
  const {workspaceId} = ctx.access;
  // A person may export so many times an hour (each one reads the whole board).
  const recent = await db.auditEvent.findMany({
    where: {actorUserId: userId, action: 'board.exported', createdAt: {gt: new Date(Date.now() - 3_600_000)}},
    orderBy: {id: 'desc'},
    select: {id: true},
    take: EXPORTS_PER_HOUR,
  });
  if (recent.length >= EXPORTS_PER_HOUR) {
    c.header('Retry-After', '600');
    return c.json(problem('export_rate_limited', 'You exported many boards in the last hour. Try again later.'), 429);
  }
  const [board, labels] = await Promise.all([
    db.board.findFirst({where: {id: ctx.boardId, workspaceId}, select: {name: true, visibility: true, archivedAt: true}}),
    db.label.findMany({where: {workspaceId, boardId: ctx.boardId}, orderBy: {id: 'asc'}, take: 100, select: {id: true, name: true, colorHex: true}}),
  ]);
  if (!board) return c.json(problem('not_found', 'No such board.'), 404);
  await audit(db, {actorUserId: userId, action: 'board.exported', target: ['board', ctx.boardId], meta: {format}});
  const events = exportEvents(db, workspaceId, ctx.boardId, new Map(labels.map(l => [l.id, l.name])));
  const parts =
    format === 'json'
      ? jsonParts(
          {
            format: 'lanefold.board.v1',
            exportedAt: new Date().toISOString(),
            board: {name: board.name, visibility: board.visibility, archived: board.archivedAt !== null},
            labels: labels.map(l => ({name: l.name, color: l.colorHex})),
          },
          events
        )
      : csvParts(events);
  const file = `${safeFileBase(board.name)}-${new Date().toISOString().slice(0, 10)}.${format}`;
  return new Response(streamOf(parts), {
    status: 200,
    headers: {
      'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${file}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/* ----------------------------------------------------------------- routes */

export const importExportRoutes = new Hono()
  /* ------------------------------------------------------------ dry run */
  .post('/workspaces/:id/import/trello/dry-run', dryRunBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const workspaceId = idOf(c.req.param('id'));
    if (!workspaceId) return notFound(c);
    const member = await membership(db, workspaceId, userId);
    if (!member) return notFound(c);
    if (rankOf(member.role) < 2) return forbidden(c);
    const counts = c.req.valid('json') as DryRunCounts;
    const [ent, recent] = await Promise.all([getEntitlements(db, workspaceId), recentBoards(db, workspaceId, userId)]);
    // Nothing below writes: the answer is a list of reasons the real import would be refused.
    const problems: {code: string; limit?: number; value?: number}[] = [];
    if (ent?.readOnly) problems.push({code: 'read_only'});
    if (recent >= BOARDS_PER_HOUR) problems.push({code: 'board_rate_limited', limit: BOARDS_PER_HOUR});
    if (counts.cards + counts.lanes === 0) problems.push({code: 'empty'});
    if (counts.lanes > IMPORT_LIMITS.lanes) problems.push({code: 'too_many_lanes', limit: IMPORT_LIMITS.lanes, value: counts.lanes});
    if (counts.labels > IMPORT_LIMITS.labels) problems.push({code: 'too_many_labels', limit: IMPORT_LIMITS.labels, value: counts.labels});
    if (counts.cards > IMPORT_LIMITS.cards) problems.push({code: 'too_many_cards', limit: IMPORT_LIMITS.cards, value: counts.cards});
    if (counts.maxLaneCards > MAX_CARDS_PER_LANE) problems.push({code: 'lane_full', limit: MAX_CARDS_PER_LANE, value: counts.maxLaneCards});
    return c.json({
      canImport: problems.length === 0,
      problems,
      limits: {lanes: IMPORT_LIMITS.lanes, labels: IMPORT_LIMITS.labels, cards: IMPORT_LIMITS.cards, cardsPerLane: MAX_CARDS_PER_LANE, chunkCards: IMPORT_LIMITS.chunkCards},
      counts,
    });
  })

  /* -------------------------------------------------------------- start */
  .post('/workspaces/:id/import/trello/start', startBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const workspaceId = idOf(c.req.param('id'));
    if (!workspaceId) return notFound(c);
    const member = await membership(db, workspaceId, userId);
    if (!member) return notFound(c);
    if (rankOf(member.role) < 2) return forbidden(c);
    const body = c.req.valid('json') as StartBody;

    // A retry of a start that already worked answers the same board, without the checks that would now fail (rate, plan).
    const earlier = await startRecord(db, userId, body.importId);
    const resumed = earlier ? readMeta(earlier.meta) : null;
    if (earlier) {
      if (!resumed || resumed.workspaceId !== workspaceId) return c.json(problem('import_id_used', 'That import key belongs to another import.'), 409);
      const access = await boardAccess(db, resumed.boardId, userId);
      if (!access || access.workspaceId !== workspaceId) return notFound(c, 'board');
      return c.json({board: {id: resumed.boardId}, lanes: resumed.lanes, labels: resumed.labels, resumed: true});
    }

    const ent = await getEntitlements(db, workspaceId);
    if (ent?.readOnly) return readOnly(c);
    if ((await recentBoards(db, workspaceId, userId)) >= BOARDS_PER_HOUR) {
      c.header('Retry-After', '600');
      return c.json(problem('board_rate_limited', 'You created many boards in the last hour. Try again later.'), 429);
    }

    const laneKeys = keysAtEnd(null, body.lanes.length);
    const out = await db.$transaction(async tx => {
      // Two parallel starts with one key queue here; the second finds the first one's record.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${userId}::int, hashtext(${body.importId}))`;
      const again = await startRecord(tx, userId, body.importId);
      const againMeta = again ? readMeta(again.meta) : null;
      if (againMeta) return {meta: againMeta, resumed: true};
      const board = await tx.board.create({
        data: {workspaceId, name: body.name, visibility: 'private', bgKind: 'color', rev: 1n, createdBy: userId},
        select: {id: true},
      });
      // The importer is a board admin, like the creator of any board.
      await tx.boardMember.create({data: {boardId: board.id, workspaceId, userId, role: 'admin'}});
      const lanes = body.lanes.length
        ? await tx.lane.createManyAndReturn({
            data: body.lanes.map((l, i) => ({boardId: board.id, workspaceId, name: l.name, position: laneKeys[i]!, updatedRev: 1n})),
            select: {id: true, position: true},
          })
        : [];
      const labels = body.labels.length
        ? await tx.label.createManyAndReturn({
            data: body.labels.map(l => ({boardId: board.id, workspaceId, name: l.name, colorHex: l.color})),
            select: {id: true, name: true},
          })
        : [];
      // Lanes are matched by their (unique) key; labels by id order, which is the order of `data` (one multi-row INSERT).
      const laneByKey = new Map(lanes.map(l => [l.position, l.id]));
      const laneMap: Record<string, number> = {};
      body.lanes.forEach((l, i) => (laneMap[l.ext] = laneByKey.get(laneKeys[i]!)!));
      const labelIds = labels.map(l => l.id).sort((a, b) => a - b);
      const labelMap: Record<string, number> = {};
      body.labels.forEach((l, i) => (labelMap[l.ext] = labelIds[i]!));
      const meta: StartMeta = {workspaceId, boardId: board.id, totalCards: body.totalCards, lanes: laneMap, labels: labelMap};
      await tx.auditEvent.create({
        data: {actorUserId: userId, action: IMPORT_START, targetType: 'import', targetId: body.importId, meta: meta as unknown as Prisma.InputJsonObject},
        select: {id: true},
      });
      await tx.activity.create({data: {workspaceId, boardId: board.id, actorId: userId, kind: 'board.created', meta: {name: body.name, imported: true}}});
      return {meta, resumed: false};
    });
    return c.json({board: {id: out.meta.boardId}, lanes: out.meta.lanes, labels: out.meta.labels, resumed: out.resumed}, out.resumed ? 200 : 201);
  })

  /* -------------------------------------------------------------- chunk */
  .post('/boards/:id/import/trello/cards', chunkBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const boardId = idOf(c.req.param('id'));
    if (!boardId) return notFound(c, 'board');
    const access = await boardAccess(db, boardId, userId);
    if (!access) return notFound(c, 'board');
    if (!access.canWrite) return forbidden(c);
    if (access.archived) return c.json(problem('board_archived', 'This board is archived.'), 409);
    const ent = await getEntitlements(db, access.workspaceId);
    if (ent?.readOnly) return readOnly(c);
    const {workspaceId} = access;
    const body = c.req.valid('json') as ChunkBody;
    // The import must be this person's, for THIS board (a key of another board or person is "not found").
    const record = await startRecord(db, userId, body.importId);
    const meta = record ? readMeta(record.meta) : null;
    if (!meta || meta.boardId !== boardId || meta.workspaceId !== workspaceId) return notFound(c, 'import');

    let result: {created: number; skipped: number; rev: bigint};
    try {
      result = await db.$transaction(async tx => {
        const exts = body.cards.map(card => card.ext);
        const known = await tx.card.findMany({where: {boardId, importId: body.importId, externalId: {in: exts}}, select: {externalId: true}, take: exts.length});
        const have = new Set(known.map(k => k.externalId));
        const fresh = body.cards.filter(card => !have.has(card.ext));
        if (!fresh.length) return {created: 0, skipped: body.cards.length, rev: access.rev};
        const already = await tx.card.count({where: {boardId, importId: body.importId}});
        if (already + fresh.length > meta.totalCards) throw new TooManyCards();
        if (fresh.some(card => meta.lanes[card.lane] === undefined)) throw new UnknownLane();

        const rev = await bumpRev(tx, boardId, workspaceId);
        // The last key of every lane this chunk touches: ONE statement.
        const laneIds = [...new Set(fresh.map(card => meta.lanes[card.lane]!))];
        const lasts = await tx.$queryRaw<{lane_id: number; last: string}[]>`
          SELECT lane_id, max(position COLLATE "C") AS last FROM cards
          WHERE workspace_id = ${workspaceId} AND board_id = ${boardId} AND archived_at IS NULL AND lane_id IN (${Prisma.join(laneIds)})
          GROUP BY lane_id`;
        const lastOf = new Map<number, string>(lasts.map(r => [r.lane_id, r.last]));
        const keyOf = new Map<string, string>();
        for (const laneId of laneIds) {
          const inLane = fresh.filter(card => meta.lanes[card.lane] === laneId);
          keysAtEnd(lastOf.get(laneId) ?? null, inLane.length).forEach((key, i) => keyOf.set(inLane[i]!.ext, key));
        }
        const now = new Date();
        // One block of numbers for the chunk; a twin chunk's skipped rows leave harmless gaps.
        const firstNumber = await reserveCardNumbers(tx, boardId, workspaceId, fresh.length);
        const created = await tx.card.createManyAndReturn({
          data: fresh.map((card, i) => ({
            number: firstNumber + i,
            boardId,
            laneId: meta.lanes[card.lane]!,
            workspaceId,
            title: card.title,
            descriptionMd: card.desc,
            position: keyOf.get(card.ext)!,
            dueDate: card.due ? new Date(`${card.due}T00:00:00.000Z`) : null,
            completedAt: card.done ? now : null,
            checklistTotal: card.checklists.reduce((n, cl) => n + cl.items.length, 0),
            checklistDone: card.checklists.reduce((n, cl) => n + cl.items.filter(i => i.done).length, 0),
            commentCount: card.comments.length,
            attachmentCount: card.links.length,
            updatedRev: rev,
            importId: body.importId,
            externalId: card.ext,
            createdBy: userId,
          })),
          // A racing twin of this chunk inserts the same keys: the unique index skips them instead of failing.
          skipDuplicates: true,
          select: {id: true, externalId: true, laneId: true},
        });
        const byExt = new Map(fresh.map(card => [card.ext, card]));
        const made = created.flatMap(row => {
          const card = byExt.get(row.externalId ?? '');
          return card ? [{id: row.id, laneId: row.laneId, card}] : [];
        });

        // Per-lane counts, one statement; a lane that would pass the safety cap rolls the whole chunk back.
        const perLane = new Map<number, number>();
        for (const m of made) perLane.set(m.laneId, (perLane.get(m.laneId) ?? 0) + 1);
        if (perLane.size) {
          const bumped = await tx.$queryRaw<{id: number}[]>`
            UPDATE lanes l SET card_count = l.card_count + v.n, updated_rev = ${rev}
            FROM (VALUES ${Prisma.join([...perLane].map(([id, n]) => Prisma.sql`(${id}::int, ${n}::int)`))}) AS v(id, n)
            WHERE l.id = v.id AND l.board_id = ${boardId} AND l.workspace_id = ${workspaceId} AND l.card_count + v.n <= ${MAX_CARDS_PER_LANE}::int
            RETURNING l.id`;
          if (bumped.length !== perLane.size) throw new LaneFull();
        }

        const cardLabels = made.flatMap(m => m.card.labels.flatMap(ext => (meta.labels[ext] === undefined ? [] : [{cardId: m.id, labelId: meta.labels[ext]!}])));
        if (cardLabels.length) await tx.cardLabel.createMany({data: cardLabels, skipDuplicates: true});

        const checklistRows = made.flatMap(m => {
          const keys = keysAtEnd(null, m.card.checklists.length);
          return m.card.checklists.map((cl, i) => ({cardId: m.id, workspaceId, title: cl.name, position: keys[i]!, source: cl}));
        });
        if (checklistRows.length) {
          const rows = await tx.checklist.createManyAndReturn({
            data: checklistRows.map(({source: _s, ...row}) => row),
            select: {id: true, cardId: true, position: true},
          });
          const idOfList = new Map(rows.map(r => [`${r.cardId}:${r.position}`, r.id]));
          const items = checklistRows.flatMap(row => {
            const checklistId = idOfList.get(`${row.cardId}:${row.position}`);
            if (checklistId === undefined) return [];
            const keys = keysAtEnd(null, row.source.items.length);
            return row.source.items.map((it, i) => ({checklistId, workspaceId, text: it.text, position: keys[i]!, doneAt: it.done ? now : null}));
          });
          if (items.length) await tx.checklistItem.createMany({data: items});
        }

        const comments = made.flatMap(m =>
          m.card.comments.map(cm => ({
            cardId: m.id,
            workspaceId,
            // The importer owns the row; the text says who wrote it in Trello. Nobody is impersonated.
            authorId: userId,
            bodyMd: `Imported comment by ${cm.by}${cm.at ? ` on ${cm.at.slice(0, 10)}` : ''}:\n\n${cm.text}`.slice(0, 5000),
            ...(cm.at ? {createdAt: new Date(cm.at)} : {}),
          }))
        );
        if (comments.length) await tx.comment.createMany({data: comments});

        const links = made.flatMap(m => m.card.links.map(l => ({workspaceId, cardId: m.id, url: l.url, name: l.name, ready: true, uploadedBy: userId})));
        if (links.length) await tx.attachment.createMany({data: links});

        await tx.activity.createMany({
          data: made.map(m => ({workspaceId, boardId, cardId: m.id, actorId: userId, kind: 'card.created', meta: {title: m.card.title, imported: true}})),
        });
        return {created: made.length, skipped: body.cards.length - made.length, rev};
      });
    } catch (err) {
      if (err instanceof TooManyCards) return c.json(problem('import_too_large', 'This import holds more cards than it announced.'), 409);
      if (err instanceof LaneFull) return c.json(problem('lane_card_limit', `A lane holds up to ${MAX_CARDS_PER_LANE} cards.`), 409);
      if (err instanceof UnknownLane) return invalid(c, {cards: {code: 'invalid', message: 'A card names a lane that is not in this import.'}});
      throw err;
    }
    return c.json({created: result.created, skipped: result.skipped, rev: String(result.rev)});
  })

  /* ------------------------------------------------------------- export */
  .get('/boards/:id/export.json', withViewer, requireAuth, withDb, noStore, c => exportResponse(c, 'json'))
  .get('/boards/:id/export.csv', withViewer, requireAuth, withDb, noStore, c => exportResponse(c, 'csv'));
