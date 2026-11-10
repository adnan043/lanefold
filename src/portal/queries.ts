import {infiniteQueryOptions, queryOptions} from '@tanstack/react-query';

import type {AdminUser, AuditRow, PermissionRow, RoleRow} from '../lib/types';
import {refreshSession} from '../platform/browser';
import {api, read} from './api';
import type {Me} from './shared';

/**
 * Every portal read, ONCE: the screen (`useQuery(x)`) and its route's loader
 * (`queryClient.ensureQueryData(x)`, src/portal/routes.tsx) use the same
 * options, so a hover on a link fetches what the screen will show and the
 * screen renders from the cache. Kept apart from the screens so the routes can
 * import them without pulling the (lazy) screen code into the first bundle.
 *
 * A save invalidates by key prefix (`['users']`, `['roles']`).
 */

/** Who is signed in, and what the portal may SHOW them. Shared by every screen. */
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async () => {
    const me = await read<Me>(api.me.$get());
    // The access token ran out but the refresh token is still there: refresh ONCE.
    if (me.viewer.state === 'returning' && (await refreshSession())) return read<Me>(api.me.$get());
    return me;
  },
  staleTime: 60_000,
});

/** The brand, for the sidebar. Public and cached on the server. */
export const siteQuery = queryOptions({
  queryKey: ['site'],
  queryFn: () => read<{site: {name: string; logo: string | null} | null}>(api.site.$get()),
  staleTime: 5 * 60_000,
});

export const healthQuery = queryOptions({
  queryKey: ['health'],
  queryFn: () => read<{database: boolean; auth: boolean; siteKey: boolean}>(api.health.$get()),
});

export type UsersPage = {users: AdminUser[]; nextBefore: number | null};
export type AuditPage = {events: AuditRow[]; nextBefore: string | null};

/** The overview's tiles: the FIRST page of each list, under the lists' own key prefixes. */
export const firstUsersQuery = queryOptions({
  queryKey: ['users', 'first'],
  queryFn: () => read<UsersPage>(api.admin.users.$get({query: {before: '', email: '', status: ''}})),
});
export const firstAuditQuery = queryOptions({
  queryKey: ['audit', 'first'],
  queryFn: () => read<AuditPage>(api.admin.audit.$get({query: {before: ''}})),
});

/** `/dashboard/users`: every account, newest first, filtered by exact email and status. */
export const usersQuery = (filter: {email: string; status: string}) =>
  infiniteQueryOptions({
    queryKey: ['users', filter],
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam}) =>
      read<UsersPage>(api.admin.users.$get({query: {before: pageParam ?? '', email: filter.email, status: filter.status}})),
    getNextPageParam: last => (last.nextBefore ? String(last.nextBefore) : undefined),
  });

/** `/dashboard/activity`: the audit log, newest first. */
export const auditQuery = infiniteQueryOptions({
  queryKey: ['audit'],
  initialPageParam: undefined as string | undefined,
  queryFn: ({pageParam}) => read<AuditPage>(api.admin.audit.$get({query: {before: pageParam ?? ''}})),
  getNextPageParam: last => last.nextBefore ?? undefined,
});

export const rolesQuery = queryOptions({
  queryKey: ['roles'],
  queryFn: () => read<{roles: RoleRow[]}>(api.admin.roles.$get()),
});

/** The permission catalogue: changes only with a migration. */
export const permissionsQuery = queryOptions({
  queryKey: ['permissions'],
  queryFn: () => read<{permissions: PermissionRow[]}>(api.admin.permissions.$get()),
  staleTime: 5 * 60_000,
});

/** Two-step sign-in, for the account screen. */
export type TwoFactorStatus = {enabled: boolean; recoveryCodesLeft: number; hasPassword: boolean};
export const twoFactorQuery = queryOptions({
  queryKey: ['account', 'two-factor'],
  queryFn: () => read<TwoFactorStatus>(api.auth['two-factor'].$get()),
});

/** The devices signed in to this account (this one marked `current`). */
export type DeviceSession = {id: string; device: string; lastActiveAt: string; current: boolean};
export const sessionsQuery = queryOptions({
  queryKey: ['account', 'sessions'],
  queryFn: () => read<{sessions: DeviceSession[]}>(api.auth.sessions.$get()),
});

/* ------------------------------------------------------------------ billing */

export type PaymentsStatus = {ready: boolean; mode: 'test' | 'live'} | null;
export type PlanInfo = {
  plan: string;
  maxMembers: number;
  maxFileBytes: number;
  storageQuotaBytes: number;
  maxFlows: number;
  auditLog: boolean;
  purchasable: boolean;
};
export type PlanRow = PlanInfo & {priceKey: string; updatedAt: string};
export type MyWorkspace = {
  id: number;
  name: string;
  plan: string;
  role: string;
  memberCount: number;
  storageUsedBytes: number;
  graceUntil: string | null;
};
export type StaffWorkspace = Omit<MyWorkspace, 'role'> & {slug: string; createdAt: string};
export type WorkspaceBilling = {
  workspace: {id: number; name: string; plan: string};
  entitlements: {
    plan: string;
    billingMode: 'PAID' | 'FREE_FOR_ALL';
    limits: {maxMembers: number; maxFileBytes: number; storageQuotaBytes: number; maxFlows: number};
    usage: {members: number; storageUsedBytes: number};
    overLimit: boolean;
    inGrace: boolean;
    graceUntil: string | null;
    readOnly: boolean;
    upgradeUi: boolean;
  };
  plans: PlanInfo[];
  canManage: boolean;
  payments: PaymentsStatus;
};
export type StaffWorkspacesPage = {workspaces: StaffWorkspace[]; nextBefore: number | null};

/** `/dashboard/billing`: the billing mode and the state of the payment account. */
export const billingSettingsQuery = queryOptions({
  queryKey: ['billing', 'settings'],
  queryFn: () => read<{billingMode: 'PAID' | 'FREE_FOR_ALL'; graceDays: number; payments: PaymentsStatus}>(api.billing.settings.$get()),
});

/** The site's brand colour (`/dashboard/branding`); null = the default green. */
export const brandingQuery = queryOptions({
  queryKey: ['branding'],
  queryFn: () => read<{brandColor: string | null}>(api.branding.$get()),
});

/** The workspaces the visitor owns or administers, with their plan. */
export const myWorkspacesQuery = queryOptions({
  queryKey: ['billing', 'mine'],
  queryFn: () => read<{workspaces: MyWorkspace[]}>(api.billing.mine.$get()),
});

/** One workspace's plan, limits, usage and the plans on offer (any member). */
export const workspaceBillingQuery = (id: number) =>
  queryOptions({
    queryKey: ['billing', 'workspace', id],
    queryFn: () => read<WorkspaceBilling>(api.workspaces[':id'].billing.$get({param: {id: String(id)}})),
  });

/** `/dashboard/plans`: every plan's limits. */
export const planLimitsQuery = queryOptions({
  queryKey: ['billing', 'plans'],
  queryFn: () => read<{plans: PlanRow[]}>(api.billing.plans.$get()),
});

/** `/dashboard/workspaces`: every workspace (staff; each load is audited). */
export const staffWorkspacesQuery = infiniteQueryOptions({
  queryKey: ['billing', 'workspaces'],
  initialPageParam: undefined as string | undefined,
  queryFn: ({pageParam}) => read<StaffWorkspacesPage>(api.billing.workspaces.$get({query: {before: (pageParam ?? '') as never}})),
  getNextPageParam: last => (last.nextBefore ? String(last.nextBefore) : undefined),
});

/* ---------------------------------------------- the overview's work view --
 * Lanefold's own reads, scoped to the signed-in person on the server
 * (workspace membership and board visibility are in each route's SQL).
 * Same keys as the app's (src/app/queries.ts), so both share the cache.
 */
export type OverviewWorkspace = {id: number; name: string; slug: string; plan: string; memberCount: number; role: string};
export type OverviewCard = {
  id: number;
  number?: number | null;
  title: string;
  priority: string;
  dueDate: string | null;
  group: 'overdue' | 'today' | 'next7' | 'later' | 'none';
  workspaceName: string;
  boardId: number;
  boardName: string;
  laneName: string;
};

/** The workspaces I belong to (at most 50), with my role in each. */
export const overviewWorkspacesQuery = queryOptions({
  queryKey: ['workspaces'],
  queryFn: () => read<{items: OverviewWorkspace[]}>(api.workspaces.$get()).then(r => r.items),
  staleTime: 60_000,
});

/** My open, assigned cards grouped by due date; `today` is the visitor's own calendar day. */
export const overviewMyDayQuery = (today: string) =>
  queryOptions({
    queryKey: ['my-day', today],
    queryFn: () => read<{today: string; truncated: boolean; items: OverviewCard[]}>(api['my-day'].$get({query: {today}})),
    staleTime: 30_000,
  });

/** My unread notifications: exact up to 99, then `more`. */
export const unreadCountQuery = queryOptions({
  queryKey: ['notifications', 'unread-count'],
  queryFn: () => read<{count: number; more: boolean}>(api.notifications['unread-count'].$get()),
  staleTime: 30_000,
});
