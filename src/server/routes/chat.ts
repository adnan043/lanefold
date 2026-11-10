import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {audit} from '../../platform/auth/audit';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {distinctCardNumbers, MAX_REFS_PER_PAGE} from '../../lib/card-number-refs';
import {mentionsAll} from '../../lib/mention-all';
import {getEntitlements} from '../entitlements';
import {notify} from '../notifications';
import {boardAccess, notFound, rankOf, requireWorkspaceRole, type WorkspaceRole} from '../workspaces';
import {idOf, invalid, objectOf, textField, type FieldError} from '../validation';

/**
 * Phase 4b: chat. Mounted ONCE at `/` in `app.ts`. Real time is polling (SPEC §8): `pulse` says which
 * conversations moved, `messages?after=<seq>` fetches only what is new.
 *
 *   GET  /chat/pulse                           my conversations: last_seq, last_read_seq, unread (one query)
 *   GET  /workspaces/:id/conversations         channels + my DMs, groups and board chats
 *   POST /workspaces/:id/conversations         new channel / group, or open a DM (idempotent)
 *   GET  /boards/:id/conversation              the board's chat (created on first use), I join it
 *   GET  /conversations/:id/messages           ?before=<seq> (older) | ?after=<seq> (poll) | ?parent=<id> (a thread)
 *   POST /conversations/:id/messages           send (client_id makes a retry idempotent; rate limited)
 *   POST /conversations/:id/read               move my read marker {seq}
 *   PUT|DELETE /conversations/:id/mute         mute / unmute for me
 *   PATCH|DELETE /messages/:id                 edit / soft-delete (own; moderators may delete)
 *   PUT|DELETE /messages/:id/reactions         {emoji}
 *   PUT|DELETE /messages/:id/pin               pin (moderators, or any participant of a DM / group)
 *
 * Access (`conversationAccess`): the workspace membership is IN the query, so a conversation of another
 * workspace is a 404 exactly like a missing one. Channels: every workspace member reads, member and up
 * write. Board chats follow `boardAccess` (viewers read only). DMs and groups: only their members.
 * Every write carries `conversation_id` AND `workspace_id` in its `where`. Never returns emails: people
 * are `{id, name}`.
 */

const PAGE = 50;
const MAX_BODY = 4000;
const MAX_MENTIONS = 20;
const MAX_CARD_REFS = 10;
const MAX_GROUP = 40;
const MAX_CHANNELS = 50;
/** Groups and DMs one person may start in one workspace per hour. */
const CONVERSATIONS_PER_HOUR = 30;
const LIST_CAP = 100;
const PULSE_CAP = 200;
const MAX_EMOJI_PER_MESSAGE = 20;
/** Sending: at most this many messages per user per minute / hour (bounded read of messages(sender_id, created_at)). */
const SEND_PER_MINUTE = 20;
const SEND_PER_HOUR = 300;

const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

/* ------------------------------------------------------------- pure helpers */

/** Strips control characters (keeps newline and tab), normalizes line ends and trims. The text is Markdown, escaped on render. */
export function cleanBody(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‎‏‪-‮⁦-⁩]/g, '')
    .trim();
}

const EMOJI_RE = /^(?:\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}‍️])+$/u;
const HAS_PICTOGRAPH = /\p{Extended_Pictographic}/u;
/** At least one visible pictograph: a string of only joiners / variation selectors / skin-tone modifiers is an invisible reaction. */
export const isEmoji = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 16 && EMOJI_RE.test(v) && HAS_PICTOGRAPH.test(v);

/** Unread math: messages after my read marker, never negative. */
export const unreadOf = (lastSeq: bigint | number, lastReadSeq: bigint | number): number => {
  const n = Number(lastSeq) - Number(lastReadSeq);
  return n > 0 ? n : 0;
};

/** The DM key for a pair of users: `<smaller>:<larger>`. */
export const dmKeyOf = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

const messageIdOf = (value: unknown): bigint | undefined => {
  if (typeof value !== 'string' || !/^\d{1,18}$/.test(value)) return undefined;
  const n = BigInt(value);
  return n > 0n ? n : undefined;
};

const seqOf = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
};

const isUnique = (error: unknown) => (error as {code?: unknown} | null)?.code === 'P2002';

/* ------------------------------------------------------------------ access */

type Access = {
  conversationId: number;
  workspaceId: number;
  kind: string;
  boardId: number | null;
  lastSeq: number;
  workspaceRole: WorkspaceRole;
  canRead: true;
  /** May send, react and edit own messages. */
  canWrite: boolean;
  /** May delete anyone's message and pin (admins of the workspace or the board). */
  canModerate: boolean;
  /** A board chat of an archived board: nothing is written there. */
  archived: boolean;
  /** Has a `conversation_members` row (channels and board chats: created on first read or send). */
  joined: boolean;
  lastReadSeq: number;
  muted: boolean;
};

/**
 * What the visitor may do in one conversation (ONE query, plus `boardAccess` for a board chat), or null:
 * missing, another workspace, a DM or group they are not in, a board they cannot see.
 */
export async function conversationAccess(db: PrismaClient, conversationId: number, userId: number): Promise<Access | null> {
  const conv = await db.conversation.findFirst({
    where: {id: conversationId},
    select: {
      id: true,
      workspaceId: true,
      kind: true,
      boardId: true,
      lastSeq: true,
      members: {where: {userId}, select: {lastReadSeq: true, mutedAt: true}, take: 1},
    },
  });
  if (!conv) return null;
  // The workspace membership gates everything below: another workspace's conversation is "missing".
  const member = await db.workspaceMember.findFirst({
    where: {workspaceId: conv.workspaceId, userId, workspace: {archivedAt: null}},
    select: {role: true},
  });
  const role = member?.role as WorkspaceRole | undefined;
  if (!role) return null;
  const rank = rankOf(role);
  const mine = conv.members[0];
  const base = {
    conversationId: conv.id,
    workspaceId: conv.workspaceId,
    kind: conv.kind,
    boardId: conv.boardId,
    lastSeq: Number(conv.lastSeq),
    workspaceRole: role,
    canRead: true as const,
    archived: false,
    joined: Boolean(mine),
    lastReadSeq: mine ? Number(mine.lastReadSeq) : 0,
    muted: Boolean(mine?.mutedAt),
  };
  if (conv.kind === 'channel') return {...base, canWrite: rank >= 2, canModerate: rank >= 3};
  if (conv.kind === 'dm' || conv.kind === 'group') {
    if (!mine) return null;
    return {...base, canWrite: true, canModerate: false};
  }
  if (conv.kind === 'board' && conv.boardId) {
    const access = await boardAccess(db, conv.boardId, userId);
    if (!access || access.workspaceId !== conv.workspaceId) return null;
    return {...base, archived: access.archived, canWrite: access.canWrite && !access.archived, canModerate: access.canAdmin && !access.archived};
  }
  return null;
}

type ChatVars = {viewer: {id: number | null}; db: PrismaClient; access: Access};

/** Route guard: the `:id` conversation must be reachable (else 404); `write` / `moderate` raise it to 403. */
const requireConversation = (need: 'read' | 'write' | 'moderate' = 'read') =>
  createMiddleware<{Variables: ChatVars}>(async (c, next) => {
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c, 'conversation');
    const access = await conversationAccess(c.var.db, id, c.var.viewer.id!);
    if (!access) return notFound(c, 'conversation');
    if ((need === 'write' && !access.canWrite) || (need === 'moderate' && !access.canModerate)) {
      return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    }
    if (need === 'write') {
      const blocked = await readOnlyBlock(c, c.var.db, access.workspaceId);
      if (blocked) return blocked;
    }
    c.set('access', access);
    await next();
  });

/** The 409 of a read-only workspace (plan limits), or null when writing is allowed. */
async function readOnlyBlock(c: {json: (b: unknown, s: 409) => Response}, db: PrismaClient, workspaceId: number): Promise<Response | null> {
  const ent = await getEntitlements(db, workspaceId);
  return ent?.readOnly ? c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409) : null;
}

/* ------------------------------------------------------------------ shapes */

type Person = {id: number; name: string};

/** Names only, one query. A deleted account shows as null (the client says "Deleted user"). */
async function namesOf(db: PrismaClient, ids: Iterable<number | null>): Promise<Map<number, string>> {
  const unique = [...new Set(ids)].filter((id): id is number => id !== null).slice(0, 400);
  if (unique.length === 0) return new Map();
  const rows = await db.user.findMany({where: {id: {in: unique}}, select: {id: true, name: true}, take: 400});
  return new Map(rows.map(r => [r.id, r.name]));
}

const messageCols = {
  id: true,
  seq: true,
  senderId: true,
  bodyMd: true,
  parentId: true,
  kind: true,
  editedAt: true,
  deletedAt: true,
  pinnedAt: true,
  replyCount: true,
  createdAt: true,
  mentions: {select: {userId: true}, take: MAX_MENTIONS},
  cardRefs: {select: {cardId: true}, take: MAX_CARD_REFS},
} as const;

type MessageRow = {
  id: bigint;
  seq: bigint;
  senderId: number | null;
  bodyMd: string;
  parentId: bigint | null;
  kind: string;
  editedAt: Date | null;
  deletedAt: Date | null;
  pinnedAt: Date | null;
  replyCount: number;
  createdAt: Date;
  mentions: {userId: number}[];
  cardRefs: {cardId: number}[];
};

type ReactionGroup = {emoji: string; count: number; mine: boolean};

/** A `#42` in a board chat that resolved to a card the reader may open (id and title only; the title is plain text). */
type NumberRef = {id: number; boardId: number; title: string};
type NumberRefs = Map<number, NumberRef>;

function messageShape(r: MessageRow, names: Map<number, string>, reactions: ReactionGroup[], conversationId: number, refs?: NumberRefs) {
  const deleted = r.deletedAt !== null;
  // Only the numbers THIS message names, and only the ones that resolved: nothing else about a card travels.
  const numberRefs: Record<number, NumberRef> = {};
  if (refs && refs.size > 0 && !deleted) {
    for (const n of distinctCardNumbers(r.bodyMd)) {
      const hit = refs.get(n);
      if (hit) numberRefs[n] = hit;
    }
  }
  return {
    id: String(r.id),
    conversationId,
    seq: Number(r.seq),
    sender: {id: r.senderId, name: r.senderId === null ? null : (names.get(r.senderId) ?? null)} as {id: number | null; name: string | null},
    kind: r.kind,
    // A deleted message keeps its place but never its text.
    body: deleted ? '' : r.bodyMd,
    parentId: r.parentId === null ? null : String(r.parentId),
    replyCount: r.replyCount,
    edited: r.editedAt !== null,
    deleted,
    pinned: r.pinnedAt !== null,
    mentions: deleted ? [] : r.mentions.map(m => m.userId),
    cardIds: deleted ? [] : r.cardRefs.map(x => x.cardId),
    numberRefs,
    reactions: deleted ? [] : reactions,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Reaction groups for many messages in ONE grouped query (bounded to these messages; 20 emoji each at most). */
async function reactionsFor(db: PrismaClient, messageIds: bigint[], me: number): Promise<Map<string, ReactionGroup[]>> {
  const out = new Map<string, ReactionGroup[]>();
  if (messageIds.length === 0) return out;
  const ids = messageIds.slice(0, 200).map(String);
  const rows = await db.$queryRaw<{message_id: bigint; emoji: string; n: number; mine: boolean}[]>`
    SELECT message_id, emoji, count(*)::int AS n, bool_or(user_id = ${me}) AS mine
    FROM message_reactions
    WHERE message_id = ANY(${ids}::text[]::bigint[])
    GROUP BY message_id, emoji
    ORDER BY message_id ASC, min(created_at) ASC, emoji ASC
    LIMIT ${ids.length * MAX_EMOJI_PER_MESSAGE}`;
  for (const r of rows) {
    const key = String(r.message_id);
    const groups = out.get(key) ?? [];
    groups.push({emoji: r.emoji, count: r.n, mine: r.mine});
    out.set(key, groups);
  }
  return out;
}

/**
 * `#42` in a BOARD chat: the cards of that board with those numbers that the reader may open. At most ONE query per
 * page (none when no message has a `#`), the numbers are distinct, capped, and looked up on the unique
 * (board_id, number) index. Not a board chat (channel, DM, group): no meaning, no query. An archived card, an
 * unknown number and a card the reader may not see all look the same (absent), so a number is no oracle.
 */
export async function cardNumberRefs(db: PrismaClient, a: Pick<Access, 'kind' | 'boardId' | 'workspaceId' | 'workspaceRole'>, me: number, rows: MessageRow[]): Promise<NumberRefs> {
  const out: NumberRefs = new Map();
  if (a.kind !== 'board' || !a.boardId) return out;
  const wanted = new Set<number>();
  for (const r of rows) {
    if (r.deletedAt !== null || !r.bodyMd.includes('#')) continue;
    for (const n of distinctCardNumbers(r.bodyMd)) wanted.add(n);
    if (wanted.size >= MAX_REFS_PER_PAGE) break;
  }
  if (wanted.size === 0) return out;
  const found = await db.card.findMany({
    where: {
      boardId: a.boardId,
      workspaceId: a.workspaceId,
      archivedAt: null,
      number: {in: [...wanted].slice(0, MAX_REFS_PER_PAGE)},
      board: linkableBoardWhere(me, a.workspaceRole),
    },
    select: {id: true, number: true, title: true, boardId: true},
    take: MAX_REFS_PER_PAGE,
  });
  for (const card of found) if (card.number !== null) out.set(card.number, {id: card.id, boardId: card.boardId, title: card.title});
  return out;
}

async function shapeMessages(db: PrismaClient, rows: MessageRow[], a: Access, me: number) {
  const conversationId = a.conversationId;
  const [names, reactions, refs] = await Promise.all([
    namesOf(db, [...rows.map(r => r.senderId), ...rows.flatMap(r => r.mentions.map(m => m.userId))]),
    reactionsFor(db, rows.map(r => r.id), me),
    cardNumberRefs(db, a, me, rows),
  ]);
  return {
    items: rows.map(r => messageShape(r, names, reactions.get(String(r.id)) ?? [], conversationId, refs)),
    names,
  };
}

/* --------------------------------------------------------------- validation */

const listQuery = validator('query', value => ({
  before: typeof value.before === 'string' ? value.before : '',
  after: typeof value.after === 'string' ? value.after : '',
  parent: typeof value.parent === 'string' ? value.parent : '',
  limit: typeof value.limit === 'string' ? value.limit : '',
}));

type NewMessage = {body: string; clientId: string; parentId: bigint | null; mentions: number[]; cardIds: number[]; lastSeenSeq: number | null};

const idList = (value: unknown, max: number): number[] | null => {
  if (value === undefined) return [];
  return strictIdList(value, max);
};

/** Absent stays `undefined` (leave as is); present is validated. `null` = invalid. */
const optionalIdList = (value: unknown, max: number): number[] | null | undefined => (value === undefined ? undefined : strictIdList(value, max));

const strictIdList = (value: unknown, max: number): number[] | null => {
  if (!Array.isArray(value) || value.length > max) return null;
  const out = new Set<number>();
  for (const v of value) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0 || v > 2_147_483_647) return null;
    out.add(v);
  }
  return [...out];
};

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

const bodyField = (value: unknown): {ok: true; value: string} | {ok: false; error: FieldError} => {
  if (typeof value !== 'string') return {ok: false, error: {code: 'required', message: 'Write a message.'}};
  const text = textField(cleanBody(value.slice(0, MAX_BODY * 2)), 1, MAX_BODY);
  return text.ok ? text : {ok: false, error: {code: text.error.code, message: text.error.code === 'too_long' ? `Use at most ${MAX_BODY} characters.` : 'Write a message.'}};
};

const sendBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const errors: Record<string, FieldError> = {};
  const body = bodyField(v?.body);
  if (!body.ok) errors.body = body.error;
  if (typeof v?.clientId !== 'string' || !CLIENT_ID_RE.test(v.clientId)) errors.clientId = {code: 'invalid', message: 'Missing message key.'};
  let parentId: bigint | null = null;
  if (v?.parentId !== undefined && v.parentId !== null) {
    parentId = messageIdOf(v.parentId) ?? null;
    if (parentId === null) errors.parentId = {code: 'invalid', message: 'Unknown thread.'};
  }
  const mentions = idList(v?.mentions, MAX_MENTIONS);
  if (!mentions) errors.mentions = {code: 'out_of_range', message: `Mention up to ${MAX_MENTIONS} people.`};
  const cardIds = idList(v?.cardIds, MAX_CARD_REFS);
  if (!cardIds) errors.cardIds = {code: 'out_of_range', message: `Link up to ${MAX_CARD_REFS} cards.`};
  let lastSeenSeq: number | null = null;
  if (v?.lastSeenSeq !== undefined && v.lastSeenSeq !== null) {
    if (typeof v.lastSeenSeq !== 'number' || !Number.isSafeInteger(v.lastSeenSeq) || v.lastSeenSeq < 0) errors.lastSeenSeq = {code: 'invalid', message: 'Unknown message.'};
    else lastSeenSeq = v.lastSeenSeq;
  }
  if (Object.keys(errors).length) return invalid(c, errors);
  return {body: (body as {value: string}).value, clientId: v!.clientId as string, parentId, mentions: mentions!, cardIds: cardIds!, lastSeenSeq} satisfies NewMessage;
});

const editBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const body = bodyField(v?.body);
  if (!body.ok) return invalid(c, {body: body.error});
  // Absent = keep what the message has; present (even []) = replace.
  const mentions = optionalIdList(v?.mentions, MAX_MENTIONS);
  if (mentions === null) return invalid(c, {mentions: {code: 'out_of_range', message: `Mention up to ${MAX_MENTIONS} people.`}});
  const cardIds = optionalIdList(v?.cardIds, MAX_CARD_REFS);
  if (cardIds === null) return invalid(c, {cardIds: {code: 'out_of_range', message: `Link up to ${MAX_CARD_REFS} cards.`}});
  return {body: body.value, mentions, cardIds};
});

const emojiBody = validator('json', (value, c) => {
  const v = objectOf(value);
  if (!isEmoji(v?.emoji)) return invalid(c, {emoji: {code: 'invalid', message: 'Choose an emoji.'}});
  return {emoji: v!.emoji as string};
});

const readBody = validator('json', (value, c) => {
  const v = objectOf(value);
  if (typeof v?.seq !== 'number' || !Number.isSafeInteger(v.seq) || v.seq < 0) return invalid(c, {seq: {code: 'invalid', message: 'Unknown message.'}});
  return {seq: v.seq};
});

type NewConversation = {kind: 'channel' | 'group' | 'dm'; name: string | null; userIds: number[]};
const conversationBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const errors: Record<string, FieldError> = {};
  const kind = v?.kind;
  if (kind !== 'channel' && kind !== 'group' && kind !== 'dm') return invalid(c, {kind: {code: 'invalid', message: 'Choose channel, group or direct message.'}});
  let name: string | null = null;
  if (kind !== 'dm') {
    const n = textField(typeof v?.name === 'string' ? v.name.replace(/[\u0000-\u001F\u007F]/g, ' ') : v?.name, 1, 80);
    if (n.ok) name = n.value;
    else errors.name = n.error;
  }
  let userIds: number[] = [];
  if (kind !== 'channel') {
    const ids = idList(v?.userIds, MAX_GROUP);
    if (!ids || ids.length < 1 || (kind === 'dm' && ids.length !== 1)) {
      errors.userIds = {code: 'out_of_range', message: kind === 'dm' ? 'Choose one person.' : `Choose 1 to ${MAX_GROUP} people.`};
    } else userIds = ids;
  }
  if (Object.keys(errors).length) return invalid(c, errors);
  return {kind, name, userIds} satisfies NewConversation;
});

/* ----------------------------------------------------------------- helpers */

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Of `ids`, the ones who may be mentioned in this conversation: workspace members (and, in a DM or
 * group, its members). ONE query.
 */
async function mentionable(db: PrismaClient, a: Access, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  if (a.kind === 'dm' || a.kind === 'group') {
    // A member of the conversation who is STILL a member of the workspace.
    const [rows, current] = await Promise.all([
      db.conversationMember.findMany({
        where: {conversationId: a.conversationId, workspaceId: a.workspaceId, userId: {in: ids}},
        select: {userId: true},
        take: MAX_MENTIONS,
      }),
      db.workspaceMember.findMany({where: {workspaceId: a.workspaceId, userId: {in: ids}}, select: {userId: true}, take: MAX_MENTIONS}),
    ]);
    const live = new Set(current.map(r => r.userId));
    return rows.filter(r => live.has(r.userId)).map(r => r.userId);
  }
  const [rows, board] = await Promise.all([
    db.workspaceMember.findMany({where: {workspaceId: a.workspaceId, userId: {in: ids}}, select: {userId: true, role: true}, take: MAX_MENTIONS}),
    a.kind === 'board' && a.boardId
      ? db.board.findFirst({
          where: {id: a.boardId, workspaceId: a.workspaceId},
          select: {visibility: true, boardMembers: {where: {userId: {in: ids}}, select: {userId: true}, take: MAX_MENTIONS}},
        })
      : null,
  ]);
  // A private board's chat names only people who can see the board (workspace owners/admins and board members), like card mentions.
  if (board && board.visibility === 'private') {
    const seated = new Set(board.boardMembers.map(m => m.userId));
    return rows.filter(r => r.role === 'owner' || r.role === 'admin' || seated.has(r.userId)).map(r => r.userId);
  }
  return rows.map(r => r.userId);
}

/** At most this many people read for one `@all` (the notify helper sends to its own MAX_RECIPIENTS of them). */
const MAX_ALL = 200;

/**
 * Who `@all` names: everyone who can read this conversation (members of a DM or group; the workspace for a channel;
 * for a board chat everyone who can see the board, as `resolveBoardRole` decides). Bounded reads, at most two queries.
 */
async function everyoneHere(db: PrismaClient, a: Access): Promise<number[]> {
  if (a.kind === 'dm' || a.kind === 'group') {
    const rows = await db.conversationMember.findMany({
      where: {conversationId: a.conversationId, workspaceId: a.workspaceId},
      select: {userId: true},
      take: MAX_ALL,
    });
    return rows.map(r => r.userId);
  }
  const [members, board] = await Promise.all([
    db.workspaceMember.findMany({where: {workspaceId: a.workspaceId}, select: {userId: true, role: true}, orderBy: {userId: 'asc'}, take: MAX_ALL}),
    a.kind === 'board' && a.boardId
      ? db.board.findFirst({
          where: {id: a.boardId, workspaceId: a.workspaceId},
          select: {visibility: true, inboxOf: true, boardMembers: {select: {userId: true}, take: MAX_ALL}},
        })
      : null,
  ]);
  if (a.kind === 'channel') return members.map(m => m.userId);
  if (!board) return [];
  // A personal Inbox is seen by its owner only.
  if (board.inboxOf !== null) return [];
  if (board.visibility !== 'private') return members.map(m => m.userId);
  const seated = new Set(board.boardMembers.map(m => m.userId));
  return members.filter(m => m.role === 'owner' || m.role === 'admin' || seated.has(m.userId)).map(m => m.userId);
}

/**
 * `@all` in a new message: a `message_mention` for everyone here but the sender and those already named one by one.
 * Through `notify`, so the per-actor hourly caps hold (no notification storm) and a failure never fails the send.
 */
async function notifyEveryone(db: PrismaClient, a: Access, me: number, named: readonly number[]): Promise<void> {
  try {
    const skip = new Set([me, ...named]);
    const ids = (await everyoneHere(db, a)).filter(id => !skip.has(id));
    if (ids.length === 0) return;
    await notify(db, ids, {workspaceId: a.workspaceId, kind: 'message_mention', actorId: me, boardId: a.boardId, conversationId: a.conversationId});
  } catch (err) {
    console.error(`chat @all: ${(err as Error).message}`);
  }
}

/** What may stand right before an `@`: whitespace or an opening/markup character. */
const MENTION_PREFIX = /[\s(\["'>*_;]/;

/**
 * Of `ids`, the people whose display name stands in the body as `@Name` (at the start or after whitespace or one of ( [ " ' > * _ ;, not
 * followed by a letter or digit; longest names first, so "@Ann Lee" does not also mention Ann). ONE query.
 */
async function mentionedInBody(db: PrismaClient, body: string, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  return mentionIdsIn(body, await namesOf(db, ids), ids);
}

/** The pure part of `mentionedInBody` (names already loaded). */
export function mentionIdsIn(body: string, names: Map<number, string>, ids: number[]): number[] {
  const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}\p{M}_]/u.test(ch);
  const sorted = ids.filter(id => names.get(id)).sort((x, y) => names.get(y)!.length - names.get(x)!.length);
  let work = body;
  const out: number[] = [];
  for (const id of sorted) {
    const needle = `@${names.get(id)}`;
    let from = 0;
    for (;;) {
      const i = work.indexOf(needle, from);
      if (i < 0) break;
      const after = work[i + needle.length];
      // A closing markdown `_` ends the name; an `_` followed by more letters continues it (`@Ann_x`).
      const continues = after === '_' ? isWord(work[i + needle.length + 1]) : isWord(after);
      if ((i === 0 || MENTION_PREFIX.test(work[i - 1]!)) && !continues) {
        out.push(id);
        work = work.slice(0, i) + '\u0000'.repeat(needle.length) + work.slice(i + needle.length);
        break;
      }
      from = i + 1;
    }
  }
  return out;
}

/** Groups and DMs this person started in this workspace in the last hour (bounded read). */
async function startedTooMany(db: PrismaClient, workspaceId: number, userId: number): Promise<boolean> {
  const rows = await db.conversation.findMany({
    where: {workspaceId, kind: {in: ['dm', 'group']}, createdBy: userId, createdAt: {gt: new Date(Date.now() - 3_600_000)}},
    select: {id: true},
    take: CONVERSATIONS_PER_HOUR,
  });
  return rows.length >= CONVERSATIONS_PER_HOUR;
}

/**
 * The board filter of a card the viewer may link: not another person's Inbox, and (unless workspace owner/admin)
 * not a private board without a seat for them. Same rule as `/cards/refs` and search.
 */
export function linkableBoardWhere(userId: number, role: WorkspaceRole) {
  const open = {OR: [{inboxOf: null}, {inboxOf: userId}]};
  if (rankOf(role) >= 3) return open;
  return {AND: [open, {OR: [{visibility: {not: 'private'}}, {inboxOf: userId}, {boardMembers: {some: {userId}}}]}]};
}

/** Of `ids`, the cards of THIS workspace the sender may see (a card id of a private board or another's Inbox is dropped, so ids are no oracle). ONE query. */
async function cardsInWorkspace(db: PrismaClient, a: Pick<Access, 'workspaceId' | 'workspaceRole'>, userId: number, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db.card.findMany({
    where: {workspaceId: a.workspaceId, id: {in: ids}, board: linkableBoardWhere(userId, a.workspaceRole)},
    select: {id: true},
    take: MAX_CARD_REFS,
  });
  return rows.map(r => r.id);
}

/** Joins the conversation (channels and board chats join on first use) and moves my read marker forward. */
async function markRead(db: PrismaClient | Tx, a: Pick<Access, 'conversationId' | 'workspaceId'>, userId: number, seq: number) {
  await db.conversationMember.createMany({
    data: [{conversationId: a.conversationId, userId, workspaceId: a.workspaceId, lastReadSeq: seq}],
    skipDuplicates: true,
  });
  await db.conversationMember.updateMany({
    where: {conversationId: a.conversationId, workspaceId: a.workspaceId, userId, lastReadSeq: {lt: seq}},
    data: {lastReadSeq: seq},
  });
}

const conversationShape = (
  r: {id: number; kind: string; name: string | null; boardId: number | null; lastSeq: bigint; dmKey: string | null},
  mine: {lastReadSeq: bigint; mutedAt: Date | null} | undefined,
  names: Map<number, string>,
  me: number
) => {
  let name = r.name;
  let peer: Person | null = null;
  if (r.kind === 'dm' && r.dmKey) {
    const other = r.dmKey.split(':').map(Number).find(n => n !== me);
    if (other) peer = {id: other, name: names.get(other) ?? ''};
    name = peer?.name || null;
  }
  return {
    id: r.id,
    kind: r.kind,
    name,
    boardId: r.boardId,
    peer,
    lastSeq: Number(r.lastSeq),
    unread: mine ? unreadOf(r.lastSeq, mine.lastReadSeq) : 0,
    joined: Boolean(mine),
    muted: Boolean(mine?.mutedAt),
  };
};

const convCols = {id: true, kind: true, name: true, boardId: true, lastSeq: true, dmKey: true} as const;

/* ------------------------------------------------------------------ routes */

/**
 * My conversations for the poll: the newest PULSE_CAP by last activity (a new message bumps `updatedAt`).
 * ONE round trip (the poll is the hottest route): my live workspaces, the board-visibility rule and the order are all in
 * one tagged query, so no board list is read per poll. Same rule as `pulseHiddenBoards` + `pulseWhere`: a board chat
 * is dropped for an Inbox board, or a private board without my seat unless I am owner/admin of that workspace.
 */
export async function pulseRows(db: PrismaClient, me: number, cap = PULSE_CAP) {
  const rows = await db.$queryRaw<{id: number; workspace_id: number; last_seq: bigint; last_read_seq: bigint; muted_at: Date | null}[]>`
    SELECT cv.id, cv.workspace_id, cv.last_seq, cm.last_read_seq, cm.muted_at
    FROM conversation_members cm
    JOIN conversations cv ON cv.id = cm.conversation_id
    JOIN workspace_members wm ON wm.workspace_id = cm.workspace_id AND wm.user_id = ${me}
    JOIN workspaces w ON w.id = wm.workspace_id AND w.archived_at IS NULL
    WHERE cm.user_id = ${me}
      AND (cv.board_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM boards b
        WHERE b.id = cv.board_id
          AND (b.inbox_of IS NOT NULL
            OR (b.visibility = 'private' AND wm.role NOT IN ('owner', 'admin')
              AND NOT EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = ${me})))))
    ORDER BY cv.updated_at DESC, cv.id DESC
    LIMIT ${cap}`;
  return rows.map(r => ({
    lastReadSeq: r.last_read_seq,
    mutedAt: r.muted_at,
    conversation: {id: r.id, workspaceId: r.workspace_id, lastSeq: r.last_seq},
  }));
}

export const chatRoutes = new Hono()
  .use('/chat/*', noStore)
  .use('/conversations/*', noStore)
  .use('/messages/*', noStore)

  /* ---- the poll: one query ------------------------------------------------------------------- */
  .get('/chat/pulse', withViewer, requireAuth, withDb, async c => {
    const rows = await pulseRows(c.var.db, c.var.viewer.id!);
    return c.json({
      items: rows.map(r => ({
        conversationId: r.conversation.id,
        workspaceId: r.conversation.workspaceId,
        lastSeq: Number(r.conversation.lastSeq),
        lastReadSeq: Number(r.lastReadSeq),
        unread: unreadOf(r.conversation.lastSeq, r.lastReadSeq),
        muted: r.mutedAt !== null,
      })),
    });
  })

  /* ---- conversations ------------------------------------------------------------------------- */
  .get('/workspaces/:id/conversations', withViewer, requireAuth, withDb, requireWorkspaceRole('viewer'), noStore, async c => {
    const me = c.var.viewer.id!;
    const {workspaceId} = c.var;
    const {db} = c.var;
    const [channels, mineRows] = await Promise.all([
      db.conversation.findMany({
        where: {workspaceId, kind: 'channel'},
        select: {...convCols, members: {where: {userId: me}, select: {lastReadSeq: true, mutedAt: true}, take: 1}},
        orderBy: {id: 'asc'},
        take: LIST_CAP,
      }),
      db.conversationMember.findMany({
        where: {userId: me, workspaceId, conversation: {kind: {in: ['dm', 'group', 'board']}}},
        select: {lastReadSeq: true, mutedAt: true, conversation: {select: convCols}},
        orderBy: {conversationId: 'asc'},
        take: LIST_CAP,
      }),
    ]);
    // Board chats only for boards I can still see: workspace admins see all, others every non-private board or one they sit on.
    const boardIds = mineRows.filter(r => r.conversation.kind === 'board' && r.conversation.boardId).map(r => r.conversation.boardId!);
    const visible = new Set<number>();
    if (boardIds.length) {
      const seen = await db.board.findMany({
        where: {
          workspaceId,
          id: {in: boardIds},
          inboxOf: null,
          ...(c.var.member.rank >= 3 ? {} : {OR: [{visibility: {not: 'private'}}, {boardMembers: {some: {userId: me}}}]}),
        },
        select: {id: true, name: true},
        take: LIST_CAP,
      });
      for (const b of seen) visible.add(b.id);
    }
    const kept = mineRows.filter(r => r.conversation.kind !== 'board' || (r.conversation.boardId && visible.has(r.conversation.boardId)));
    const names = await namesOf(
      db,
      kept.flatMap(r => (r.conversation.dmKey ? r.conversation.dmKey.split(':').map(Number) : []))
    );
    const items = [
      ...channels.map(r => conversationShape(r, r.members[0], names, me)),
      ...kept.map(r => conversationShape(r.conversation, r, names, me)),
    ];
    return c.json({items});
  })

  .post('/workspaces/:id/conversations', conversationBody, withViewer, requireAuth, withDb, requireWorkspaceRole('viewer'), noStore, async c => {
    const me = c.var.viewer.id!;
    const {workspaceId, db, member} = c.var;
    const input = c.req.valid('json');
    // Viewers read and may message people directly, but do not start channels or groups.
    if (input.kind !== 'dm' && member.rank < 2) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    const ent = await getEntitlements(db, workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);

    if (input.kind === 'channel') {
      const isGeneral = input.name!.trim().toLowerCase() === 'general';
      const existing = await db.conversation.findMany({where: {workspaceId, kind: 'channel'}, select: {id: true, name: true}, take: MAX_CHANNELS});
      if (!isGeneral && existing.length >= MAX_CHANNELS) return c.json(problem('limit_reached', `A workspace can have ${MAX_CHANNELS} channels.`), 409);
      const findGeneral = (client: PrismaClient | Tx) =>
        client.conversation.findFirst({where: {workspaceId, kind: 'channel', name: {equals: 'general', mode: 'insensitive'}}, select: convCols, orderBy: {id: 'asc'}});
      const result = await db.$transaction(async tx => {
        if (isGeneral) {
          // #general is made once per workspace: concurrent creators queue on this lock, the second finds the first.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(4001, ${workspaceId}::int)`;
          const there = await findGeneral(tx);
          if (there) return {conv: there, created: false};
          if (existing.length >= MAX_CHANNELS) return null;
        }
        const conv = await tx.conversation.create({data: {workspaceId, kind: 'channel', name: input.name, createdBy: me}, select: convCols});
        await tx.conversationMember.create({data: {conversationId: conv.id, userId: me, workspaceId}, select: {userId: true}});
        return {conv, created: true};
      });
      if (!result) return c.json(problem('limit_reached', `A workspace can have ${MAX_CHANNELS} channels.`), 409);
      if (!result.created) {
        const mine = await db.conversationMember.findUnique({where: {conversationId_userId: {conversationId: result.conv.id, userId: me}}, select: {lastReadSeq: true, mutedAt: true}});
        return c.json({conversation: conversationShape(result.conv, mine ?? undefined, new Map(), me)}, 200);
      }
      const row = result.conv;
      await audit(db, {actorUserId: me, action: 'chat.channel_created', target: ['conversation', row.id], meta: {workspaceId}});
      return c.json({conversation: conversationShape(row, {lastReadSeq: 0n, mutedAt: null}, new Map(), me)}, 201);
    }

    // DM and group: everyone must belong to THIS workspace.
    const others = input.userIds.filter(id => id !== me);
    if (others.length === 0) return invalid(c, {userIds: {code: 'invalid', message: 'Choose someone else.'}});
    const found = await db.workspaceMember.findMany({where: {workspaceId, userId: {in: others}}, select: {userId: true}, take: MAX_GROUP});
    if (found.length !== others.length) return invalid(c, {userIds: {code: 'invalid', message: 'Choose people from this workspace.'}});

    if (input.kind === 'dm') {
      const dmKey = dmKeyOf(me, others[0]!);
      const existing = await db.conversation.findUnique({where: {workspaceId_dmKey: {workspaceId, dmKey}}, select: convCols});
      let row = existing;
      if (!row) {
        if (await startedTooMany(db, workspaceId, me)) return c.json(problem('conversation_rate_limited', 'You started many chats in the last hour. Try again later.'), 429);
        try {
          row = await db.$transaction(async tx => {
            const conv = await tx.conversation.create({data: {workspaceId, kind: 'dm', dmKey, createdBy: me}, select: convCols});
            await tx.conversationMember.createMany({
              data: [me, others[0]!].map(userId => ({conversationId: conv.id, userId, workspaceId})),
            });
            return conv;
          });
        } catch (error) {
          if (!isUnique(error)) throw error;
          row = await db.conversation.findUnique({where: {workspaceId_dmKey: {workspaceId, dmKey}}, select: convCols});
        }
      }
      if (!row) return c.json(problem('internal_error', 'Something went wrong.'), 500);
      // The real read marker (an existing DM has history); a new one has none yet.
      const [names, mine] = await Promise.all([
        namesOf(db, [me, others[0]!]),
        existing
          ? db.conversationMember.findUnique({where: {conversationId_userId: {conversationId: row.id, userId: me}}, select: {lastReadSeq: true, mutedAt: true}})
          : null,
      ]);
      return c.json({conversation: conversationShape(row, mine ?? {lastReadSeq: 0n, mutedAt: null}, names, me)}, existing ? 200 : 201);
    }

    if (await startedTooMany(db, workspaceId, me)) return c.json(problem('conversation_rate_limited', 'You started many chats in the last hour. Try again later.'), 429);
    const row = await db.$transaction(async tx => {
      const conv = await tx.conversation.create({data: {workspaceId, kind: 'group', name: input.name, createdBy: me}, select: convCols});
      await tx.conversationMember.createMany({
        data: [me, ...others].map(userId => ({conversationId: conv.id, userId, workspaceId})),
      });
      return conv;
    });
    return c.json({conversation: conversationShape(row, {lastReadSeq: 0n, mutedAt: null}, new Map(), me)}, 201);
  })

  .get('/boards/:id/conversation', withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    const {db} = c.var;
    const boardId = idOf(c.req.param('id'));
    if (!boardId) return notFound(c, 'board');
    const access = await boardAccess(db, boardId, me);
    if (!access) return notFound(c, 'board');
    const where = {boardId, workspaceId: access.workspaceId, kind: 'board'} as const;
    let conv = await db.conversation.findFirst({where, select: convCols});
    if (!conv) {
      try {
        conv = await db.conversation.create({
          data: {workspaceId: access.workspaceId, boardId, kind: 'board', createdBy: me},
          select: convCols,
        });
      } catch (error) {
        if (!isUnique(error)) throw error;
        conv = await db.conversation.findFirst({where, select: convCols});
      }
    }
    if (!conv) return c.json(problem('internal_error', 'Something went wrong.'), 500);
    await markRead(db, {conversationId: conv.id, workspaceId: access.workspaceId}, me, 0);
    const mine = await db.conversationMember.findUnique({
      where: {conversationId_userId: {conversationId: conv.id, userId: me}},
      select: {lastReadSeq: true, mutedAt: true},
    });
    return c.json({conversation: {...conversationShape(conv, mine ?? undefined, new Map(), me), canWrite: access.canWrite && !access.archived}});
  })

  /* ---- messages ------------------------------------------------------------------------------ */
  .get('/conversations/:id/messages', listQuery, withViewer, requireAuth, withDb, requireConversation('read'), noStore, async c => {
    const a = c.var.access;
    const q = c.req.valid('query');
    const limit = Math.min(Math.max(seqOf(q.limit) ?? PAGE, 1), PAGE);
    const before = seqOf(q.before);
    const after = seqOf(q.after);
    const parent = q.parent ? messageIdOf(q.parent) : undefined;
    if (q.parent && !parent) return invalid(c, {parent: {code: 'invalid', message: 'Unknown thread.'}});

    // Top level (parentId null) or ONE thread; keyset on seq (index conversation_id, seq).
    const where = {
      conversationId: a.conversationId,
      workspaceId: a.workspaceId,
      parentId: parent ?? null,
      ...(after !== undefined ? {seq: {gt: BigInt(after)}} : before !== undefined ? {seq: {lt: BigInt(before)}} : {}),
    };
    const polling = after !== undefined;
    const rows = await c.var.db.message.findMany({
      where,
      select: messageCols,
      orderBy: {seq: polling ? 'asc' : 'desc'},
      take: limit + 1,
    });
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    if (!polling) page.reverse();
    const {items} = await shapeMessages(c.var.db, page, a, c.var.viewer.id!);
    return c.json({
      items,
      // Older pages: pass `nextBefore` as `before`. Polling: pass the last item's `seq` as `after`; `more` = fetch again now.
      nextBefore: !polling && more ? items[0]!.seq : null,
      more: polling ? more : false,
      lastSeq: a.lastSeq,
      lastReadSeq: a.lastReadSeq,
      canWrite: a.canWrite,
      canModerate: a.canModerate,
    });
  })

  .post('/conversations/:id/messages', sendBody, withViewer, requireAuth, withDb, requireConversation('write'), noStore, async c => {
    const me = c.var.viewer.id!;
    const {db, access: a} = c.var;
    const input = c.req.valid('json');

    const find = () =>
      db.message.findUnique({
        where: {conversationId_clientId: {conversationId: a.conversationId, clientId: input.clientId}},
        select: {...messageCols},
      });
    const replay = async (row: MessageRow | null) => {
      if (!row) return null;
      if (row.senderId !== me) return c.json(problem('conflict', 'That message key is taken.'), 409);
      const {items} = await shapeMessages(db, [row], a, me);
      return c.json({message: items[0]}, 200);
    };
    // Independent reads in ONE round trip: replay lookup, rate limit (bounded read of messages(sender_id, created_at)),
    // the reply target, who may be named (and their names) and the card refs.
    const now = Date.now();
    const [found, lastMinute, lastHour, parent, allowed, cardIds, names] = await Promise.all([
      find(),
      db.message.findMany({where: {senderId: me, createdAt: {gt: new Date(now - 60_000)}}, select: {id: true}, take: SEND_PER_MINUTE + 1}),
      db.message.findMany({where: {senderId: me, createdAt: {gt: new Date(now - 3_600_000)}}, select: {id: true}, take: SEND_PER_HOUR + 1}),
      // A reply goes to a top-level, live message of THIS conversation.
      input.parentId !== null
        ? db.message.findFirst({
            where: {id: input.parentId, conversationId: a.conversationId, workspaceId: a.workspaceId, parentId: null, deletedAt: null},
            select: {id: true},
          })
        : null,
      mentionable(db, a, input.mentions),
      cardsInWorkspace(db, a, me, input.cardIds),
      // The sender's own name rides along: the new message needs no second names/reactions read.
      namesOf(db, [me, ...input.mentions]),
    ]);
    // Retried send: the same message comes back, nothing is written twice.
    const already = await replay(found);
    if (already) return already;
    if (lastMinute.length > SEND_PER_MINUTE || lastHour.length > SEND_PER_HOUR) {
      c.header('Retry-After', lastMinute.length > SEND_PER_MINUTE ? '30' : '300');
      return c.json(problem('rate_limited', 'You are sending too fast. Wait a moment and try again.'), 429);
    }
    if (input.parentId !== null && !parent) return notFound(c, 'message');
    // Never trust the ids alone: only people really named as `@Name` in the text.
    const mentions = mentionIdsIn(input.body, names, allowed);

    try {
      const row = await db.$transaction(async tx => {
        // One atomic increment hands out the next seq; concurrent senders queue on the row lock.
        const conv = await tx.conversation.update({
          where: {id: a.conversationId},
          data: {lastSeq: {increment: 1}},
          select: {lastSeq: true},
        });
        const created = await tx.message.create({
          data: {
            conversationId: a.conversationId,
            workspaceId: a.workspaceId,
            seq: conv.lastSeq,
            senderId: me,
            bodyMd: input.body,
            parentId: input.parentId,
            clientId: input.clientId,
            kind: 'user',
            mentions: {create: mentions.map(userId => ({userId}))},
            cardRefs: {create: cardIds.map(cardId => ({cardId}))},
          },
          select: messageCols,
        });
        if (input.parentId !== null) {
          await tx.message.updateMany({
            where: {id: input.parentId, conversationId: a.conversationId, workspaceId: a.workspaceId},
            data: {replyCount: {increment: 1}},
          });
        }
        // Mark only what the sender has seen: up to their known seq (or the marker they had), plus this message
        // when nothing unseen sits before it. Messages from others in between stay unread.
        const mine = Number(conv.lastSeq);
        const seen = Math.min(input.lastSeenSeq ?? a.lastReadSeq, mine - 1);
        await markRead(tx, a, me, seen >= mine - 1 ? mine : Math.max(seen, 0));
        const named = mentions.filter(id => id !== me);
        if (named.length) {
          // Muted members still get the mention; they asked to silence the chat, not people who name them.
          await tx.notification.createMany({
            data: named.map(userId => ({
              userId,
              workspaceId: a.workspaceId,
              kind: 'message_mention',
              actorId: me,
              boardId: a.boardId,
              conversationId: a.conversationId,
            })),
          });
        }
        return created;
      });
      if (mentionsAll(input.body)) await notifyEveryone(db, a, me, mentions);
      // A brand-new message has no reactions, and its names (sender, mentions) were read above: shape it directly.
      return c.json({message: messageShape(row, names, [], a.conversationId, await cardNumberRefs(db, a, me, [row]))}, 201);
    } catch (error) {
      if (!isUnique(error)) throw error;
      // Two sends with the same key arrived together: the other one wrote it.
      const winner = await replay(await find());
      if (winner) return winner;
      throw error;
    }
  })

  .post('/conversations/:id/read', readBody, withViewer, requireAuth, withDb, requireConversation('read'), noStore, async c => {
    const a = c.var.access;
    // Never past the last message that exists.
    const seq = Math.min(c.req.valid('json').seq, a.lastSeq);
    await markRead(c.var.db, a, c.var.viewer.id!, seq);
    return c.json({lastReadSeq: Math.max(seq, a.lastReadSeq), unread: unreadOf(a.lastSeq, Math.max(seq, a.lastReadSeq))});
  })

  .put('/conversations/:id/mute', withViewer, requireAuth, withDb, requireConversation('read'), noStore, async c => {
    const a = c.var.access;
    await markRead(c.var.db, a, c.var.viewer.id!, 0);
    await c.var.db.conversationMember.updateMany({
      where: {conversationId: a.conversationId, workspaceId: a.workspaceId, userId: c.var.viewer.id!},
      data: {mutedAt: new Date()},
    });
    return c.json({muted: true});
  })

  .delete('/conversations/:id/mute', withViewer, requireAuth, withDb, requireConversation('read'), noStore, async c => {
    const a = c.var.access;
    await c.var.db.conversationMember.updateMany({
      where: {conversationId: a.conversationId, workspaceId: a.workspaceId, userId: c.var.viewer.id!},
      data: {mutedAt: null},
    });
    return c.json({muted: false});
  })

  /* ---- one message: edit, delete, react, pin ---------------------------------------------------- */
  .patch('/messages/:id', editBody, withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    const {db} = c.var;
    const found = await ownMessage(c, me, true);
    if (found instanceof Response) return found;
    const {a, row} = found;
    if (!a.canWrite) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    const blocked = await readOnlyBlock(c, db, a.workspaceId);
    if (blocked) return blocked;
    const input = c.req.valid('json');
    // Absent = unchanged; present = replaced (mentions only those really named in the new text).
    const [allowed, cardIds] = await Promise.all([
      input.mentions === undefined ? undefined : mentionable(db, a, input.mentions),
      input.cardIds === undefined ? undefined : cardsInWorkspace(db, a, me, input.cardIds),
    ]);
    const mentions = allowed === undefined ? undefined : await mentionedInBody(db, input.body, allowed);
    const updated = await db.$transaction(async tx => {
      const {count} = await tx.message.updateMany({
        where: {id: row.id, conversationId: a.conversationId, workspaceId: a.workspaceId, senderId: me, deletedAt: null, kind: 'user'},
        data: {bodyMd: input.body, editedAt: new Date()},
      });
      if (count === 0) return null;
      if (mentions !== undefined) {
        await tx.messageMention.deleteMany({where: {messageId: row.id}});
        await tx.messageMention.createMany({data: mentions.map(userId => ({messageId: row.id, userId}))});
      }
      if (cardIds !== undefined) {
        await tx.messageCardRef.deleteMany({where: {messageId: row.id}});
        await tx.messageCardRef.createMany({data: cardIds.map(cardId => ({messageId: row.id, cardId}))});
      }
      return tx.message.findFirst({where: {id: row.id, conversationId: a.conversationId}, select: messageCols});
    });
    if (!updated) return notFound(c, 'message');
    const {items} = await shapeMessages(db, [updated], a, me);
    return c.json({message: items[0]});
  })

  .delete('/messages/:id', withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    const {db} = c.var;
    const found = await ownMessage(c, me, false);
    if (found instanceof Response) return found;
    const {a, row} = found;
    const own = row.senderId === me;
    if (row.kind === 'system') return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    if (!own && !a.canModerate) return notFound(c, 'message');
    // Deleting your OWN message always works (it heals a read-only workspace); a moderator's delete does not.
    if (!own) {
      const blocked = await readOnlyBlock(c, db, a.workspaceId);
      if (blocked) return blocked;
    }
    await db.$transaction(async tx => {
      const {count} = await tx.message.updateMany({
        where: {id: row.id, conversationId: a.conversationId, workspaceId: a.workspaceId, deletedAt: null},
        data: {bodyMd: '', deletedAt: new Date(), pinnedAt: null},
      });
      if (count === 0) return;
      await tx.messageMention.deleteMany({where: {messageId: row.id}});
      await tx.messageCardRef.deleteMany({where: {messageId: row.id}});
      await tx.messageReaction.deleteMany({where: {messageId: row.id}});
      // A deleted reply leaves the count of its thread honest.
      if (row.parentId !== null) {
        await tx.message.updateMany({
          where: {id: row.parentId, conversationId: a.conversationId, workspaceId: a.workspaceId, replyCount: {gt: 0}},
          data: {replyCount: {decrement: 1}},
        });
      }
    });
    if (!own) {
      await audit(db, {
        actorUserId: me,
        action: 'chat.message_deleted',
        target: ['message', String(row.id)],
        meta: {workspaceId: a.workspaceId, conversationId: a.conversationId, senderId: row.senderId},
      });
    }
    return c.json({ok: true});
  })

  .put('/messages/:id/reactions', emojiBody, withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    const {db} = c.var;
    const found = await ownMessage(c, me, false);
    if (found instanceof Response) return found;
    const {a, row} = found;
    if (!a.canWrite || row.deletedAt) return row.deletedAt ? notFound(c, 'message') : c.json(problem('forbidden', 'You do not have access to this.'), 403);
    const blocked = await readOnlyBlock(c, db, a.workspaceId);
    if (blocked) return blocked;
    const {emoji} = c.req.valid('json');
    const kinds = await db.messageReaction.findMany({where: {messageId: row.id}, select: {emoji: true}, distinct: ['emoji'], take: MAX_EMOJI_PER_MESSAGE + 1});
    if (kinds.length >= MAX_EMOJI_PER_MESSAGE && !kinds.some(k => k.emoji === emoji)) {
      return c.json(problem('limit_reached', 'That message has enough different reactions.'), 409);
    }
    await db.messageReaction.createMany({data: [{messageId: row.id, userId: me, emoji}], skipDuplicates: true});
    const groups = (await reactionsFor(db, [row.id], me)).get(String(row.id)) ?? [];
    return c.json({reactions: groups});
  })

  .delete('/messages/:id/reactions', emojiBody, withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    const {db} = c.var;
    const found = await ownMessage(c, me, false);
    if (found instanceof Response) return found;
    const {a, row} = found;
    if (!a.canWrite) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    const blocked = await readOnlyBlock(c, db, a.workspaceId);
    if (blocked) return blocked;
    await db.messageReaction.deleteMany({where: {messageId: row.id, userId: me, emoji: c.req.valid('json').emoji}});
    const groups = (await reactionsFor(db, [row.id], me)).get(String(row.id)) ?? [];
    return c.json({reactions: groups});
  })

  .put('/messages/:id/pin', withViewer, requireAuth, withDb, noStore, pin(true))
  .delete('/messages/:id/pin', withViewer, requireAuth, withDb, noStore, pin(false));

/** Loads the message AND proves the visitor reaches its conversation; null/404 otherwise. `ownOnly` = only the sender's. */
async function ownMessage(
  c: {req: {param: (n: string) => string}; var: {db: PrismaClient}; json: (b: unknown, s: 404) => Response},
  me: number,
  ownOnly: boolean
): Promise<Response | {a: Access; row: {id: bigint; senderId: number | null; parentId: bigint | null; deletedAt: Date | null; kind: string}}> {
  const id = messageIdOf(c.req.param('id'));
  if (!id) return notFound(c, 'message');
  const row = await c.var.db.message.findFirst({
    // Workspace membership is enforced right after, by conversationAccess.
    where: {id, ...(ownOnly ? {senderId: me} : {})},
    select: {id: true, senderId: true, parentId: true, deletedAt: true, kind: true, conversationId: true},
  });
  if (!row) return notFound(c, 'message');
  const a = await conversationAccess(c.var.db, row.conversationId, me);
  if (!a) return notFound(c, 'message');
  if (ownOnly && row.deletedAt) return notFound(c, 'message');
  return {a, row};
}

function pin(on: boolean) {
  return async (c: any) => {
    const me = c.var.viewer.id as number;
    const found = await ownMessage(c, me, false);
    if (found instanceof Response) return found;
    const {a, row} = found;
    // Moderators in channels and board chats; any participant in a DM or group.
    const may = a.kind === 'dm' || a.kind === 'group' ? a.canWrite : a.canModerate;
    if (!may) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    const blocked = await readOnlyBlock(c, c.var.db, a.workspaceId);
    if (blocked) return blocked;
    const {count} = await c.var.db.message.updateMany({
      where: {id: row.id, conversationId: a.conversationId, workspaceId: a.workspaceId, deletedAt: null},
      data: {pinnedAt: on ? new Date() : null},
    });
    return count ? c.json({pinned: on}) : notFound(c, 'message');
  };
}
