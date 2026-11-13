import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';
import {generateKeyBetween} from 'fractional-indexing';

import {Prisma, type PrismaClient} from '../../generated/prisma/client';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {ALLOWED_FILE_TYPES} from '../../platform/files';
import {completeUpload, createUpload, deleteFile, fileUrl} from '../files';
import {getEntitlements, forgetEntitlements} from '../entitlements';
import {notify} from '../notifications';
import {addWatcher, notifyWatchers} from '../card-watch';
import {scheduleTimedReminder, scheduleItemReminder} from '../jobs/due-reminders';
import {FIELD_LIMITS, FIELD_ORDER, fieldCols, fieldShape, valueCols, valueMap} from '../field-shapes';
import {boardAccess, notFound, boardReachable} from '../workspaces';
import {isEmoji} from './chat';
import {HEX_RE, idOf, intField, invalid, likeEscape, objectOf, textField, type FieldError} from '../validation';

/**
 * Phase 2: everything inside a card. Mounted ONCE at `/` in `app.ts`.
 *
 *   GET    /cards/:id/detail                    the whole panel in one answer (SPEC §13: 4 round trips)
 *   PATCH  /cards/:id/details                   title, description, priority, estimate, start, due, done
 *   GET    /cards/:id/activity?before=          the card's history (keyset on id)
 *   GET    /cards/:id/people?q=                 who can be assigned or @mentioned (names only, 20)
 *   POST   /boards/:id/labels   PATCH|DELETE /labels/:id     board labels (any colour)
 *   PUT|DELETE /cards/:id/labels/:labelId       put a label on / take it off a card
 *   PUT|DELETE /cards/:id/members/:userId       assign / unassign
 *   PUT|DELETE /cards/:id/watch                 follow / stop following the card (your own; reading it is enough)
 *   POST   /cards/:id/checklists   PATCH|DELETE /checklists/:id   POST /checklists/:id/items
 *   PATCH|DELETE /checklist-items/:id           text, done, assigneeId, dueDate; counters follow in the same transaction
 *   GET|POST /cards/:id/comments   PATCH|DELETE /comments/:id
 *   POST   /cards/:id/attachments/link          a web link
 *   POST   /cards/:id/attachments/upload        step 1 of files.md (createUpload)
 *   POST   /attachments/:id/complete            step 3 (completeUpload, quota, counters)
 *   GET    /attachments/:id/view?download=1     access check, then a 5-minute link
 *   PATCH|DELETE /attachments/:id               rename / remove      PUT /cards/:id/cover
 *
 * Same rules as boards.ts: ids in URLs only SELECT; the visitor's workspace membership is IN the first query
 * (`cardCtx`), a card of another workspace answers 404; every write carries `workspace_id` and `board_id` in its
 * `where`, runs in ONE transaction that bumps `boards.rev`, stamps `cards.updated_rev`, moves the counters on the
 * card (checklist, comments, attachments) and writes an `activity` row. Output only through `select`.
 */

const TERMINAL_UPLOAD_CODES = new Set(['E_FILE_TYPE', 'E_FILE_EMPTY', 'E_FILE_TOO_LARGE', 'E_FILE_SIZE_MISMATCH', 'E_FILE_NOT_FOUND', 'E_UPLOAD_TOKEN', 'E_UPLOAD_EXPIRED', 'E_STORAGE_LIMIT']);
const LIMITS = {assignees: 50, labelsPerBoard: 50, checklistsPerCard: 20, itemsPerChecklist: 100, itemsPerRequest: 20, attachmentsPerCard: 50, mentions: 10, comments: 20, commentsPerMinute: 20, unfinishedUploads: 10};
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
/** Types the browser may show inline from a file link. Everything else (SVG, HTML, text, JSON...) is always a download. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf']);
/** Never accepted as an attachment: they run script when opened on a site origin. */
const BLOCKED_TYPES = new Set(['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/javascript', 'application/javascript', 'application/xml', 'text/xml']);
const IMAGE_COVER_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

export const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

/* ---------------------------------------------------------------- access */

type Refusal = {status: 403 | 404 | 409 | 429; body: ReturnType<typeof problem>};
const refuse = (status: Refusal['status'], error: string, message: string): Refusal => ({status, body: problem(error, message)});
export const refused = <T extends object>(r: Refusal | T): r is Refusal => 'status' in r;

/** 'remove' is a write that frees space (delete an attachment or your comment): allowed in a read-only workspace so it can heal. */
type Need = 'read' | 'write' | 'remove';

/**
 * The card and what the visitor may do with it, or the refusal. 404 for a card of a workspace they are not in
 * (or a private board without a seat); 403 for a viewer writing; 409 for an archived board / read-only workspace;
 * writes to an archived card answer 404 (restore it first).
 */
export async function cardCtx(db: PrismaClient, userId: number, cardId: number | undefined, need: Need) {
  if (!cardId) return refuse(404, 'not_found', 'No such card.');
  const card = await db.card.findFirst({
    where: {id: cardId, board: boardReachable(userId)},
    select: {id: true, boardId: true, laneId: true, workspaceId: true, archivedAt: true, board: {select: {inboxOf: true}}},
  });
  if (!card) return refuse(404, 'not_found', 'No such card.');
  const access = await boardAccess(db, card.boardId, userId);
  if (!access || access.workspaceId !== card.workspaceId) return refuse(404, 'not_found', 'No such card.');
  if (need !== 'read') {
    if (!access.canWrite) return refuse(403, 'forbidden', 'You do not have access to this.');
    if (access.archived) return refuse(409, 'board_archived', 'This board is archived.');
    if (card.archivedAt) return refuse(404, 'not_found', 'No such card.');
    if (need === 'write') {
      const ent = await getEntitlements(db, access.workspaceId);
      if (ent?.readOnly) return refuse(409, 'workspace_read_only', 'This workspace is read-only until its plan limits are fixed.');
    }
  }
  return {card, cardId: card.id, boardId: card.boardId, workspaceId: card.workspaceId, inboxOf: card.board.inboxOf, access};
}
export type Ctx = Exclude<Awaited<ReturnType<typeof cardCtx>>, Refusal>;

/** A child row (label, checklist, item, comment, attachment) is reached through its card: same membership rule. */
async function viaCard(db: PrismaClient, userId: number, cardId: number | undefined | null, workspaceId: number | undefined, need: Need) {
  const ctx = await cardCtx(db, userId, cardId ?? undefined, need);
  // A refusal from cardCtx is passed through as it is: 404 for someone with no access to the board
  // (hiding it), 403 for a viewer who CAN see the card but may not write (as boards.ts laneFor/cardFor do).
  // Only a child that belongs to another workspace is turned into 404.
  if (refused(ctx)) return ctx;
  if (ctx.workspaceId !== workspaceId) return refuse(404, 'not_found', 'Not found.');
  return ctx;
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** `boards.rev + 1`, row-locked (the same statement as boards.ts; taken FIRST in every transaction). */
export async function bumpRev(tx: Tx, boardId: number, workspaceId: number): Promise<bigint> {
  const rows = await tx.$queryRaw<{rev: bigint}[]>`
    UPDATE boards SET rev = rev + 1, updated_at = now()
    WHERE id = ${boardId} AND workspace_id = ${workspaceId} RETURNING rev`;
  if (!rows[0]) throw new Gone();
  return rows[0].rev;
}

/** Thrown inside a transaction when a row vanished meanwhile: rolls everything back, answers 404. */
export class Gone extends Error {}
/** Thrown inside a transaction to roll it back (the board rev bump too) and answer with a named refusal. */
class Abort extends Error {
  constructor(readonly why: 'stale' | 'dates' | 'time') {
    super(why);
  }
}
/** Thrown when the storage reservation fails at `complete`: rolls the ready flag back. */
class OutOfSpace extends Error {}

const cardCols = {
  id: true,
  number: true,
  laneId: true,
  title: true,
  position: true,
  priority: true,
  startDate: true,
  dueDate: true,
  createdAt: true,
  completedAt: true,
  checklistTotal: true,
  checklistDone: true,
  commentCount: true,
  attachmentCount: true,
  archivedAt: true,
  updatedRev: true,
} as const;
type CardRow = Prisma.CardGetPayload<{select: typeof cardCols}>;
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
/** Same wire shape as boards.ts `cardShape`, so the client patches the board cache with it. */
const summary = (r: CardRow) => ({
  id: r.id,
  number: r.number,
  laneId: r.laneId,
  title: r.title,
  position: r.position,
  priority: r.priority,
  startDate: dayOf(r.startDate),
  dueDate: dayOf(r.dueDate),
  createdAt: dayOf(r.createdAt),
  completed: r.completedAt !== null,
  checklistTotal: r.checklistTotal,
  checklistDone: r.checklistDone,
  commentCount: r.commentCount,
  attachmentCount: r.attachmentCount,
  archived: r.archivedAt !== null,
  rev: String(r.updatedRev),
});

/** Stamp the card (rev, counters), write the activity row, return the fresh summary. Call LAST in the transaction. */
export async function finish(
  tx: Tx,
  ctx: Ctx,
  userId: number,
  rev: bigint,
  kind: string,
  meta: Prisma.InputJsonValue | null,
  data: Prisma.CardUpdateManyMutationInput = {}
) {
  // ONE statement stamps the card and returns its fresh summary (no second read). A card archived or gone
  // meanwhile makes `update` throw P2025: that rolls the whole transaction back and answers 404.
  let card: CardRow;
  try {
    card = await tx.card.update({
      where: {id: ctx.cardId, boardId: ctx.boardId, workspaceId: ctx.workspaceId, archivedAt: null},
      data: {...data, updatedRev: rev},
      select: cardCols,
    });
  } catch (error) {
    if ((error as {code?: string}).code === 'P2025') throw new Gone();
    throw error;
  }
  await tx.activity.create({
    data: {workspaceId: ctx.workspaceId, boardId: ctx.boardId, cardId: ctx.cardId, actorId: userId, kind, ...(meta === null ? {} : {meta})},
  });
  return {card: summary(card), rev: String(rev)};
}

/** Runs a transaction; a vanished row is a 404, not a 500. */
export async function atomically<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T | null> {
  try {
    return await db.$transaction(fn);
  } catch (error) {
    if (error instanceof Gone) return null;
    if (error instanceof Abort) return error.why as T;
    throw error;
  }
}

/* ------------------------------------------------------------ validation */

export type Parsed<T> = {ok: true; value: T} | {ok: false; errors: Record<string, FieldError>};
export const body = <T>(parse: (v: Record<string, unknown>) => Parsed<T>) =>
  validator('json', (value, c) => {
    const result = parse(objectOf(value) ?? {});
    return result.ok ? result.value : invalid(c, result.errors);
  });

export const dateOnly = (v: unknown): {ok: true; value: Date | null} | {ok: false} => {
  if (v === null) return {ok: true, value: null};
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return {ok: false};
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? {ok: false} : {ok: true, value: d};
};

const HOUR = 3_600_000;
/** An ISO instant with its zone (`2026-11-06T06:42:00.000Z`), at whole minutes. */
const instantOf = (v: unknown): {ok: true; value: Date | null} | {ok: false} => {
  if (v === null) return {ok: true, value: null};
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return {ok: false};
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return {ok: false};
  d.setUTCSeconds(0, 0);
  return {ok: true, value: d};
};
/** The reminder choices of the dates popup, in minutes before the due time (the cards CHECK holds the same list). */
export const REMIND_MINUTES = [0, 5, 10, 15, 60, 120, 1440, 2880] as const;

export const errAt = (name: string, e: FieldError): Parsed<never> => ({ok: false, errors: {[name]: e}});
export const hexOf = (v: unknown) => (typeof v === 'string' && HEX_RE.test(v) ? v.toUpperCase() : null);
export const badHex: FieldError = {code: 'invalid_hex', message: 'Use a colour like #5B5BD6.'};

const detailsBody = body(v => {
  const errors: Record<string, FieldError> = {};
  const out: {
    title?: string;
    descriptionMd?: string;
    priority?: string;
    estimateMinutes?: number | null;
    startDate?: Date | null;
    dueDate?: Date | null;
    dueAt?: Date | null;
    dueRemindMinutes?: number | null;
    completed?: boolean;
    expectedRev?: bigint;
  } = {};
  if (v.expectedRev !== undefined && v.expectedRev !== null) {
    // The card's `rev` as the panel last saw it (a decimal string). A stale one answers 409 `stale`.
    if (typeof v.expectedRev === 'string' && /^\d{1,18}$/.test(v.expectedRev)) out.expectedRev = BigInt(v.expectedRev);
    else errors.expectedRev = {code: 'invalid', message: 'Reload the card and try again.'};
  }
  if (v.title !== undefined) {
    const t = textField(v.title, 1, 200);
    if (t.ok) out.title = t.value;
    else errors.title = t.error;
  }
  if (v.descriptionMd !== undefined) {
    if (typeof v.descriptionMd === 'string' && v.descriptionMd.length <= 20000) out.descriptionMd = v.descriptionMd;
    else errors.descriptionMd = {code: 'too_long', message: 'Use at most 20000 characters.'};
  }
  if (v.priority !== undefined) {
    if (typeof v.priority === 'string' && (PRIORITIES as readonly string[]).includes(v.priority)) out.priority = v.priority;
    else errors.priority = {code: 'invalid', message: 'Unknown priority.'};
  }
  if (v.estimateMinutes !== undefined) {
    if (v.estimateMinutes === null) out.estimateMinutes = null;
    else {
      const n = intField(v.estimateMinutes, 1, 99_999);
      if (n.ok) out.estimateMinutes = n.value;
      else errors.estimateMinutes = n.error;
    }
  }
  for (const name of ['startDate', 'dueDate'] as const) {
    if (v[name] === undefined) continue;
    const d = dateOnly(v[name]);
    if (d.ok) out[name] = d.value;
    else errors[name] = {code: 'invalid', message: 'Use a date like 2026-12-31.'};
  }
  if (v.dueAt !== undefined) {
    const at = instantOf(v.dueAt);
    if (at.ok) out.dueAt = at.value;
    else errors.dueAt = {code: 'invalid', message: 'Pick a time from the list.'};
  }
  if (v.dueRemindMinutes !== undefined) {
    if (v.dueRemindMinutes === null || (REMIND_MINUTES as readonly unknown[]).includes(v.dueRemindMinutes)) out.dueRemindMinutes = v.dueRemindMinutes as number | null;
    else errors.dueRemindMinutes = {code: 'invalid', message: 'Pick a reminder from the list.'};
  }
  if (v.completed !== undefined) {
    if (typeof v.completed === 'boolean') out.completed = v.completed;
    else errors.completed = {code: 'invalid', message: 'Use true or false.'};
  }
  if (Object.keys(errors).length) return {ok: false, errors};
  if (!Object.keys(out).filter(k => k !== 'expectedRev').length) return errAt('title', {code: 'required', message: 'Nothing to change.'});
  return {ok: true, value: out};
});

const labelBody = (partial: boolean) =>
  body(v => {
    const errors: Record<string, FieldError> = {};
    const out: {name?: string; colorHex?: string} = {};
    if (!partial || v.name !== undefined) {
      const name = textField(v.name ?? '', 0, 40);
      if (name.ok) out.name = name.value;
      else errors.name = name.error;
    }
    if (!partial || v.colorHex !== undefined) {
      const hex = hexOf(v.colorHex);
      if (hex) out.colorHex = hex;
      else errors.colorHex = badHex;
    }
    if (Object.keys(errors).length) return {ok: false, errors};
    if (!Object.keys(out).length) return errAt('name', {code: 'required', message: 'Nothing to change.'});
    return {ok: true, value: out};
  });

const titleBody = body(v => {
  const t = textField(v.title, 1, 100);
  return t.ok ? {ok: true, value: {title: t.value}} : errAt('title', t.error);
});

/** A user id from the body (`null` clears). The person is checked against the board's seats in the route, never trusted. */
const personId = (v: unknown): {ok: true; value: number | null} | {ok: false} => {
  if (v === null) return {ok: true, value: null};
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 2_147_483_647 ? {ok: true, value: v} : {ok: false};
};
const badAssignee: FieldError = {code: 'invalid', message: 'Choose a person from the list.'};
const badDue: FieldError = {code: 'invalid_date', message: 'Use a date like 2026-12-31.'};

const itemsBody = body(v => {
  const raw = Array.isArray(v.texts) ? v.texts : [v.text];
  if (raw.length < 1 || raw.length > LIMITS.itemsPerRequest) {
    return errAt('text', {code: 'out_of_range', message: `Add 1 to ${LIMITS.itemsPerRequest} items at a time.`});
  }
  const texts: string[] = [];
  for (const item of raw) {
    const t = textField(item, 1, 300);
    if (!t.ok) return errAt('text', t.error);
    texts.push(t.value);
  }
  // Optional: the same person, day, time and reminder for every item added in this request.
  const meta: {assigneeId?: number | null; dueDate?: Date | null; dueAt?: Date | null; dueRemindMinutes?: number | null} = {};
  if (v.assigneeId !== undefined) {
    const p = personId(v.assigneeId);
    if (!p.ok) return errAt('assigneeId', badAssignee);
    meta.assigneeId = p.value;
  }
  if (v.dueDate !== undefined) {
    const d = dateOnly(v.dueDate);
    if (!d.ok) return errAt('dueDate', badDue);
    meta.dueDate = d.value;
  }
  if (v.dueAt !== undefined) {
    const at = instantOf(v.dueAt);
    if (!at.ok) return errAt('dueAt', {code: 'invalid', message: 'Pick a time from the list.'});
    // A time needs its day, and must fall on that day in SOME time zone (UTC-12 to UTC+14), as the item's PATCH.
    const from = (meta.dueDate?.getTime() ?? NaN) - 14 * HOUR;
    if (at.value && (!meta.dueDate || at.value.getTime() < from || at.value.getTime() >= from + 50 * HOUR)) {
      return errAt('dueAt', {code: 'invalid', message: 'Pick a time on the due date.'});
    }
    meta.dueAt = at.value;
  }
  if (v.dueRemindMinutes !== undefined) {
    if (v.dueRemindMinutes !== null && !(REMIND_MINUTES as readonly unknown[]).includes(v.dueRemindMinutes)) {
      return errAt('dueRemindMinutes', {code: 'invalid', message: 'Pick a reminder from the list.'});
    }
    // A reminder only goes with a time (the PATCH stores none without one either).
    if (meta.dueAt) meta.dueRemindMinutes = v.dueRemindMinutes as number | null;
  }
  return {ok: true, value: {texts, ...meta}};
});

const itemPatchBody = body(v => {
  const out: {text?: string; done?: boolean; assigneeId?: number | null; dueDate?: Date | null; dueAt?: Date | null; dueRemindMinutes?: number | null} = {};
  if (v.dueAt !== undefined) {
    const at = instantOf(v.dueAt);
    if (!at.ok) return errAt('dueAt', {code: 'invalid', message: 'Pick a time from the list.'});
    out.dueAt = at.value;
  }
  if (v.dueRemindMinutes !== undefined) {
    if (v.dueRemindMinutes !== null && !(REMIND_MINUTES as readonly unknown[]).includes(v.dueRemindMinutes)) {
      return errAt('dueRemindMinutes', {code: 'invalid', message: 'Pick a reminder from the list.'});
    }
    out.dueRemindMinutes = v.dueRemindMinutes as number | null;
  }
  if (v.assigneeId !== undefined) {
    const p = personId(v.assigneeId);
    if (!p.ok) return errAt('assigneeId', badAssignee);
    out.assigneeId = p.value;
  }
  if (v.dueDate !== undefined) {
    const d = dateOnly(v.dueDate);
    if (!d.ok) return errAt('dueDate', badDue);
    out.dueDate = d.value;
  }
  if (v.text !== undefined) {
    const t = textField(v.text, 1, 300);
    if (!t.ok) return errAt('text', t.error);
    out.text = t.value;
  }
  if (v.done !== undefined) {
    if (typeof v.done !== 'boolean') return errAt('done', {code: 'invalid', message: 'Use true or false.'});
    out.done = v.done;
  }
  if (!Object.keys(out).length) return errAt('text', {code: 'required', message: 'Nothing to change.'});
  return {ok: true, value: out};
});

const mentionIds = (v: unknown): Parsed<number[]> => {
  if (v === undefined) return {ok: true, value: []};
  if (!Array.isArray(v) || v.length > LIMITS.mentions || !v.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0)) {
    return errAt('mentions', {code: 'invalid', message: `Mention up to ${LIMITS.mentions} people.`});
  }
  return {ok: true, value: [...new Set(v as number[])]};
};

const emojiBody = validator('json', (value, c) => {
  const v = objectOf(value);
  if (!isEmoji(v?.emoji)) return invalid(c, {emoji: {code: 'invalid', message: 'Choose an emoji.'}});
  return {emoji: v!.emoji as string};
});

const commentBody = body(v => {
  const text = textField(v.body, 1, 5000);
  if (!text.ok) return errAt('body', text.error);
  const mentions = mentionIds(v.mentions);
  if (!mentions.ok) return mentions;
  return {ok: true, value: {body: text.value, mentions: mentions.value}};
});

const linkBody = body(v => {
  const raw = typeof v.url === 'string' ? v.url.trim() : '';
  let url: URL | null = null;
  try {
    url = raw.length > 0 && raw.length <= 500 ? new URL(raw) : null;
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    return errAt('url', {code: 'invalid', message: 'Enter a web address starting with https://.'});
  }
  let name = '';
  if (v.name !== undefined && v.name !== null && v.name !== '') {
    const t = textField(v.name, 1, 200);
    if (!t.ok) return errAt('name', t.error);
    name = t.value;
  }
  return {ok: true, value: {url: url.toString().slice(0, 500), name: name || url.hostname.slice(0, 200)}};
});

const uploadBody = body(v => {
  const name = textField(v.name, 1, 200);
  if (!name.ok) return errAt('name', name.error);
  const type = typeof v.contentType === 'string' ? v.contentType.toLowerCase().slice(0, 127) : '';
  if (BLOCKED_TYPES.has(type) || !(ALLOWED_FILE_TYPES as readonly string[]).includes(type)) {
    return errAt('file', {code: 'E_FILE_TYPE', message: 'That kind of file cannot be attached. Pick an image, PDF or document.'});
  }
  const size = intField(v.size, 1, 100 * 1024 * 1024);
  if (!size.ok) return errAt('file', {code: 'E_FILE_TOO_LARGE', message: 'Pick a file from 1 byte up to 100 MB.'});
  return {ok: true, value: {name: name.value.replace(/[\\/"\u0000-\u001f\u007f]/g, '_'), contentType: type, size: size.value}};
});

const renameBody = body(v => {
  const t = textField(v.name, 1, 200);
  return t.ok ? {ok: true, value: {name: t.value.replace(/[\\/"\u0000-\u001f\u007f]/g, '_')}} : errAt('name', t.error);
});

const coverBody = body(v => {
  if (v.attachmentId === null) return {ok: true, value: {attachmentId: null as number | null}};
  const id = typeof v.attachmentId === 'number' && Number.isSafeInteger(v.attachmentId) && v.attachmentId > 0 ? v.attachmentId : null;
  return id ? {ok: true, value: {attachmentId: id as number | null}} : errAt('attachmentId', {code: 'invalid', message: 'Pick an image attachment.'});
});

const pageQuery = validator('query', value => ({
  before: typeof value.before === 'string' ? value.before : '',
  q: typeof value.q === 'string' ? value.q.trim().slice(0, 80) : '',
}));

/* --------------------------------------------------------------- helpers */

/** Names of users, ONE query. Names only: an email never leaves here. A missing user is "Deleted user" client-side. */
async function namesOf(db: PrismaClient, ids: Iterable<number | null>): Promise<Map<number, string>> {
  const wanted = [...new Set(ids)].filter((id): id is number => id !== null);
  if (wanted.length === 0) return new Map();
  const rows = await db.user.findMany({where: {id: {in: wanted}}, select: {id: true, name: true}, take: wanted.length});
  return new Map(rows.map(r => [r.id, r.name]));
}

/** Workspace members who may see this board (private boards: board members and workspace owners/admins). */
export const seatFilter = (board: {visibility: string; boardId: number; inboxOf: number | null}) =>
  // A personal Inbox is visible to its owner only (boardAccess), whatever the others' workspace role.
  board.inboxOf !== null
    ? Prisma.sql`AND m.user_id = ${board.inboxOf}`
    : board.visibility === 'private'
      ? Prisma.sql`AND (m.role IN ('owner', 'admin') OR EXISTS (SELECT 1 FROM board_members b WHERE b.board_id = ${board.boardId} AND b.user_id = m.user_id))`
      : Prisma.empty;
const seats = (ctx: Ctx) => seatFilter({visibility: ctx.access.visibility, boardId: ctx.boardId, inboxOf: ctx.inboxOf});

/** Of `ids`, the ones that are active members who can see the board: the only people a card may name. */
async function eligible(db: PrismaClient, ctx: Ctx, ids: number[], cap: number = LIMITS.mentions + 1): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<{id: number}[]>`
    SELECT u.id FROM workspace_members m JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${ctx.workspaceId} AND u.status = 'active' AND u.id IN (${Prisma.join(ids)}) ${seats(ctx)}
    LIMIT ${cap}`;
  return rows.map(r => r.id);
}

/** What a checklist item shows: its text, tick, and who/when (a name only, never an email). */
const itemCols = {id: true, text: true, doneAt: true, assigneeId: true, dueDate: true, dueAt: true, dueRemindMinutes: true} as const;
type ItemRow = Prisma.ChecklistItemGetPayload<{select: typeof itemCols}>;
const itemShape = (i: ItemRow, names: Map<number, string>) => ({
  id: i.id,
  text: i.text,
  done: i.doneAt !== null,
  assignee: i.assigneeId !== null ? {id: i.assigneeId, name: names.get(i.assigneeId) ?? ''} : null,
  dueDate: dayOf(i.dueDate),
  /** The due moment when a time was picked (ISO), and its reminder in minutes before; null = a due day only. */
  dueAt: i.dueAt ? i.dueAt.toISOString() : null,
  dueRemindMinutes: i.dueAt ? i.dueRemindMinutes : null,
});

const labelShape = (l: {id: number; name: string; colorHex: string}) => ({id: l.id, name: l.name, colorHex: l.colorHex});

const attachmentCols = {id: true, name: true, contentType: true, size: true, url: true, fileId: true, ready: true, uploadedBy: true, createdAt: true} as const;
type AttachmentRow = Prisma.AttachmentGetPayload<{select: typeof attachmentCols}>;
const attachmentShape = (a: AttachmentRow, names: Map<number, string>, coverFileId: string | null, me: number) => ({
  id: a.id,
  name: a.name,
  contentType: a.contentType,
  size: a.size,
  /** A link attachment has `url`; a file is shown through `/attachments/:id/view` (never a stored link). */
  url: a.url,
  isFile: a.fileId !== null,
  ready: a.ready,
  isImage: IMAGE_COVER_TYPES.has(a.contentType),
  isCover: a.fileId !== null && a.fileId === coverFileId,
  uploadedBy: a.uploadedBy === null ? null : (names.get(a.uploadedBy) ?? null),
  mine: a.uploadedBy === me,
  createdAt: a.createdAt.toISOString(),
});

const commentCols = {
  id: true,
  authorId: true,
  bodyMd: true,
  editedAt: true,
  createdAt: true,
  mentions: {select: {userId: true}, take: LIMITS.mentions},
} as const;
type CommentRow = Prisma.CommentGetPayload<{select: typeof commentCols}>;
type ReactionGroup = {emoji: string; count: number; mine: boolean};
/** Different emoji one comment may carry (the same cap as a chat message). */
const MAX_EMOJI_PER_COMMENT = 20;

/**
 * Reaction groups for a page of comments in ONE grouped query (bounded to these ids, 20 emoji each). The caller has
 * already proved the visitor reaches these comments' card: only counts and "mine" travel, never who reacted.
 */
async function commentReactions(db: PrismaClient, commentIds: number[], me: number): Promise<Map<number, ReactionGroup[]>> {
  const out = new Map<number, ReactionGroup[]>();
  const ids = commentIds.slice(0, 100);
  if (ids.length === 0) return out;
  const rows = await db.$queryRaw<{comment_id: number; emoji: string; n: number; mine: boolean}[]>`
    SELECT comment_id, emoji, count(*)::int AS n, bool_or(user_id = ${me}) AS mine
    FROM comment_reactions
    WHERE comment_id = ANY(${ids}::int[])
    GROUP BY comment_id, emoji
    ORDER BY comment_id ASC, min(created_at) ASC, emoji ASC
    LIMIT ${ids.length * MAX_EMOJI_PER_COMMENT}`;
  for (const r of rows) {
    const groups = out.get(r.comment_id) ?? [];
    groups.push({emoji: r.emoji, count: r.n, mine: r.mine});
    out.set(r.comment_id, groups);
  }
  return out;
}

const commentShape = (r: CommentRow, names: Map<number, string>, me: number, reactions: ReactionGroup[] = []) => ({
  id: r.id,
  authorId: r.authorId,
  authorName: r.authorId === null ? null : (names.get(r.authorId) ?? null),
  body: r.bodyMd,
  edited: r.editedAt !== null,
  createdAt: r.createdAt.toISOString(),
  mine: r.authorId === me,
  mentions: r.mentions.flatMap(m => (names.has(m.userId) ? [{id: m.userId, name: names.get(m.userId)!}] : [])),
  reactions,
});

export const send = (c: {json: (b: unknown, s: 404 | 403 | 409 | 429) => Response}, r: Refusal) => c.json(r.body, r.status);

/* ------------------------------------------------------------------ routes */

export const cardDetailRoutes = new Hono()
  .get('/cards/:id/detail', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return send(c, ctx);
    const {workspaceId, boardId, cardId} = ctx;
    // One parallel round trip for everything the panel shows; every read carries the workspace.
    const [card, cardLabels, boardLabels, members, checklists, attachments, comments, fields, fieldRows, watch] = await Promise.all([
      db.card.findFirst({
        where: {id: cardId, boardId, workspaceId},
        select: {
          ...cardCols,
          boardId: true,
          descriptionMd: true,
          estimateMinutes: true,
          startDate: true,
          dueAt: true,
          dueRemindMinutes: true,
          coverFileId: true,
          createdBy: true,
          createdAt: true,
        },
      }),
      db.cardLabel.findMany({where: {cardId}, select: {labelId: true}, take: LIMITS.labelsPerBoard}),
      db.label.findMany({where: {workspaceId, boardId}, orderBy: {id: 'asc'}, take: LIMITS.labelsPerBoard, select: {id: true, name: true, colorHex: true}}),
      db.cardMember.findMany({where: {cardId, workspaceId}, orderBy: {createdAt: 'asc'}, take: 50, select: {userId: true}}),
      db.checklist.findMany({
        where: {workspaceId, cardId},
        orderBy: [{position: 'asc'}, {id: 'asc'}],
        take: LIMITS.checklistsPerCard,
        select: {
          id: true,
          title: true,
          items: {orderBy: [{position: 'asc'}, {id: 'asc'}], take: LIMITS.itemsPerChecklist, select: itemCols},
        },
      }),
      db.attachment.findMany({where: {workspaceId, cardId, ready: true}, orderBy: {id: 'desc'}, take: LIMITS.attachmentsPerCard, select: attachmentCols}),
      db.comment.findMany({where: {workspaceId, cardId}, orderBy: {id: 'desc'}, take: LIMITS.comments + 1, select: commentCols}),
      db.customField.findMany({where: {workspaceId, boardId}, orderBy: [...FIELD_ORDER], take: FIELD_LIMITS.perBoard, select: fieldCols}),
      db.cardFieldValue.findMany({where: {cardId, workspaceId}, take: FIELD_LIMITS.perBoard, select: valueCols}),
      db.cardWatcher.findUnique({where: {cardId_userId: {cardId, userId}}, select: {userId: true}}),
    ]);
    if (!card) return notFound(c, 'card');
    const page = comments.slice(0, LIMITS.comments);
    const [names, reactions] = await Promise.all([
      namesOf(db, [
        ...members.map(m => m.userId),
        ...comments.flatMap(m => [m.authorId, ...m.mentions.map(x => x.userId)]),
        ...attachments.map(a => a.uploadedBy),
        ...checklists.flatMap(l => l.items.map(i => i.assigneeId)),
      ]),
      commentReactions(db, page.map(r => r.id), userId),
    ]);
    const cover = card.coverFileId ? attachments.find(a => a.fileId === card.coverFileId) : undefined;
    return c.json({
      card: {
        ...summary(card),
        boardId: card.boardId,
        descriptionMd: card.descriptionMd,
        estimateMinutes: card.estimateMinutes,
        startDate: dayOf(card.startDate),
        dueAt: card.dueAt?.toISOString() ?? null,
        dueRemindMinutes: card.dueRemindMinutes,
        coverAttachmentId: cover?.id ?? null,
        createdAt: card.createdAt.toISOString(),
      },
      me: userId,
      watching: watch !== null,
      canWrite: ctx.access.canWrite && !ctx.access.archived && card.archivedAt === null,
      canAdmin: ctx.access.canAdmin,
      labelIds: cardLabels.map(l => l.labelId),
      labels: boardLabels.map(labelShape),
      fields: fields.map(fieldShape),
      fieldValues: valueMap(fieldRows, fields),
      members: members.flatMap(m => (names.has(m.userId) ? [{id: m.userId, name: names.get(m.userId)!}] : [{id: m.userId, name: ''}])),
      checklists: checklists.map(l => ({id: l.id, title: l.title, items: l.items.map(i => itemShape(i, names))})),
      attachments: attachments.map(a => attachmentShape(a, names, card.coverFileId, userId)),
      comments: {items: page.map(r => commentShape(r, names, userId, reactions.get(r.id))), next: comments.length > LIMITS.comments ? page[page.length - 1]!.id : null},
    });
  })

  /* ---- the card's own fields ---- */
  .patch('/cards/:id/details', detailsBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    const input = c.req.valid('json');
    const {completed, expectedRev, ...fields} = input;
    const out = await atomically(c.var.db, async tx => {
      // The board row lock first (bumpRev), so the compare below and the write are one step.
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const now = await tx.card.findFirst({
        where: {id: ctx.cardId, boardId: ctx.boardId, workspaceId: ctx.workspaceId},
        select: {startDate: true, dueDate: true, dueAt: true, dueRemindMinutes: true, completedAt: true, updatedRev: true},
      });
      if (!now) throw new Gone();
      if (expectedRev !== undefined && now.updatedRev !== expectedRev) throw new Abort('stale');
      if (fields.startDate !== undefined || fields.dueDate !== undefined) {
        const start = fields.startDate === undefined ? now.startDate : fields.startDate;
        const due = fields.dueDate === undefined ? now.dueDate : fields.dueDate;
        if (start && due && start > due) throw new Abort('dates');
      }
      // A due time must fall on the due day in SOME time zone (UTC-12 to UTC+14) and needs a due day.
      const nextDue = fields.dueDate === undefined ? now.dueDate : fields.dueDate;
      if (fields.dueAt) {
        const from = (nextDue?.getTime() ?? NaN) - 14 * HOUR;
        if (!nextDue || fields.dueAt.getTime() < from || fields.dueAt.getTime() >= from + 50 * HOUR) throw new Abort('time');
      }
      const timeChanged =
        (fields.dueAt !== undefined && (fields.dueAt?.getTime() ?? null) !== (now.dueAt?.getTime() ?? null)) ||
        (fields.dueRemindMinutes !== undefined && fields.dueRemindMinutes !== now.dueRemindMinutes);
      // A new time or reminder may remind again (the day-before key of this card is forgotten).
      if (timeChanged) await tx.dueReminder.deleteMany({where: {cardId: ctx.cardId}});
      // The time and reminder as saved (the cards_due_time trigger drops both when the day changes without a time).
      const dayMoved = fields.dueDate !== undefined && (fields.dueDate?.getTime() ?? null) !== (now.dueDate?.getTime() ?? null);
      const savedAt = !nextDue ? null : fields.dueAt !== undefined ? fields.dueAt : dayMoved ? null : now.dueAt;
      const savedRemind = savedAt ? (fields.dueRemindMinutes !== undefined ? fields.dueRemindMinutes : now.dueRemindMinutes) : null;
      const done = await finish(tx, ctx, userId, rev, 'card.updated', {fields: Object.keys(fields).concat(completed === undefined ? [] : ['completed'])}, {
        ...fields,
        // Completing twice keeps the first time.
        ...(completed === undefined ? {} : {completedAt: completed ? (now.completedAt ?? new Date()) : null}),
      });
      return {
        ...done,
        dueChanged: fields.dueDate !== undefined && (fields.dueDate?.getTime() ?? null) !== (now.dueDate?.getTime() ?? null),
        justCompleted: completed === true && now.completedAt === null,
        timeChanged,
        savedAt,
        savedRemind,
      };
    });
    const verdict = out as unknown;
    if (verdict === 'stale') return c.json(problem('stale', 'That card changed while you were working. Reloading it.'), 409);
    if (verdict === 'dates') return invalid(c, {startDate: {code: 'invalid', message: 'The start date must not be after the due date.'}});
    if (verdict === 'time') return invalid(c, {dueAt: {code: 'invalid', message: 'Pick a time on the due date.'}});
    if (!out) return notFound(c, 'card');
    if (out.timeChanged) await scheduleTimedReminder(c.req.url, ctx.cardId, out.savedAt, out.savedRemind);
    // After the commit, never failing the request: the people who follow the card hear about it.
    const base = {workspaceId: ctx.workspaceId, boardId: ctx.boardId, cardId: ctx.cardId};
    if (out.justCompleted) await notifyWatchers(c.var.db, base, userId, 'card_done');
    else if (out.dueChanged) await notifyWatchers(c.var.db, base, userId, 'card_due');
    return c.json({card: out.card, rev: out.rev});
  })

  /* ---- follow a card: this person's own flag, so reading the card is enough (like a lane's watch) ---- */
  .put('/cards/:id/watch', withViewer, requireAuth, withDb, noStore, async c => {
    const ctx = await cardCtx(c.var.db, c.var.viewer.id!, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return send(c, ctx);
    await addWatcher(c.var.db, ctx.cardId, c.var.viewer.id!);
    return c.json({watching: true});
  })

  .delete('/cards/:id/watch', withViewer, requireAuth, withDb, noStore, async c => {
    const ctx = await cardCtx(c.var.db, c.var.viewer.id!, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return send(c, ctx);
    await c.var.db.cardWatcher.deleteMany({where: {cardId: ctx.cardId, userId: c.var.viewer.id!}});
    return c.json({watching: false});
  })

  .get('/cards/:id/activity', pageQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const ctx = await cardCtx(db, c.var.viewer.id!, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return send(c, ctx);
    const before = /^\d{1,18}$/.test(c.req.valid('query').before) ? BigInt(c.req.valid('query').before) : null;
    const rows = await db.activity.findMany({
      where: {workspaceId: ctx.workspaceId, cardId: ctx.cardId, ...(before === null ? {} : {id: {lt: before}})},
      orderBy: {id: 'desc'},
      take: 21,
      select: {id: true, kind: true, meta: true, actorId: true, createdAt: true},
    });
    const page = rows.slice(0, 20);
    const names = await namesOf(db, page.map(r => r.actorId));
    return c.json({
      items: page.map(r => ({id: String(r.id), kind: r.kind, meta: r.meta, actorName: r.actorId === null ? null : (names.get(r.actorId) ?? null), createdAt: r.createdAt.toISOString()})),
      next: rows.length > 20 ? String(page[page.length - 1]!.id) : null,
    });
  })

  /* ---- people: names only, at most 20, never an email ---- */
  .get('/cards/:id/people', pageQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const ctx = await cardCtx(db, c.var.viewer.id!, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return send(c, ctx);
    const q = c.req.valid('query').q;
    const like = `%${likeEscape(q)}%`;
    const rows = await db.$queryRaw<{id: number; name: string; assigned: boolean}[]>`
      SELECT u.id, u.name, (cm.user_id IS NOT NULL) AS assigned
      FROM workspace_members m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN card_members cm ON cm.card_id = ${ctx.cardId} AND cm.user_id = u.id
      WHERE m.workspace_id = ${ctx.workspaceId} AND u.status = 'active'
        AND (${q}::text = '' OR u.name ILIKE ${like}) ${seats(ctx)}
      ORDER BY u.name, u.id
      LIMIT 20`;
    return c.json({items: rows.map(r => ({id: r.id, name: r.name, assigned: r.assigned}))});
  })

  /* ---- labels (board level) ---- */
  .post('/boards/:id/labels', labelBody(false), withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    // A label belongs to a board: reach it through any live card is not possible, so resolve the board here.
    const boardId = idOf(c.req.param('id'));
    const access = boardId ? await boardAccess(c.var.db, boardId, userId) : null;
    if (!boardId || !access) return notFound(c, 'board');
    if (!access.canWrite) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    if (access.archived) return c.json(problem('board_archived', 'This board is archived.'), 409);
    const ent = await getEntitlements(c.var.db, access.workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
    const input = c.req.valid('json') as {name: string; colorHex: string};
    const out = await atomically(c.var.db, async tx => {
      const rev = await bumpRev(tx, boardId, access.workspaceId);
      if ((await tx.label.count({where: {workspaceId: access.workspaceId, boardId}})) >= LIMITS.labelsPerBoard) return 'limit' as const;
      const label = await tx.label.create({data: {workspaceId: access.workspaceId, boardId, name: input.name, colorHex: input.colorHex}, select: {id: true, name: true, colorHex: true}});
      await tx.activity.create({data: {workspaceId: access.workspaceId, boardId, actorId: userId, kind: 'label.created', meta: {labelId: label.id}}});
      return {label: labelShape(label), rev: String(rev)};
    });
    if (out === 'limit') return c.json(problem('limit_reached', `A board holds up to ${LIMITS.labelsPerBoard} labels.`), 409);
    return out ? c.json(out, 201) : notFound(c, 'board');
  })

  .patch('/labels/:id', labelBody(true), withViewer, requireAuth, withDb, noStore, async c => labelWrite(c, 'update'))
  .delete('/labels/:id', withViewer, requireAuth, withDb, noStore, async c => labelWrite(c, 'delete'))

  .put('/cards/:id/labels/:labelId', withViewer, requireAuth, withDb, noStore, async c => cardLabel(c, true))
  .delete('/cards/:id/labels/:labelId', withViewer, requireAuth, withDb, noStore, async c => cardLabel(c, false))

  /* ---- members ---- */
  .put('/cards/:id/members/:userId', withViewer, requireAuth, withDb, noStore, async c => assign(c, true))
  .delete('/cards/:id/members/:userId', withViewer, requireAuth, withDb, noStore, async c => assign(c, false))

  /* ---- checklists ---- */
  .post('/cards/:id/checklists', titleBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    const {title} = c.req.valid('json') as {title: string};
    const out = await atomically(c.var.db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const where = {workspaceId: ctx.workspaceId, cardId: ctx.cardId};
      if ((await tx.checklist.count({where})) >= LIMITS.checklistsPerCard) return 'limit' as const;
      const last = await tx.checklist.findFirst({where, orderBy: [{position: 'desc'}, {id: 'desc'}], select: {position: true}});
      const created = await tx.checklist.create({data: {...where, title, position: generateKeyBetween(last?.position ?? null, null)}, select: {id: true, title: true}});
      const done = await finish(tx, ctx, userId, rev, 'checklist.created', {checklistId: created.id, title});
      return {...done, checklist: {id: created.id, title: created.title, items: []}};
    });
    if (out === 'limit') return c.json(problem('limit_reached', `A card holds up to ${LIMITS.checklistsPerCard} checklists.`), 409);
    return out ? c.json(out, 201) : notFound(c, 'card');
  })

  .patch('/checklists/:id', titleBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const row = await c.var.db.checklist.findFirst({
      where: {id: idOf(c.req.param('id')) ?? 0, card: {board: boardReachable(userId)}},
      select: {id: true, cardId: true, workspaceId: true},
    });
    if (!row) return notFound(c, 'checklist');
    const ctx = await viaCard(c.var.db, userId, row.cardId, row.workspaceId, 'write');
    if (refused(ctx)) return send(c, ctx);
    const {title} = c.req.valid('json') as {title: string};
    const out = await atomically(c.var.db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const {count} = await tx.checklist.updateMany({where: {id: row.id, cardId: ctx.cardId, workspaceId: ctx.workspaceId}, data: {title}});
      if (!count) throw new Gone();
      return finish(tx, ctx, userId, rev, 'checklist.renamed', {checklistId: row.id});
    });
    return out ? c.json(out) : notFound(c, 'checklist');
  })

  .delete('/checklists/:id', withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const row = await c.var.db.checklist.findFirst({
      where: {id: idOf(c.req.param('id')) ?? 0, card: {board: boardReachable(userId)}},
      select: {id: true, cardId: true, workspaceId: true},
    });
    if (!row) return notFound(c, 'checklist');
    const ctx = await viaCard(c.var.db, userId, row.cardId, row.workspaceId, 'write');
    if (refused(ctx)) return send(c, ctx);
    const out = await atomically(c.var.db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const items = {checklistId: row.id, workspaceId: ctx.workspaceId};
      const [total, done] = await Promise.all([tx.checklistItem.count({where: items}), tx.checklistItem.count({where: {...items, doneAt: {not: null}}})]);
      const {count} = await tx.checklist.deleteMany({where: {id: row.id, cardId: ctx.cardId, workspaceId: ctx.workspaceId}});
      if (!count) throw new Gone();
      return finish(tx, ctx, userId, rev, 'checklist.deleted', {checklistId: row.id}, {checklistTotal: {decrement: total}, checklistDone: {decrement: done}});
    });
    return out ? c.json(out) : notFound(c, 'checklist');
  })

  .post('/checklists/:id/items', itemsBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const row = await c.var.db.checklist.findFirst({
      where: {id: idOf(c.req.param('id')) ?? 0, card: {board: boardReachable(userId)}},
      select: {id: true, cardId: true, workspaceId: true},
    });
    if (!row) return notFound(c, 'checklist');
    const ctx = await viaCard(c.var.db, userId, row.cardId, row.workspaceId, 'write');
    if (refused(ctx)) return send(c, ctx);
    const {texts, assigneeId, dueDate, dueAt, dueRemindMinutes} = c.req.valid('json') as {
      texts: string[];
      assigneeId?: number | null;
      dueDate?: Date | null;
      dueAt?: Date | null;
      dueRemindMinutes?: number | null;
    };
    // The person must be able to see the board (the same rule as assigning a card).
    if (assigneeId && (await eligible(c.var.db, ctx, [assigneeId])).length === 0) return notFound(c, 'person');
    const out = await atomically(c.var.db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const where = {checklistId: row.id, workspaceId: ctx.workspaceId};
      if ((await tx.checklistItem.count({where})) + texts.length > LIMITS.itemsPerChecklist) return 'limit' as const;
      const last = await tx.checklistItem.findFirst({where, orderBy: [{position: 'desc'}, {id: 'desc'}], select: {position: true}});
      let prev = last?.position ?? null;
      const rows = texts.map(text => ({
        ...where,
        text,
        position: (prev = generateKeyBetween(prev, null)),
        ...(assigneeId ? {assigneeId} : {}),
        ...(dueDate ? {dueDate} : {}),
        ...(dueDate && dueAt ? {dueAt, dueRemindMinutes: dueRemindMinutes ?? null} : {}),
      }));
      // One INSERT for all of them (never a query per item); ids come back in insertion order.
      const items = await tx.checklistItem.createManyAndReturn({data: rows, select: itemCols});
      const done = await finish(tx, ctx, userId, rev, 'checklist.item_added', {checklistId: row.id, count: texts.length}, {checklistTotal: {increment: texts.length}});
      return {...done, checklistId: row.id, items: items};
    });
    if (out === 'limit') return c.json(problem('limit_reached', `A checklist holds up to ${LIMITS.itemsPerChecklist} items.`), 409);
    if (!out) return notFound(c, 'checklist');
    const names = await namesOf(c.var.db, assigneeId ? [assigneeId] : []);
    if (assigneeId) await tellItemAssignee(c.var.db, ctx, userId, assigneeId);
    // One timed reminder job per new item (at most itemsPerRequest; the hourly run is the safety net for a failed send).
    if (dueAt && dueRemindMinutes != null) await Promise.all(out.items.map(i => scheduleItemReminder(c.req.url, i.id, i.dueAt, i.dueRemindMinutes)));
    return c.json({...out, items: out.items.map(i => itemShape(i, names))}, 201);
  })

  .patch('/checklist-items/:id', itemPatchBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const row = await itemRow(c.var.db, userId, c.req.param('id'));
    if (!row) return notFound(c, 'item');
    const ctx = await viaCard(c.var.db, userId, row.checklist.cardId, row.workspaceId, 'write');
    if (refused(ctx)) return send(c, ctx);
    const {text, done, assigneeId, dueDate, dueAt, dueRemindMinutes} = c.req.valid('json') as {
      text?: string;
      done?: boolean;
      assigneeId?: number | null;
      dueDate?: Date | null;
      dueAt?: Date | null;
      dueRemindMinutes?: number | null;
    };
    const timed = dueAt !== undefined || dueRemindMinutes !== undefined;
    // Naming someone needs the same eligibility as assigning a card; clearing needs none (they may have left).
    if (assigneeId && (await eligible(c.var.db, ctx, [assigneeId])).length === 0) return notFound(c, 'person');
    const out = await atomically(c.var.db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const where = {id: row.id, workspaceId: ctx.workspaceId};
      let delta = 0;
      let newAssignee: number | null = null;
      let reminder: {at: Date | null; minutes: number | null} | null = null;
      if (assigneeId !== undefined || timed) {
        const before = await tx.checklistItem.findFirst({where, select: {assigneeId: true, dueDate: true, dueAt: true, dueRemindMinutes: true}});
        if (!before) throw new Gone();
        if (assigneeId !== undefined && before.assigneeId !== assigneeId) newAssignee = assigneeId;
        if (timed) {
          // A due time must fall on the due day in SOME time zone (UTC-12 to UTC+14) and needs a due day (as cards).
          const nextDue = dueDate === undefined ? before.dueDate : dueDate;
          if (dueAt) {
            const from = (nextDue?.getTime() ?? NaN) - 14 * HOUR;
            if (!nextDue || dueAt.getTime() < from || dueAt.getTime() >= from + 50 * HOUR) throw new Abort('time');
          }
          const at = !nextDue ? null : dueAt !== undefined ? dueAt : before.dueAt;
          const minutes = at ? (dueRemindMinutes !== undefined ? dueRemindMinutes : before.dueRemindMinutes) : null;
          if ((at?.getTime() ?? null) !== (before.dueAt?.getTime() ?? null) || minutes !== before.dueRemindMinutes) reminder = {at, minutes};
        }
      }
      if (text !== undefined || assigneeId !== undefined || dueDate !== undefined || timed) {
        await tx.checklistItem.updateMany({
          where,
          data: {
            ...(text !== undefined ? {text} : {}),
            ...(assigneeId !== undefined ? {assigneeId} : {}),
            ...(dueDate !== undefined ? {dueDate} : {}),
            ...(dueAt !== undefined ? {dueAt} : {}),
            ...(dueRemindMinutes !== undefined ? {dueRemindMinutes} : {}),
          },
        });
      }
      if (done !== undefined) {
        // The conditional update tells how many rows really flipped, so a double click never double-counts.
        const flipped = await tx.checklistItem.updateMany({where: {...where, doneAt: done ? null : {not: null}}, data: {doneAt: done ? new Date() : null}});
        delta = flipped.count === 0 ? 0 : done ? 1 : -1;
      }
      const meta = {
        itemId: row.id,
        ...(done === undefined ? {} : {done}),
        ...(assigneeId === undefined ? {} : {assigneeId}),
        ...(dueDate === undefined ? {} : {dueDate: dayOf(dueDate)}),
        ...(dueAt === undefined ? {} : {dueAt: dueAt ? dueAt.toISOString() : null}),
      };
      const result = await finish(tx, ctx, userId, rev, 'checklist.item_updated', meta, delta === 0 ? {} : {checklistDone: {increment: delta}});
      return {...result, newAssignee, reminder};
    });
    if ((out as unknown) === 'time') return invalid(c, {dueAt: {code: 'invalid', message: 'Pick a time on the due date.'}});
    if (!out) return notFound(c, 'item');
    const {newAssignee, reminder, ...answer} = out;
    if (newAssignee !== null) await tellItemAssignee(c.var.db, ctx, userId, newAssignee);
    if (reminder) await scheduleItemReminder(c.req.url, row.id, reminder.at, reminder.minutes);
    return c.json(answer);
  })

  .delete('/checklist-items/:id', withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const row = await itemRow(c.var.db, userId, c.req.param('id'));
    if (!row) return notFound(c, 'item');
    const ctx = await viaCard(c.var.db, userId, row.checklist.cardId, row.workspaceId, 'write');
    if (refused(ctx)) return send(c, ctx);
    const out = await atomically(c.var.db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const current = await tx.checklistItem.findFirst({where: {id: row.id, workspaceId: ctx.workspaceId}, select: {doneAt: true}});
      if (!current) throw new Gone();
      await tx.checklistItem.deleteMany({where: {id: row.id, workspaceId: ctx.workspaceId}});
      return finish(tx, ctx, userId, rev, 'checklist.item_deleted', {itemId: row.id}, {
        checklistTotal: {decrement: 1},
        ...(current.doneAt ? {checklistDone: {decrement: 1}} : {}),
      });
    });
    return out ? c.json(out) : notFound(c, 'item');
  })

  /* ---- comments ---- */
  .get('/cards/:id/comments', pageQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'read');
    if (refused(ctx)) return send(c, ctx);
    const before = idOf(c.req.valid('query').before);
    const rows = await db.comment.findMany({
      where: {workspaceId: ctx.workspaceId, cardId: ctx.cardId, ...(before ? {id: {lt: before}} : {})},
      orderBy: {id: 'desc'},
      take: LIMITS.comments + 1,
      select: commentCols,
    });
    const page = rows.slice(0, LIMITS.comments);
    const [names, reactions] = await Promise.all([
      namesOf(db, page.flatMap(r => [r.authorId, ...r.mentions.map(m => m.userId)])),
      commentReactions(db, page.map(r => r.id), userId),
    ]);
    return c.json({items: page.map(r => commentShape(r, names, userId, reactions.get(r.id))), next: rows.length > LIMITS.comments ? page[page.length - 1]!.id : null});
  })

  .post('/cards/:id/comments', commentBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    const input = c.req.valid('json') as {body: string; mentions: number[]};
    // Rate limit on our own table (security.md A06): a bounded count on the (author_id, created_at) index.
    const recent = await db.comment.count({where: {authorId: userId, createdAt: {gte: new Date(Date.now() - 60_000)}}});
    if (recent >= LIMITS.commentsPerMinute) return c.json(problem('rate_limited', 'Too many comments. Wait a moment and try again.'), 429);
    const mentioned = (await eligible(db, ctx, input.mentions)).filter(id => id !== userId);
    const out = await atomically(db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const created = await tx.comment.create({
        data: {
          workspaceId: ctx.workspaceId,
          cardId: ctx.cardId,
          authorId: userId,
          bodyMd: input.body,
          mentions: {create: mentioned.map(id => ({userId: id}))},
        },
        select: commentCols,
      });
      // Whoever comments watches the card from then on.
      await tx.cardWatcher.createMany({data: [{cardId: ctx.cardId, userId}], skipDuplicates: true});
      const done = await finish(tx, ctx, userId, rev, 'comment.created', {commentId: created.id}, {commentCount: {increment: 1}});
      return {...done, created};
    });
    if (!out) return notFound(c, 'card');
    // After the commit, and never failing the request: who hears about it.
    const [members, watchers] = await Promise.all([
      db.cardMember.findMany({where: {cardId: ctx.cardId, workspaceId: ctx.workspaceId}, select: {userId: true}, take: 50}),
      db.cardWatcher.findMany({where: {cardId: ctx.cardId}, select: {userId: true}, orderBy: {userId: 'asc'}, take: 100}),
    ]);
    const base = {workspaceId: ctx.workspaceId, actorId: userId, boardId: ctx.boardId, cardId: ctx.cardId};
    const candidates = [...new Set([...members, ...watchers].map(m => m.userId))].filter(id => id !== userId && !mentioned.includes(id));
    // Board access is re-checked now: a member or watcher may have lost their seat since they joined the card.
    const others = await eligible(db, ctx, candidates, 150);
    await Promise.all([notify(db, mentioned, {...base, kind: 'mentioned'}), notify(db, others, {...base, kind: 'comment'})]);
    const names = await namesOf(db, [userId, ...mentioned]);
    return c.json({card: out.card, rev: out.rev, comment: commentShape(out.created, names, userId)}, 201);
  })

  .patch('/comments/:id', commentBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const row = await commentRow(db, userId, c.req.param('id'));
    if (!row) return notFound(c, 'comment');
    // Board access first: someone with no seat on a private board gets 404 (the comment's existence stays
    // hidden); only then "not your comment" is a 403.
    const ctx = await viaCard(db, userId, row.cardId, row.workspaceId, 'write');
    if (refused(ctx)) return send(c, ctx);
    if (row.authorId !== userId) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    const input = c.req.valid('json') as {body: string; mentions: number[]};
    const wanted = (await eligible(db, ctx, input.mentions)).filter(id => id !== userId);
    const out = await atomically(db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const had = await tx.commentMention.findMany({where: {commentId: row.id}, select: {userId: true}, take: LIMITS.mentions});
      const {count} = await tx.comment.updateMany({
        where: {id: row.id, cardId: ctx.cardId, workspaceId: ctx.workspaceId, authorId: userId},
        data: {bodyMd: input.body, editedAt: new Date()},
      });
      if (!count) throw new Gone();
      await tx.commentMention.deleteMany({where: {commentId: row.id}});
      await tx.commentMention.createMany({data: wanted.map(id => ({commentId: row.id, userId: id}))});
      const done = await finish(tx, ctx, userId, rev, 'comment.edited', {commentId: row.id});
      const comment = await tx.comment.findFirst({where: {id: row.id, workspaceId: ctx.workspaceId}, select: commentCols});
      return {...done, comment, fresh: wanted.filter(id => !had.some(h => h.userId === id))};
    });
    if (!out?.comment) return notFound(c, 'comment');
    await notify(db, out.fresh, {workspaceId: ctx.workspaceId, actorId: userId, boardId: ctx.boardId, cardId: ctx.cardId, kind: 'mentioned'});
    const [names, reactions] = await Promise.all([namesOf(db, [userId, ...wanted]), commentReactions(db, [row.id], userId)]);
    return c.json({card: out.card, rev: out.rev, comment: commentShape(out.comment, names, userId, reactions.get(row.id))});
  })

  .delete('/comments/:id', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const row = await commentRow(db, userId, c.req.param('id'));
    if (!row) return notFound(c, 'comment');
    const ctx = await viaCard(db, userId, row.cardId, row.workspaceId, 'remove');
    if (refused(ctx)) return send(c, ctx);
    // The author, or a board admin moderating.
    if (row.authorId !== userId && !ctx.access.canAdmin) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    const out = await atomically(db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const {count} = await tx.comment.deleteMany({where: {id: row.id, cardId: ctx.cardId, workspaceId: ctx.workspaceId}});
      if (!count) throw new Gone();
      return finish(tx, ctx, userId, rev, 'comment.deleted', {commentId: row.id}, {commentCount: {decrement: 1}});
    });
    return out ? c.json(out) : notFound(c, 'comment');
  })

  /* ---- comment reactions (👍 = "seen"): no activity row, no notification ---- */
  .put('/comments/:id/reactions', emojiBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const row = await commentRow(db, userId, c.req.param('id'));
    if (!row) return notFound(c, 'comment');
    // Board access first (404 for no seat on a private board), then the write rules (viewer 403, read-only 409).
    const ctx = await viaCard(db, userId, row.cardId, row.workspaceId, 'write');
    if (refused(ctx)) return send(c, ctx);
    const {emoji} = c.req.valid('json');
    const kinds = await db.commentReaction.findMany({where: {commentId: row.id}, select: {emoji: true}, distinct: ['emoji'], take: MAX_EMOJI_PER_COMMENT + 1});
    if (kinds.length >= MAX_EMOJI_PER_COMMENT && !kinds.some(k => k.emoji === emoji)) {
      return c.json(problem('limit_reached', 'That comment has enough different reactions.'), 409);
    }
    await db.commentReaction.createMany({data: [{commentId: row.id, userId, emoji}], skipDuplicates: true});
    return c.json({reactions: (await commentReactions(db, [row.id], userId)).get(row.id) ?? []});
  })

  .delete('/comments/:id/reactions', emojiBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const row = await commentRow(db, userId, c.req.param('id'));
    if (!row) return notFound(c, 'comment');
    // Taking your own reaction back frees space: allowed in a read-only workspace, like deleting your comment.
    const ctx = await viaCard(db, userId, row.cardId, row.workspaceId, 'remove');
    if (refused(ctx)) return send(c, ctx);
    await db.commentReaction.deleteMany({where: {commentId: row.id, userId, emoji: c.req.valid('json').emoji}});
    return c.json({reactions: (await commentReactions(db, [row.id], userId)).get(row.id) ?? []});
  })

  /* ---- attachments: links, then real files (docs/agent/files.md) ---- */
  .post('/cards/:id/attachments/link', linkBody, withViewer, requireAuth, withDb, noStore, async c => {
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(c.var.db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    const {url, name} = c.req.valid('json') as {url: string; name: string};
    const out = await atomically(c.var.db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      if ((await tx.attachment.count({where: {workspaceId: ctx.workspaceId, cardId: ctx.cardId, ready: true}})) >= LIMITS.attachmentsPerCard) return 'limit' as const;
      const row = await tx.attachment.create({
        data: {workspaceId: ctx.workspaceId, cardId: ctx.cardId, url, name, ready: true, uploadedBy: userId},
        select: attachmentCols,
      });
      const done = await finish(tx, ctx, userId, rev, 'attachment.added', {attachmentId: row.id, kind: 'link'}, {attachmentCount: {increment: 1}});
      return {...done, row};
    });
    if (out === 'limit') return c.json(problem('limit_reached', `A card holds up to ${LIMITS.attachmentsPerCard} attachments.`), 409);
    if (!out) return notFound(c, 'card');
    return c.json({card: out.card, rev: out.rev, attachment: attachmentShape(out.row, new Map([[userId, '']]), null, userId)}, 201);
  })

  // Step 1: checks (type, plan file size, space, caps), asks the platform for a one-time URL, records an unfinished row.
  .post('/cards/:id/attachments/upload', uploadBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    const input = c.req.valid('json') as {name: string; contentType: string; size: number};
    const ent = await getEntitlements(db, ctx.workspaceId);
    if (!ent) return notFound(c, 'workspace');
    if (input.size > ent.limits.maxFileBytes) {
      return c.json(problem('file_too_large', "That file is over your plan's file size limit."), 413);
    }
    if (ent.usage.storageUsedBytes + input.size > ent.limits.storageQuotaBytes) {
      return c.json(problem('storage_quota', "This workspace is out of file space. Remove files or upgrade the plan."), 402);
    }
    const [onCard, unfinished] = await Promise.all([
      db.attachment.count({where: {workspaceId: ctx.workspaceId, cardId: ctx.cardId, ready: true}}),
      db.attachment.count({where: {uploadedBy: userId, ready: false, fileId: {not: null}, createdAt: {gte: new Date(Date.now() - 3_600_000)}}}),
    ]);
    if (onCard >= LIMITS.attachmentsPerCard) return c.json(problem('limit_reached', `A card holds up to ${LIMITS.attachmentsPerCard} attachments.`), 409);
    if (unfinished >= LIMITS.unfinishedUploads) return c.json(problem('rate_limited', 'Too many uploads at once. Wait a moment and try again.'), 429);
    const grant = await createUpload(c.req.url, input); // private by default
    if (!grant.ok) {
      // E_STORAGE_NEEDS_PACK / E_STORAGE_OFF / E_STORAGE_LIMIT ...: the client shows a message for the owner.
      const status = grant.status === 402 ? 402 : grant.status >= 500 ? 503 : 400;
      return c.json(problem(grant.code, grant.message), status);
    }
    const row = await db.attachment.create({
      data: {
        workspaceId: ctx.workspaceId,
        cardId: ctx.cardId,
        fileId: grant.data.file.id,
        name: input.name,
        contentType: input.contentType,
        size: input.size,
        ready: false,
        uploadedBy: userId,
      },
      select: {id: true},
    });
    return c.json({attachmentId: row.id, upload: grant.data.upload}, 201);
  })

  // Step 3: the bytes are stored; confirm, reserve the space with one conditional UPDATE, bump counters.
  .post('/attachments/:id/complete', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const row = await attachmentRow(db, userId, c.req.param('id'));
    if (!row || row.uploadedBy !== userId || !row.fileId || row.cardId === null) return notFound(c, 'file');
    const ctx = await viaCard(db, userId, row.cardId, row.workspaceId, 'write');
    if (refused(ctx)) return send(c, ctx);
    if (row.ready) return c.json({ok: true});
    const done = await completeUpload(c.req.url, row.fileId);
    if (!done.ok) {
      // A refusal that can never succeed: drop the unfinished row now (its stored file goes through the
      // file_deletions outbox) instead of leaving it to pile up. "Not uploaded yet" can still be retried.
      if (TERMINAL_UPLOAD_CODES.has(done.code)) {
        await db.attachment.deleteMany({where: {id: row.id, workspaceId: ctx.workspaceId, ready: false}});
      }
      return c.json(problem(done.code, done.message), done.status === 402 ? 402 : 400);
    }
    const ent = await getEntitlements(db, ctx.workspaceId);
    const quota = ent?.limits.storageQuotaBytes ?? 0;
    try {
      const out = await atomically(db, async tx => {
        const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
        const flipped = await tx.attachment.updateMany({where: {id: row.id, workspaceId: ctx.workspaceId, cardId: ctx.cardId, ready: false}, data: {ready: true}});
        if (flipped.count === 0) return 'again' as const; // a second confirm: already counted
        const reserved = await tx.$executeRaw`
          UPDATE workspaces SET storage_used_bytes = storage_used_bytes + ${row.size}
          WHERE id = ${ctx.workspaceId} AND storage_used_bytes + ${row.size} <= ${quota}`;
        if (reserved === 0) throw new OutOfSpace();
        const fresh = await finish(tx, ctx, userId, rev, 'attachment.added', {attachmentId: row.id, kind: 'file'}, {attachmentCount: {increment: 1}});
        // Like Trello: the first image on a card becomes its cover (one conditional UPDATE, so two uploads never race).
        let coverAttachmentId: number | null = null;
        if (IMAGE_COVER_TYPES.has(row.contentType)) {
          const covered = await tx.card.updateMany({where: {id: ctx.cardId, workspaceId: ctx.workspaceId, coverFileId: null}, data: {coverFileId: row.fileId}});
          if (covered.count > 0) coverAttachmentId = row.id;
        }
        const saved = await tx.attachment.findFirst({where: {id: row.id, workspaceId: ctx.workspaceId}, select: attachmentCols});
        return {...fresh, saved, coverAttachmentId};
      });
      forgetEntitlements(db, ctx.workspaceId);
      if (out === 'again') return c.json({ok: true});
      if (!out?.saved) return notFound(c, 'file');
      return c.json({card: out.card, rev: out.rev, coverAttachmentId: out.coverAttachmentId, attachment: attachmentShape(out.saved, new Map([[userId, '']]), null, userId)});
    } catch (error) {
      if (!(error instanceof OutOfSpace)) throw error;
      await Promise.all([deleteFile(c.req.url, row.fileId), db.attachment.deleteMany({where: {id: row.id, workspaceId: ctx.workspaceId, ready: false}})]);
      return c.json(problem('storage_quota', 'This workspace is out of file space. Remove files or upgrade the plan.'), 402);
    }
  })

  // Show or download: access first, then a short link. Never a saved link.
  .get('/attachments/:id/view', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const row = await attachmentRow(db, userId, c.req.param('id'));
    if (!row || !row.fileId || !row.ready || row.cardId === null) return notFound(c, 'file');
    const ctx = await viaCard(db, userId, row.cardId, row.workspaceId, 'read');
    if (refused(ctx)) return send(c, ctx);
    const link = await fileUrl(c.req.url, row.fileId, {expiresIn: 300, download: c.req.query('download') === '1' || !INLINE_TYPES.has(row.contentType)});
    if (!link.ok) return c.json(problem(link.code, link.message), 400);
    return c.redirect(link.data.url, 302);
  })

  .patch('/attachments/:id', renameBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const row = await attachmentRow(db, userId, c.req.param('id'));
    if (!row || row.cardId === null) return notFound(c, 'file');
    const ctx = await viaCard(db, userId, row.cardId, row.workspaceId, 'write');
    if (refused(ctx)) return send(c, ctx);
    const {name} = c.req.valid('json') as {name: string};
    const out = await atomically(db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      const {count} = await tx.attachment.updateMany({where: {id: row.id, cardId: ctx.cardId, workspaceId: ctx.workspaceId}, data: {name}});
      if (!count) throw new Gone();
      return finish(tx, ctx, userId, rev, 'attachment.renamed', {attachmentId: row.id});
    });
    return out ? c.json({...out, name}) : notFound(c, 'file');
  })

  .delete('/attachments/:id', withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const row = await attachmentRow(db, userId, c.req.param('id'));
    if (!row || row.cardId === null) return notFound(c, 'file');
    const ctx = await viaCard(db, userId, row.cardId, row.workspaceId, 'remove');
    if (refused(ctx)) return send(c, ctx);
    // The uploader, or a board admin.
    if (row.uploadedBy !== userId && !ctx.access.canAdmin) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    const out = await atomically(db, async tx => {
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      // Re-read under the board lock: a concurrent "complete" may have flipped `ready` since the read above.
      const live = await tx.attachment.findFirst({where: {id: row.id, cardId: ctx.cardId, workspaceId: ctx.workspaceId}, select: {ready: true, size: true, fileId: true}});
      if (!live) throw new Gone();
      const {count} = await tx.attachment.deleteMany({where: {id: row.id, cardId: ctx.cardId, workspaceId: ctx.workspaceId}});
      if (!count) throw new Gone();
      if (live.ready && live.fileId) {
        // storage_used_bytes is given back by the attachments AFTER DELETE trigger (account deletion migration).
        // A removed file can no longer be the cover.
        await tx.card.updateMany({where: {id: ctx.cardId, workspaceId: ctx.workspaceId, coverFileId: live.fileId}, data: {coverFileId: null}});
      }
      return finish(tx, ctx, userId, rev, 'attachment.removed', {attachmentId: row.id}, live.ready ? {attachmentCount: {decrement: 1}} : {});
    });
    if (!out) return notFound(c, 'file');
    forgetEntitlements(db, ctx.workspaceId);
    if (row.fileId) {
      const gone = await deleteFile(c.req.url, row.fileId);
      if (!gone.ok) console.error(`card-detail: file ${row.fileId} not deleted: ${gone.code}`);
    }
    return c.json(out);
  })

  .put('/cards/:id/cover', coverBody, withViewer, requireAuth, withDb, noStore, async c => {
    const db = c.var.db;
    const userId = c.var.viewer.id!;
    const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'write');
    if (refused(ctx)) return send(c, ctx);
    const {attachmentId} = c.req.valid('json') as {attachmentId: number | null};
    const out = await atomically(db, async tx => {
      let fileId: string | null = null;
      if (attachmentId !== null) {
        const file = await tx.attachment.findFirst({
          where: {id: attachmentId, workspaceId: ctx.workspaceId, cardId: ctx.cardId, ready: true, fileId: {not: null}},
          select: {fileId: true, contentType: true},
        });
        if (!file || !IMAGE_COVER_TYPES.has(file.contentType)) return 'image' as const;
        fileId = file.fileId;
      }
      const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
      return finish(tx, ctx, userId, rev, 'card.cover', {attachmentId}, {coverFileId: fileId});
    });
    if (out === 'image') return invalid(c, {attachmentId: {code: 'invalid', message: 'Pick an image attachment.'}});
    return out ? c.json({...out, coverAttachmentId: attachmentId}) : notFound(c, 'card');
  });

/* ------------------------------------------------------- shared handlers */

type Req = {
  var: {db: PrismaClient; viewer: {id?: number | null}};
  req: {param: (name: string) => string};
  json: (body: unknown, status?: 201 | 403 | 404 | 409 | 422 | 429) => Response;
};

const itemRow = (db: PrismaClient, userId: number, raw: string) =>
  db.checklistItem.findFirst({
    where: {id: idOf(raw) ?? 0, checklist: {card: {board: boardReachable(userId)}}},
    select: {id: true, workspaceId: true, checklist: {select: {cardId: true}}},
  });

const commentRow = (db: PrismaClient, userId: number, raw: string) =>
  db.comment.findFirst({
    where: {id: idOf(raw) ?? 0, card: {board: boardReachable(userId)}},
    select: {id: true, cardId: true, workspaceId: true, authorId: true},
  });

const attachmentRow = (db: PrismaClient, userId: number, raw: string) =>
  db.attachment.findFirst({
    where: {id: idOf(raw) ?? 0, card: {board: boardReachable(userId)}},
    select: {id: true, cardId: true, workspaceId: true, fileId: true, size: true, ready: true, uploadedBy: true, contentType: true},
  });

/** Edit or delete a board label. The label only selects its board; board access decides. */
async function labelWrite(c: Req, action: 'update' | 'delete') {
  const db = c.var.db;
  const userId = c.var.viewer.id!;
  const label = await db.label.findFirst({
    where: {id: idOf(c.req.param('id')) ?? 0, board: boardReachable(userId)},
    select: {id: true, boardId: true, workspaceId: true},
  });
  const access = label ? await boardAccess(db, label.boardId, userId) : null;
  if (!label || !access || access.workspaceId !== label.workspaceId) return notFound(c, 'label');
  if (!access.canWrite) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
  if (access.archived) return c.json(problem('board_archived', 'This board is archived.'), 409);
  if (action === 'update') {
    const ent = await getEntitlements(db, access.workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
  }
  const input = action === 'update' ? ((c.req as unknown as {valid: (t: 'json') => unknown}).valid('json') as {name?: string; colorHex?: string}) : {};
  const out = await atomically(db, async tx => {
    const rev = await bumpRev(tx, label.boardId, label.workspaceId);
    const where = {id: label.id, boardId: label.boardId, workspaceId: label.workspaceId};
    // The cards that carry this label are re-stamped with the new rev: other open boards learn a renamed, recoloured or
    // deleted label through the delta, which only lists changed cards. Bounded just past the delta cap, so a label on
    // a huge number of cards ends in `truncated` (the client reloads) instead of a long write.
    await tx.$executeRaw`
      UPDATE cards SET updated_rev = ${rev}::bigint
      WHERE id IN (
        SELECT cl.card_id FROM card_labels cl JOIN cards k ON k.id = cl.card_id
        WHERE cl.label_id = ${label.id}::int AND k.board_id = ${label.boardId}::int AND k.workspace_id = ${label.workspaceId}::int
        LIMIT 400)`;
    if (action === 'update') await tx.label.updateMany({where, data: input});
    else await tx.label.deleteMany({where});
    await tx.activity.create({
      data: {workspaceId: label.workspaceId, boardId: label.boardId, actorId: userId, kind: action === 'update' ? 'label.updated' : 'label.deleted', meta: {labelId: label.id}},
    });
    const fresh = action === 'update' ? await tx.label.findFirst({where, select: {id: true, name: true, colorHex: true}}) : null;
    return {rev: String(rev), label: fresh ? labelShape(fresh) : null};
  });
  return out ? c.json(out) : notFound(c, 'label');
}

/** Put a board label on a card, or take it off. The label must belong to THIS card's board and workspace. */
async function cardLabel(c: Req, on: boolean) {
  const db = c.var.db;
  const userId = c.var.viewer.id!;
  const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'write');
  if (refused(ctx)) return c.json(ctx.body, ctx.status);
  const labelId = idOf(c.req.param('labelId'));
  const label = labelId ? await db.label.findFirst({where: {id: labelId, boardId: ctx.boardId, workspaceId: ctx.workspaceId}, select: {id: true, name: true}}) : null;
  if (!label) return notFound(c, 'label');
  const out = await atomically(db, async tx => {
    const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
    if (on) await tx.cardLabel.createMany({data: [{cardId: ctx.cardId, labelId: label.id}], skipDuplicates: true});
    else await tx.cardLabel.deleteMany({where: {cardId: ctx.cardId, labelId: label.id}});
    return finish(tx, ctx, userId, rev, on ? 'card.label_added' : 'card.label_removed', {labelId: label.id, name: label.name});
  });
  return out ? c.json(out) : notFound(c, 'card');
}

/** Assign or unassign a person. Only active workspace members who can see the board can be assigned. */
/** After the commit: the person given a checklist item hears about it (never the actor) and follows the card. */
async function tellItemAssignee(db: PrismaClient, ctx: Ctx, actorId: number, assignee: number) {
  await notify(db, [assignee], {workspaceId: ctx.workspaceId, actorId, boardId: ctx.boardId, cardId: ctx.cardId, kind: 'assigned'});
  await addWatcher(db, ctx.cardId, assignee);
}

async function assign(c: Req, on: boolean) {
  const db = c.var.db;
  const userId = c.var.viewer.id!;
  const ctx = await cardCtx(db, userId, idOf(c.req.param('id')), 'write');
  if (refused(ctx)) return c.json(ctx.body, ctx.status);
  const target = idOf(c.req.param('userId'));
  if (!target) return notFound(c, 'person');
  // Taking someone off needs no eligibility check (they may have left meanwhile); adding does.
  if (on && (await eligible(db, ctx, [target])).length === 0) return notFound(c, 'person');
  const out = await atomically(db, async tx => {
    const rev = await bumpRev(tx, ctx.boardId, ctx.workspaceId);
    if (on) {
      const has = await tx.cardMember.findMany({where: {cardId: ctx.cardId, workspaceId: ctx.workspaceId}, select: {userId: true}, take: LIMITS.assignees});
      if (!has.some(m => m.userId === target) && has.length >= LIMITS.assignees) return 'limit' as const;
    }
    if (on) await tx.cardMember.createMany({data: [{cardId: ctx.cardId, userId: target, workspaceId: ctx.workspaceId}], skipDuplicates: true});
    else await tx.cardMember.deleteMany({where: {cardId: ctx.cardId, userId: target, workspaceId: ctx.workspaceId}});
    return finish(tx, ctx, userId, rev, on ? 'card.member_added' : 'card.member_removed', {userId: target});
  });
  if ((out as unknown) === 'limit') return c.json(problem('limit_reached', `A card holds up to ${LIMITS.assignees} assignees.`), 409);
  if (!out) return notFound(c, 'card');
  if (on) {
    await notify(db, [target], {workspaceId: ctx.workspaceId, actorId: userId, boardId: ctx.boardId, cardId: ctx.cardId, kind: 'assigned'});
    // Whoever is assigned follows the card from then on; the others who follow hear who was added.
    await addWatcher(db, ctx.cardId, target);
    await notifyWatchers(db, {workspaceId: ctx.workspaceId, boardId: ctx.boardId, cardId: ctx.cardId}, userId, 'card_member', [target]);
  }
  return c.json(out);
}
