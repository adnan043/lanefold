import {Hono} from 'hono';

import {problem, withDb} from '../../platform/guards';
import {cache} from '../../platform/cache';
import {config} from '../../platform/config';

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
const MAX_CARDS_PER_LANE = 200;
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
export type PublicLane = {name: string; color: string | null; cardCount: number; cards: PublicCard[]};
export type PublicBoard = {
  name: string;
  workspaceName: string;
  bg: {kind: string; color1: string | null; color2: string | null; angle: number};
  lanes: PublicLane[];
};

/** Hashes the caller's address with the site secret (never stored raw, never logged). */
async function ipKey(ip: string): Promise<string> {
  return (await sha256Hex(`${config.jwtSecret ?? ''}|pub-ip|${ip}`)).slice(0, 40);
}

async function bump(key: string, ttl: number): Promise<number> {
  const n = ((await cache.get<number>(key)) ?? 0) + 1;
  await cache.set(key, n, ttl);
  return n;
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
  const [views, misses] = await Promise.all([
    bump(`pubview:${ip}`, VIEW_WINDOW_S),
    cache.get<number>(`pubmiss:${ip}`),
  ]);
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

  // Query 2 (+3): the content, keyed by the board's rev (every write bumps it, so no invalidation is needed).
  const payload = await cache.getOrSet<PublicBoard>(`pubboard:${board.id}:${board.rev}`, CONTENT_TTL_S, async () => {
    const lanes = await c.var.db.lane.findMany({
      where: {boardId: board.id, archivedAt: null},
      orderBy: [{position: 'asc'}, {id: 'asc'}],
      take: MAX_LANES,
      select: {
        name: true,
        colorHex: true,
        cards: {
          where: {archivedAt: null},
          orderBy: [{position: 'asc'}, {id: 'asc'}],
          take: MAX_CARDS_PER_LANE,
          select: {
            title: true,
            descriptionMd: true,
            priority: true,
            dueDate: true,
            checklistDone: true,
            checklistTotal: true,
            labels: {take: MAX_TAGS_PER_CARD, select: {label: {select: {name: true, colorHex: true}}}},
            members: {take: MAX_TAGS_PER_CARD, select: {userId: true}},
          },
        },
      },
    });
    const ids = [...new Set(lanes.flatMap(l => l.cards.flatMap(card => card.members.map(m => m.userId))))];
    const users = ids.length
      ? await c.var.db.user.findMany({where: {id: {in: ids}}, select: {id: true, name: true}, take: 5000})
      : [];
    const names = new Map(users.map(u => [u.id, publicName(u.name)]));
    return {
      name: board.name,
      workspaceName: board.workspace.name,
      bg: {kind: board.bgKind, color1: hexOrNull(board.bgColor1), color2: hexOrNull(board.bgColor2), angle: board.bgAngle},
      lanes: lanes.map(l => ({
        name: l.name,
        color: hexOrNull(l.colorHex),
        cardCount: l.cards.length,
        cards: l.cards.map(card => ({
          title: card.title,
          description: card.descriptionMd.slice(0, MAX_DESCRIPTION),
          priority: card.priority,
          dueDate: card.dueDate ? card.dueDate.toISOString().slice(0, 10) : null,
          checklistDone: card.checklistDone,
          checklistTotal: card.checklistTotal,
          labels: card.labels.map(x => ({name: x.label.name, color: hexOrNull(x.label.colorHex)})),
          people: card.members.map(m => names.get(m.userId) ?? '').filter(Boolean),
        })),
      })),
    };
  });
  return c.json({board: payload});
});
