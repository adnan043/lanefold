import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import {parseCardRefIds} from '../../lib/card-refs';
import {generateKeyBetween} from 'fractional-indexing';

import {CARD_TITLE_MAX, descriptionFromMessage, titleFromMessage} from '../../lib/card-from-message';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {reserveCardNumbers} from '../card-number';
import {getEntitlements, MAX_CARDS_PER_LANE} from '../entitlements';
import {conversationAccess, unreadOf} from './chat';
import {idOf, intField, invalid, likeEscape, objectOf, textField, type FieldError} from '../validation';
import {boardAccess, notFound, requireWorkspaceRole} from '../workspaces';

/** Small chat additions: one conversation's metadata and the member search of the mention / DM pickers. */
const SEARCH_MAX = 20;
const Q_MAX = 40;

const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

const searchQuery = validator('query', (value, c) => {
  const q = typeof value.q === 'string' ? value.q.trim() : '';
  if (q.length > Q_MAX) return invalid(c, {q: {code: 'too_long', message: `Use at most ${Q_MAX} characters.`}});
  return {q};
});

const refsQuery = validator('query', (value, c) => {
  const ids = parseCardRefIds(value.ids);
  if (!ids) return invalid(c, {ids: {code: 'invalid', message: 'Send 1 to 20 card ids, like ids=1,2,3.'}});
  return {ids};
});

const MAX_CARD_REFS = 10;

const cardFromMessageBody = validator('json', (value, c) => {
  const v = objectOf(value);
  const errors: Record<string, FieldError> = {};
  const lane = intField(v?.laneId, 1, 2_147_483_647);
  if (!lane.ok) errors.laneId = {code: 'required', message: 'Choose a lane.'};
  let title: string | null = null;
  if (v?.title !== undefined && v.title !== null && v.title !== '') {
    const t = textField(v.title, 1, CARD_TITLE_MAX * 2);
    if (t.ok && Array.from(t.value).length <= CARD_TITLE_MAX) title = t.value;
    else errors.title = t.ok ? {code: 'too_long', message: `Use at most ${CARD_TITLE_MAX} characters.`} : t.error;
  }
  if (Object.keys(errors).length) return invalid(c, errors);
  return {laneId: (lane as {value: number}).value, title};
});

export const chatExtraRoutes = new Hono()
  /**
   * One conversation the visitor may see (a board chat or channel a notification points at). Joins nothing:
   * reading the messages joins. A conversation of another workspace, a DM they are not in or a board they
   * cannot see is a 404.
   */
  .get('/conversations/:id', withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    const {db} = c.var;
    const id = idOf(c.req.param('id'));
    if (!id) return notFound(c, 'conversation');
    const a = await conversationAccess(db, id, me);
    if (!a) return notFound(c, 'conversation');
    const [conv, board] = await Promise.all([
      db.conversation.findFirst({where: {id: a.conversationId, workspaceId: a.workspaceId}, select: {name: true, dmKey: true}}),
      a.boardId ? db.board.findFirst({where: {id: a.boardId, workspaceId: a.workspaceId}, select: {name: true}}) : Promise.resolve(null),
    ]);
    if (!conv) return notFound(c, 'conversation');
    let peer: {id: number; name: string} | null = null;
    if (a.kind === 'dm' && conv.dmKey) {
      const other = conv.dmKey.split(':').map(Number).find(n => n !== me);
      if (other) {
        const user = await db.user.findFirst({where: {id: other}, select: {name: true}});
        peer = {id: other, name: user?.name ?? ''};
      }
    }
    return c.json({
      conversation: {
        id: a.conversationId,
        workspaceId: a.workspaceId,
        kind: a.kind,
        name: peer ? peer.name || null : (board?.name ?? conv.name),
        boardId: a.boardId,
        peer,
        lastSeq: a.lastSeq,
        unread: a.joined ? unreadOf(a.lastSeq, a.lastReadSeq) : 0,
        joined: a.joined,
        muted: a.muted,
        canWrite: a.canWrite,
        canModerate: a.canModerate,
      },
    });
  })

  /** Names for the pickers: prefix of the name or of any word in it, at most 20, never an email. */
  .get('/workspaces/:id/members/search', searchQuery, withViewer, requireAuth, withDb, requireWorkspaceRole('viewer'), noStore, async c => {
    const {db, workspaceId} = c.var;
    const {q} = c.req.valid('query');
    // One tagged, parameterised query: workspace members joined to names (a prefix of the name or of a word in it).
    const prefix = `${likeEscape(q)}%`;
    const word = `% ${likeEscape(q)}%`;
    const rows = await db.$queryRaw<{id: number; name: string}[]>`
      SELECT u.id, u.name
      FROM workspace_members m
      JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ${workspaceId} AND u.status = 'active'
        AND (${q} = '' OR u.name ILIKE ${prefix} OR u.name ILIKE ${word})
      ORDER BY u.name ASC, u.id ASC
      LIMIT ${SEARCH_MAX}`;
    const me = c.var.viewer.id;
    return c.json({items: rows.map(r => ({userId: r.id, name: r.name, isMe: r.id === me}))});
  })

  /**
   * Light batch for the chat card chips: for each id the viewer may see, its title and board. ONE query; the
   * workspace membership and the private-board rule (owner/admin, non-private board or board member, as in
   * search.ts; another user's Inbox never) are in the WHERE, so ids they may not see are simply absent.
   */
  .get('/cards/refs', refsQuery, withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    const {ids} = c.req.valid('query');
    const rows = await c.var.db.$queryRaw<{id: number; number: number | null; title: string; board_id: number; board_name: string; done: boolean}[]>`
      SELECT c.id, c.number, c.title, c.board_id, b.name AS board_name, (c.completed_at IS NOT NULL) AS done
      FROM cards c
      JOIN boards b ON b.id = c.board_id AND b.workspace_id = c.workspace_id
      JOIN workspaces w ON w.id = c.workspace_id AND w.archived_at IS NULL
      JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = ${me}
      WHERE c.id = ANY(${ids}::int[])
        AND (b.inbox_of IS NULL OR b.inbox_of = ${me})
        AND (wm.role IN ('owner', 'admin') OR b.visibility <> 'private' OR b.inbox_of = ${me}
             OR EXISTS (SELECT 1 FROM board_members bm WHERE bm.board_id = b.id AND bm.user_id = ${me}))
      LIMIT ${ids.length}`;
    return c.json({items: rows.map(r => ({id: r.id, number: r.number, title: r.title, boardId: r.board_id, boardName: r.board_name, done: r.done}))});
  })

  /**
   * Create a card from a chat message: the visitor must read the message's conversation AND write to the
   * lane's board (same workspace). Lane cap, rev bump and activity row are in ONE transaction; the new card
   * is then attached to the message (`message_card_refs`). A board the visitor cannot see is a 404 (its
   * name never appears); one they can see but not write is a 403.
   */
  .post('/messages/:id/card', cardFromMessageBody, withViewer, requireAuth, withDb, noStore, async c => {
    const me = c.var.viewer.id!;
    const {db} = c.var;
    const raw = c.req.param('id');
    if (!/^\d{1,18}$/.test(raw) || BigInt(raw) <= 0n) return notFound(c, 'message');
    const messageId = BigInt(raw);
    const {laneId, title: given} = c.req.valid('json');

    const msg = await db.message.findFirst({
      where: {id: messageId},
      select: {id: true, bodyMd: true, deletedAt: true, kind: true, conversationId: true, _count: {select: {cardRefs: true}}},
    });
    if (!msg) return notFound(c, 'message');
    const a = await conversationAccess(db, msg.conversationId, me);
    if (!a || msg.deletedAt || msg.kind !== 'user') return notFound(c, 'message');

    // The lane must be in the conversation's workspace; the board's own access decides the rest.
    const lane = await db.lane.findFirst({
      where: {id: laneId, workspaceId: a.workspaceId, archivedAt: null},
      select: {id: true, boardId: true},
    });
    if (!lane) return notFound(c, 'lane');
    const access = await boardAccess(db, lane.boardId, me);
    if (!access || access.workspaceId !== a.workspaceId) return notFound(c, 'lane');
    if (!access.canWrite) return c.json(problem('forbidden', 'You do not have access to this.'), 403);
    if (access.archived) return c.json(problem('board_archived', 'This board is archived.'), 409);
    const ent = await getEntitlements(db, a.workspaceId);
    if (ent?.readOnly) return c.json(problem('workspace_read_only', 'This workspace is read-only until its plan limits are fixed.'), 409);
    if (msg._count.cardRefs >= MAX_CARD_REFS) return c.json(problem('too_many_cards', `A message links up to ${MAX_CARD_REFS} cards.`), 409);

    // Where it came from, for the description: a channel or board name (visible to the reader), never a DM's person.
    // A private board chat's name is only written when the card lands on that same board; else a generic label.
    let source = 'a direct message';
    if (a.kind === 'channel') {
      const conv = await db.conversation.findFirst({where: {id: a.conversationId, workspaceId: a.workspaceId}, select: {name: true}});
      source = `#${conv?.name ?? 'channel'}`; // channels are open to the whole workspace
    } else if (a.kind === 'board' && a.boardId) {
      const b = await db.board.findFirst({where: {id: a.boardId, workspaceId: a.workspaceId}, select: {name: true, visibility: true}});
      source = b && (a.boardId === lane.boardId || b.visibility !== 'private') ? `#${b.name}` : 'a board chat';
    } else if (a.kind === 'group') source = 'a group chat';

    const title = given ?? titleFromMessage(msg.bodyMd);
    const descriptionMd = descriptionFromMessage(msg.bodyMd, source, 20000);
    const boardId = lane.boardId;
    const workspaceId = a.workspaceId;

    const out = await db.$transaction(async tx => {
      const rows = await tx.$queryRaw<{rev: bigint}[]>`
        UPDATE boards SET rev = rev + 1, updated_at = now()
        WHERE id = ${boardId} AND workspace_id = ${workspaceId} RETURNING rev`;
      if (!rows[0]) throw new Error('board vanished');
      const rev = rows[0].rev;
      // The 10-card cap is re-counted under a lock on the message (taken AFTER the board lock, always in this order).
      await tx.$queryRaw`SELECT 1 FROM messages WHERE id = ${msg.id} FOR UPDATE`;
      const refs = await tx.messageCardRef.count({where: {messageId: msg.id}});
      if (refs >= MAX_CARD_REFS) return 'refs' as const;
      const last = await tx.card.findFirst({
        where: {workspaceId, laneId: lane.id, archivedAt: null},
        select: {position: true},
        orderBy: [{position: 'desc'}, {id: 'desc'}],
      });
      const position = generateKeyBetween(last?.position ?? null, null);
      // The per-lane cap is ONE conditional update (same as POST /lanes/:id/cards).
      const room = await tx.$queryRaw<{id: number}[]>`
        UPDATE lanes SET card_count = card_count + 1, updated_rev = ${rev}
        WHERE id = ${lane.id} AND board_id = ${boardId} AND workspace_id = ${workspaceId} AND archived_at IS NULL
          AND card_count + 1 <= ${MAX_CARDS_PER_LANE}::int
        RETURNING id`;
      if (!room[0]) return null;
      const number = await reserveCardNumbers(tx, boardId, workspaceId, 1);
      const card = await tx.card.create({
        data: {number, boardId, laneId: lane.id, workspaceId, title, descriptionMd, position, updatedRev: rev, createdBy: me},
        select: {id: true, laneId: true, title: true, boardId: true},
      });
      await tx.activity.create({
        data: {workspaceId, boardId, cardId: card.id, actorId: me, kind: 'card.created', meta: {title: card.title, fromMessage: true}},
      });
      await tx.messageCardRef.create({data: {messageId: msg.id, cardId: card.id}});
      return {card, rev};
    });
    if (out === 'refs') return c.json(problem('too_many_cards', `A message links up to ${MAX_CARD_REFS} cards.`), 409);
    if (!out) return c.json(problem('lane_card_limit', `A lane holds up to ${MAX_CARDS_PER_LANE} cards.`), 409);
    return c.json({card: {id: out.card.id, boardId: out.card.boardId, laneId: out.card.laneId, title: out.card.title}, messageId: String(msg.id), rev: String(out.rev)}, 201);
  });
