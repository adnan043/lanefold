import {abilitiesOf, type AbilitiesOf, codenamesOf, CORE_PERMISSIONS, definePermissions} from '../platform/auth/codenames';

/**
 * THE permission catalogue: every codename this site checks, declared ONCE.
 * Adding a permission is one entry here, plus its line in tests/permissions.test.ts
 * (docs/agent/roles-and-permissions.md):
 *
 *   - `PERMISSIONS.<KEY>` is its codename, for `requirePermission` / `can`;
 *   - `ability` adds a flag to `/me` `abilities` (and to the `Abilities` type)
 *     for the UI: portal nav items, buttons, `pageContext()` pages;
 *   - the row reaches the `permissions` table (the roles screen) on the next
 *     signed-in request after deploy, and `roles` get it that first time only
 *     (`src/platform/permission-sync.ts`). No migration.
 *   - tests/permissions.test.ts lists every shipped codename and ability, so
 *     `npm test` fails until you add the new one there too (on purpose: a
 *     renamed or lost permission never slips through).
 *
 * Never rename or reuse a shipped codename: roles hold it by name. Browser-safe
 * (no server imports): the portal reads the `Abilities` type from here.
 */
export const CATALOGUE = definePermissions({
  ...CORE_PERMISSIONS,
  /** Switch the billing mode and read billing settings (`/dashboard` Billing). Owners only. */
  BILLING_MANAGE: {
    codename: 'site:billing:manage',
    title: 'Manage billing',
    description: 'Switch the billing mode (paid or free for all) and the grace period.',
    group: 'Billing',
    ability: 'manageBilling',
  },
  /** Edit what each plan includes (`/dashboard` Plan limits). Owners only. */
  PLANS_MANAGE: {
    codename: 'site:plans:manage',
    title: 'Manage plan limits',
    description: 'Edit members, file size, storage and feature limits of each plan.',
    group: 'Billing',
    ability: 'managePlans',
  },
  /** See every workspace (`/dashboard` Workspaces); each access is audited. */
  WORKSPACE_READ: {
    codename: 'site:workspace:read',
    title: 'See workspaces',
    description: 'Open the list of all workspaces and their summaries. Every access is audited.',
    group: 'Workspaces',
    ability: 'readWorkspaces',
    roles: ['admin'],
  },
  /**
   * Create, rotate or revoke the public read-only link of a board (also needs board admin). A site-wide switch.
   * NOT under `site:`: every member holds it, and the platform treats any `site:` codename as an admin power
   * (it strips such roles from everyone when the site changes owner). Renamed from `site:board:share` by
   * migration 20261113120000_member_permissions_out_of_site.
   */
  BOARD_SHARE: {
    codename: 'board:share',
    title: 'Share boards publicly',
    description: 'Create, replace or remove the public read-only link of a board. Board admins only.',
    group: 'Boards',
    ability: 'shareBoards',
    roles: ['member', 'admin'],
  },
  /** Create, edit, switch and delete a board's Flows (automations); also needs board admin. A site-wide switch. Not under `site:`, like BOARD_SHARE. */
  BOARD_FLOWS: {
    codename: 'board:flows',
    title: 'Manage board Flows',
    description: 'Create, edit, switch on or off and delete the automations (Flows) of a board. Board admins only.',
    group: 'Boards',
    ability: 'manageFlows',
    roles: ['member', 'admin'],
  },
  /** The site-wide maintenance message. Owners only. */
  MAINTENANCE_MANAGE: {
    codename: 'site:maintenance:manage',
    title: 'Manage the maintenance message',
    description: 'Show or clear the site-wide maintenance message.',
    group: 'Billing',
    ability: 'manageMaintenance',
  },
  /** The site's brand colour (`/dashboard` Branding): website, dashboard and app. Owners only. */
  BRANDING_MANAGE: {
    codename: 'site:branding:manage',
    title: 'Manage branding',
    description: 'Change the brand colour of the website, the dashboard and the app.',
    group: 'Site',
    ability: 'manageBranding',
  },
});

/** Codenames by key: `PERMISSIONS.BILLING_MANAGE` is `'site:billing:manage'`. */
export const PERMISSIONS = codenamesOf(CATALOGUE);

export type Codename = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** What the UI may SHOW the visitor (`/me`); every route checks again. */
export type Abilities = AbilitiesOf<typeof CATALOGUE>;

/** The abilities a set of granted codenames gives (`/me`). */
export const abilitiesFor = (permissions: ReadonlySet<string>): Abilities => abilitiesOf(CATALOGUE, permissions);

/** A guest's abilities: every flag false. */
export const NO_ABILITIES: Abilities = abilitiesFor(new Set());
