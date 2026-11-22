import {Hono} from 'hono';

import {problem, withDb} from '../../platform/guards';
import {cache} from '../../platform/cache';
import {config} from '../../platform/config';
import {afterResponse} from '../after-response';

/**
 * The public read-only board (docs/product/public-board-design.md).
 *
 *   GET /public/boards/:token   one shared board, no sign-in, no cookies read (no `withViewer`)
 *
 * The token is a bearer secret: 43 base64url characters, stored only as SHA-256 hex in `boards.share_token_hash`.
 * Every miss (malformed, unknown, private, archived, inbox, archived workspace) answers the SAME 404.
 * The visibility check is in the query's `where`; the answer is built from explicit `select` lists, so no email,
 * user id, comment, attachment, chat or file id can reach it. Descriptions are sent as plain text (never HTML).
 * Failed lookups are rate limited per hashed IP (Site Cache counters; approximate, which is enough to stop guessing).
 */

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const MAX_LANES = 20;
/** Cards shown per lane, and in the whole answer (the page says how many more each lane holds: `cardCount`). */
const MAX_CARDS_PER_LANE = 30;
const MAX_CARDS_TOTAL = 300;
const MAX_DESCRIPTION = 2000;
const MAX_TAGS_PER_CARD = 12;
const MISS_LIMIT = 20;
const MISS_WINDOW_S = 600;
const VIEW_LIMIT = 120;
const VIEW_WINDOW_S = 60;
// Short: label, member-name and workspace-name edits do not bump the board's rev, so they show within 5 minutes.
const CONTENT_TTL_S = 300;

const NOT_FOUND = problem('not_found', 'This board is not available.');

export async function sha256Hex(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** "Maria Khan" -> "Maria K."; one word stays as it is; nothing for a blank name. Never an email. */
export function publicName(name: string | null | undefined): string | null {
  const parts = (name ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0]!;
  if (parts.some(p => p.includes('@'))) return null;
  if (parts.length === 1) return first.slice(0, 30);
  const last = Array.from(parts[parts.length - 1]!)[0] ?? '';
  return `${first.slice(0, 30)} ${last.toUpperCase()}.`;
}

const hexOrNull = (v: string | null | undefined) => (v && HEX.test(v) ? v : null);

export type PublicCard = {
  title: string;
  description: string;
  priority: string;
  dueDate: string | null;
  checklistDone: number;
  checklistTotal: number;
  labels: {name: string; color: string | null}[];
  people: string[];
};
/** `cardCount`: the lane's open cards, which can be more than `cards` (capped): the page shows the rest as "N more". */
export type PublicLane = {name: string; color: string | null; cardCount: number; cards: PublicCard[]};
export type PublicBoard = {
  name: string;
  workspaceName: string;
  bg: {kind: string; color1: string | null; color2: string | null; angle: number};
  lanes: PublicLane[];
};

/**
 * Hashes the caller's address with the site secret (never stored raw, never logged). Kept to 16 hex digits: the
 * Site Cache refuses a key segment that looks like a token (20+ hex digits, platform/cache-guard.ts), and a refused
 * write would silently switch these limits off. 64 bits is plenty to tell visitors apart.
 */
async function ipKey(ip: string): Promise<string> {
  return (await sha256Hex(`${config.jwtSecret ?? ''}|pub-ip|${ip}`)).slice(0, 16);
}

async function bump(key: string, ttl: number): Promise<number> {
  const n = ((await cache.get<number>(key)) ?? 0) + 1;
  await cache.set(key, n, ttl);
  return n;
}

type ContentRow = {
  lane_id: number;
  lane_name: string;
  lane_color: string | null;
  card_count: number;
  shown: boolean;
  title: string | null;
  description: string | null;
  priority: string | null;
  due_date: Date | null;
  checklist_done: number | null;
  checklist_total: number | null;
  labels: unknown;
  people: unknown;
};

/** A json column as an array (drivers hand json back parsed, or as text). */
function jsonList<T>(value: unknown): T[] {
  const v = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(v) ? (v as T[]) : [];
}

const tooMany = (c: {header: (k: string, v: string) => void; json: (b: unknown, s: 429) => Response}, wait: number) => {
  c.header('Retry-After', String(wait));
  return c.json(problem('rate_limited', 'Too many requests. Try again later.'), 429);
};

export const publicBoardRoutes = new Hono().get('/public/boards/:token', withDb, async c => {
  c.header('Cache-Control', 'private, no-cache');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Robots-Tag', 'noindex, nofollow, noarchive');

  const ip = await ipKey(c.req.header('cf-connecting-ip') ?? 'local');
  const viewKey = `pubview:${ip}`;
  const [seen, misses] = await Promise.all([cache.get<number>(viewKey), cache.get<number>(`pubmiss:${ip}`)]);
  const views = (seen ?? 0) + 1;
  // The view is counted after the answer (approximate either way: the cache has no atomic increment).
  await afterResponse(c, 'public board views', () => cache.set(viewKey, views, VIEW_WINDOW_S));
  if (views > VIEW_LIMIT) return tooMany(c, VIEW_WINDOW_S);
  if ((misses ?? 0) >= MISS_LIMIT) return tooMany(c, MISS_WINDOW_S);
  const miss = async () => {
    await bump(`pubmiss:${ip}`, MISS_WINDOW_S);
    return c.json(NOT_FOUND, 404);
  };

  const token = c.req.param('token');
  if (!TOKEN_PATTERN.test(token)) return miss();
  const tokenHash = await sha256Hex(token);

  // Query 1, never cached: the link check (revoke and visibility are immediate).
  const board = await c.var.db.board.findFirst({
    where: {
      shareTokenHash: tokenHash,
      // An expired link answers the same 404 as an unknown one (the expiry is in the where, never checked after loading).
      OR: [{shareExpiresAt: null}, {shareExpiresAt: {gt: new Date()}}],
      visibility: 'public',
      archivedAt: null,
      inboxOf: null,
      workspace: {archivedAt: null},
    },
    select: {
      id: true,
      workspaceId: true,
      rev: true,
      name: true,
      bgKind: true,
      bgColor1: true,
      bgColor2: true,
      bgAngle: true,
      workspace: {select: {name: true}},
    },
  });
  if (!board) return miss();

  // Query 2: the content, keyed by the board's rev (every write bumps it, so no invalidation is needed). ONE statement:
  // the open lanes, the first cards of each (walking the partial open index on (board_id, lane_id, position, id)),
  // descriptions trimmed by the database, and each card's labels and people (names only) beside it.
  const payload = await cache.getOrSet<PublicBoard>(`pubboard:${board.id}:${board.rev}`, CONTENT_TTL_S, async () => {
    const rows = await c.var.db.$queryRaw<ContentRow[]>`
      SELECT x.lane_id, x.lane_name, x.lane_color, x.card_count, (x.id IS NOT NULL AND x.n <= ${MAX_CARDS_TOTAL}::int) AS shown, x.title, x.description, x.priority, x.due_date,
             x.checklist_done, x.checklist_total,
             CASE WHEN x.id IS NULL OR x.n > ${MAX_CARDS_TOTAL}::int THEN NULL ELSE (
               SELECT COALESCE(json_agg(json_build_object('name', t.name, 'color', t.color_hex) ORDER BY t.label_id), '[]'::json)
               FROM (SELECT cl.label_id, lb.name, lb.color_hex FROM card_labels cl JOIN labels lb ON lb.id = cl.label_id
                     WHERE cl.card_id = x.id ORDER BY cl.label_id LIMIT ${MAX_TAGS_PER_CARD}) t
             ) END AS labels,
             CASE WHEN x.id IS NULL OR x.n > ${MAX_CARDS_TOTAL}::int THEN NULL ELSE (
               SELECT COALESCE(json_agg(t.name ORDER BY t.user_id), '[]'::json)
               FROM (SELECT cm.user_id, u.name FROM card_members cm JOIN users u ON u.id = cm.user_id AND u.status = 'active'
                     WHERE cm.card_id = x.id ORDER BY cm.user_id LIMIT ${MAX_TAGS_PER_CARD}) t
             ) END AS people
      FROM (
        SELECT l.id AS lane_id, l.name AS lane_name, l.color_hex AS lane_color, l.card_count, l.ord,
               k.id, k.title, k.description, k.priority, k.due_date, k.checklist_done, k.checklist_total, k.position,
               row_number() OVER (ORDER BY l.ord, k.position, k.id) AS n,
               row_number() OVER (PARTITION BY l.ord ORDER BY k.position, k.id) AS r
        FROM (
          SELECT id, name, color_hex, card_count, row_number() OVER (ORDER BY position, id) AS ord
          FROM lanes
          WHERE workspace_id = ${board.workspaceId} AND board_id = ${board.id} AND archived_at IS NULL
          ORDER BY position, id
          LIMIT ${MAX_LANES}
        ) l
        LEFT JOIN LATERAL (
          SELECT id, title, left(description_md, ${MAX_DESCRIPTION}::int) AS description, priority, due_date,
                 checklist_done, checklist_total, position
          FROM cards
          WHERE board_id = ${board.id} AND lane_id = l.id AND archived_at IS NULL
          ORDER BY position, id
          LIMIT ${MAX_CARDS_PER_LANE}
        ) k ON true
      ) x
      -- Past the total cap only each lane's first row stays (the lane is still listed, with its count, and no card).
      WHERE x.r = 1 OR x.n <= ${MAX_CARDS_TOTAL}::int
      ORDER BY x.ord, x.position, x.id`;
    const lanes = new Map<number, PublicLane>();
    for (const r of rows) {
      let lane = lanes.get(r.lane_id);
      if (!lane) lanes.set(r.lane_id, (lane = {name: r.lane_name, color: hexOrNull(r.lane_color), cardCount: r.card_count, cards: []}));
      if (!r.shown || r.title === null) continue; // a lane with no card shown
      lane.cards.push({
        title: r.title,
        description: r.description ?? '',
        priority: r.priority ?? 'none',
        dueDate: r.due_date ? r.due_date.toISOString().slice(0, 10) : null,
        checklistDone: r.checklist_done ?? 0,
        checklistTotal: r.checklist_total ?? 0,
        labels: jsonList<{name: string; color?: string | null}>(r.labels).map(x => ({name: x.name, color: hexOrNull(x.color)})),
        people: jsonList<string | null>(r.people).map(name => publicName(name) ?? '').filter(Boolean),
      });
    }
    return {
      name: board.name,
      workspaceName: board.workspace.name,
      bg: {kind: board.bgKind, color1: hexOrNull(board.bgColor1), color2: hexOrNull(board.bgColor2), angle: board.bgAngle},
      // The counter column is kept on every write; never below what is shown.
      lanes: [...lanes.values()].map(l => ({...l, cardCount: Math.max(l.cardCount, l.cards.length)})),
    };
  });
  return c.json({board: payload});
});
