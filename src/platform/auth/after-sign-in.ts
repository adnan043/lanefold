import type {PrismaClient} from '../../generated/prisma/client';
import {CORE, grants} from './codenames';
import {safeNext} from './input';
import type {AuthSettings} from './settings';

/**
 * WHERE A PERSON LANDS after signing in, by every road (password, emailed code, two-step, sign-up
 * code, the owner's "View as admin", the public demo's demo admin). One rule (owner, 2026-11-15):
 *
 *   someone who can open the admin (the dashboard's Users, Roles or Activity: owner, admin, or any
 *   role holding one of those core permissions) goes to the admin home, `/dashboard/`, unless `next`
 *   is already a deep link into the admin (`/dashboard/…`, or its old address `/portal/…`);
 *   everyone else goes to `next` (a same-site path) or `afterSignInPath`, as before.
 *
 * `next` is only ever a same-site PATH (`safeNext`): never a URL.
 */

/** The admin's home: the dashboard's overview. `/portal/` is its old address and redirects there. */
export const ADMIN_HOME = '/dashboard/';

/** The core permissions behind the admin's own screens (src/portal: Users, Roles, Activity). */
const ADMIN_SCREENS = [CORE.USER_READ, CORE.ROLE_READ, CORE.AUDIT_READ];

/** Does this set of codenames open the admin? */
export const opensAdmin = (permissions: ReadonlySet<string>) => ADMIN_SCREENS.some(codename => grants(permissions, codename));

/** The pure rule: where to go, knowing whether this person can open the admin. */
export function nextAfterSignIn(admin: boolean, next: unknown, settings: Pick<AuthSettings, 'afterSignInPath'>): string {
  if (!admin) return safeNext(next, settings.afterSignInPath);
  const path = safeNext(next, ADMIN_HOME);
  return /^\/(dashboard|portal)\/./.test(path) ? path : ADMIN_HOME;
}

/** The permissions one account's roles grant (one bounded query). */
async function permissionsOf(db: PrismaClient, userId: number): Promise<Set<string>> {
  const rows = await db.userRole.findMany({
    where: {userId},
    select: {role: {select: {permissions: {select: {permission: {select: {codename: true}}}, take: 500}}}},
    take: 50,
  });
  const out = new Set<string>();
  for (const row of rows) for (const grant of row.role.permissions) out.add(grant.permission.codename);
  return out;
}

/** Where `userId`, just signed in, goes next. */
export async function afterSignIn(db: PrismaClient, userId: number, next: unknown, settings: AuthSettings): Promise<string> {
  return nextAfterSignIn(opensAdmin(await permissionsOf(db, userId)), next, settings);
}
