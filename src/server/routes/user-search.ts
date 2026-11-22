import {Hono} from 'hono';
import {validator} from 'hono/validator';

import type {PrismaClient} from '../../generated/prisma/client';
import {CORE, getAccess, SYSTEM_ROLES} from '../../platform/auth';
import {maskEmail} from '../../platform/auth/admin';
import {requireAuth, requirePermission, withAuthCore, withViewer} from '../../platform/guards';
import type {AdminUser, Viewer} from '../../platform/types';

/**
 * `GET /site-api/user-search?before=&q=&status=` (site:user:read): the dashboard's Users list with a free-text
 * search. Same answer shape, page size, order and email rules as the template's `GET /admin/users`, which
 * matches an email exactly and has no free text; that route stays as it is (src/platform/ is managed).
 *
 * `q` matches part of a name, any case. Only the site owner, who sees every address anyway, also matches part
 * of an email: for anyone else it would let them probe addresses they are shown masked. The owner's own
 * account holds only a placeholder address and never matches by email.
 */

type Env = {Variables: {db: PrismaClient; secret: string; viewer: Viewer}};

const PAGE = 25; // the same page as /admin/users
const Q_MAX = 254; // an email's longest form

const userSelect = {
  id: true,
  email: true,
  platformOwnerId: true,
  name: true,
  status: true,
  emailVerifiedAt: true,
  createdAt: true,
  lastLoginAt: true,
  totpEnabledAt: true,
  roles: {select: {role: {select: {slug: true}}}, take: 20},
} as const;

const idOf = (value: string) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const searchQuery = validator('query', value => ({
  before: typeof value.before === 'string' ? value.before : '',
  q: typeof value.q === 'string' ? value.q.trim().slice(0, Q_MAX) : '',
  status: value.status === 'active' || value.status === 'suspended' ? value.status : '',
}));

export const userSearchRoutes = new Hono<Env>().get(
  '/user-search',
  searchQuery,
  withViewer,
  requireAuth,
  requirePermission(CORE.USER_READ),
  withAuthCore,
  async c => {
    const query = c.req.valid('query');
    const before = idOf(query.before);
    const {roles} = await getAccess(c.req.raw);
    const owner = roles.includes(SYSTEM_ROLES.OWNER);
    const me = c.var.viewer.id ?? null;
    const q = query.q;
    const text = q
      ? owner
        ? {OR: [{name: {contains: q, mode: 'insensitive' as const}}, {email: {contains: q.toLowerCase()}, platformOwnerId: null}]}
        : {name: {contains: q, mode: 'insensitive' as const}}
      : {};
    const rows = await c.var.db.user.findMany({
      select: userSelect,
      where: {
        ...text,
        ...(query.status ? {status: query.status} : {}),
        ...(before ? {id: {lt: before}} : {}),
      },
      orderBy: {id: 'desc'},
      take: PAGE + 1,
    });
    const users: AdminUser[] = rows.slice(0, PAGE).map(row => ({
      id: row.id,
      // The owner's account holds only a placeholder address.
      email: row.platformOwnerId ? '' : owner || row.id === me ? row.email : maskEmail(row.email),
      platformOwner: row.platformOwnerId !== null,
      name: row.name,
      status: row.status,
      emailVerified: row.emailVerifiedAt !== null,
      roles: row.roles.map(r => r.role.slug),
      createdAt: row.createdAt.toISOString(),
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      twoFactor: row.totpEnabledAt !== null,
    }));
    c.header('Cache-Control', 'private, no-store');
    return c.json({users, nextBefore: rows.length > PAGE ? users.at(-1)!.id : null});
  }
);
