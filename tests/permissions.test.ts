import {describe, expect, it} from 'vitest';

import {
  abilitiesOf,
  allows,
  catalogueProblems,
  CORE,
  definePermissions,
  ownCodename,
  scopeOf,
} from '../src/platform/auth/codenames';
import {type Abilities, abilitiesFor, CATALOGUE, NO_ABILITIES} from '../src/server/permissions';

describe('the permission catalogue', () => {
  it('is well formed', () => {
    expect(catalogueProblems(CATALOGUE)).toEqual([]);
  });

  it('keeps the shipped codenames and ability keys', () => {
    expect(CORE.USER_READ).toBe('site:user:read');
    expect(CORE.USER_UPDATE).toBe('site:user:update');
    expect(CORE.ROLE_READ).toBe('site:role:read');
    expect(CORE.ROLE_UPDATE).toBe('site:role:update');
    expect(CORE.AUDIT_READ).toBe('site:audit:read');
    expect(Object.keys(NO_ABILITIES).sort()).toEqual(
      [
        'editRoles',
        'manageBilling',
        'manageBranding',
        'manageFlows',
        'manageMaintenance',
        'managePlans',
        'manageRoles',
        'manageUsers',
        'readAudit',
        'readWorkspaces',
        'shareBoards',
        'updateUsers',
      ].sort()
    );
    expect(Object.values(NO_ABILITIES).every(v => v === false)).toBe(true);
  });

  it('derives the abilities from granted codenames, wildcards included', () => {
    const owner = abilitiesFor(new Set(['*']));
    expect(Object.values(owner).every(Boolean)).toBe(true);
    const admin = abilitiesFor(new Set(['site:user:*', 'site:role:read', 'site:audit:read']));
    expect(admin).toEqual({
      manageUsers: true,
      updateUsers: true,
      manageRoles: true,
      editRoles: false,
      readAudit: true,
      manageBilling: false,
      managePlans: false,
      readWorkspaces: false,
      manageMaintenance: false,
      manageBranding: false,
      shareBoards: false,
      manageFlows: false,
    } satisfies Abilities);
    // The type is exact: a key nobody declared does not exist.
    // @ts-expect-error not in the catalogue
    void NO_ABILITIES.manageEverything;
  });

  it('keeps branding to owners: no role gets it by default', () => {
    expect(CATALOGUE.BRANDING_MANAGE.codename).toBe('site:branding:manage');
    expect('roles' in CATALOGUE.BRANDING_MANAGE).toBe(false);
  });

  it('gives the member role no `site:` codename (the platform counts those as admin power)', () => {
    // A `site:` codename on `member` makes it an admin role: a change of site owner would sign out every user.
    const onMember = Object.values(CATALOGUE).filter(def => (('roles' in def ? def.roles : undefined) as readonly string[] | undefined)?.includes('member'));
    expect(onMember.length).toBeGreaterThan(0);
    for (const def of onMember) expect(def.codename, def.codename).not.toMatch(/^site:|^\*$/);
  });

  it('lets default members and admins share boards, and nobody else by default', () => {
    expect(CATALOGUE.BOARD_SHARE.codename).toBe('board:share');
    expect(CATALOGUE.BOARD_SHARE.roles).toEqual(['member', 'admin']);
  });

  it('refuses a malformed entry at load', () => {
    expect(() => definePermissions({BAD: {codename: 'Site:Bad', title: 'Bad', group: 'X'}})).toThrow(/bad codename/);
    expect(() =>
      definePermissions({
        A: {codename: 'site:a:read', title: 'A', group: 'X', ability: 'seeA'},
        B: {codename: 'site:a:read', title: 'B', group: 'X', ability: 'seeA'},
      })
    ).toThrow(/declared twice/);
    expect(() => definePermissions({T: {codename: 'site:t:read', title: '', group: 'X'}})).toThrow(/title/);
  });

  it('a new entry is one edit: codename, ability and type follow', () => {
    const site = definePermissions({
      CRM_READ: {codename: 'site:crm:read', title: 'See contacts', group: 'CRM', ability: 'seeContacts', roles: ['admin']},
    });
    const flags = abilitiesOf(site, new Set(['site:crm:*']));
    expect(flags).toEqual({seeContacts: true});
    const typed: {seeContacts: boolean} = flags;
    expect(typed.seeContacts).toBe(true);
  });
});

describe('own-records permissions', () => {
  const ALL = new Set(['site:note:update']);
  const OWN = new Set(['site:note:update_own']);
  const NONE = new Set<string>(['site:note:read']);

  it('names the own variant', () => {
    expect(ownCodename('site:note:update')).toBe('site:note:update_own');
    expect(ownCodename('site:note:update_own')).toBe('site:note:update_own');
  });

  it('scopes all / own / none', () => {
    expect(scopeOf(ALL, 'site:note:update')).toBe('all');
    expect(scopeOf(OWN, 'site:note:update')).toBe('own');
    expect(scopeOf(NONE, 'site:note:update')).toBe('none');
    expect(scopeOf(new Set(['site:note:*']), 'site:note:update')).toBe('all');
    expect(scopeOf(new Set(['*']), 'site:note:update')).toBe('all');
  });

  it('allows the own variant only on the viewer’s own records', () => {
    expect(allows(ALL, 'site:note:update', 7, 99)).toBe(true);
    expect(allows(OWN, 'site:note:update', 7, 7)).toBe(true);
    expect(allows(OWN, 'site:note:update', 7, 99)).toBe(false);
    expect(allows(OWN, 'site:note:update', 7, null)).toBe(false); // nobody's record
    expect(allows(OWN, 'site:note:update', null, null)).toBe(false); // a guest
    expect(allows(OWN, 'site:note:update', 7, undefined)).toBe(false);
    expect(allows(NONE, 'site:note:update', 7, 7)).toBe(false);
  });
});
