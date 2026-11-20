import {describe, expect, it} from 'vitest';

import {ADMIN_HOME, nextAfterSignIn, opensAdmin} from '../src/platform/auth/after-sign-in';

/** Where a sign-in lands (src/platform/auth/after-sign-in.ts): an admin in the admin, everyone else as asked. */
describe('where a sign-in lands', () => {
  const settings = {afterSignInPath: '/dashboard'};

  it('takes someone who can open the admin to the admin home', () => {
    expect(ADMIN_HOME).toBe('/dashboard/');
    expect(nextAfterSignIn(true, undefined, settings)).toBe('/dashboard/');
    expect(nextAfterSignIn(true, '', settings)).toBe('/dashboard/');
    expect(nextAfterSignIn(true, '/dashboard', settings)).toBe('/dashboard/');
    expect(nextAfterSignIn(true, '/dashboard/', settings)).toBe('/dashboard/');
    expect(nextAfterSignIn(true, '/', settings)).toBe('/dashboard/');
    expect(nextAfterSignIn(true, '/jobs/', settings)).toBe('/dashboard/');
    expect(nextAfterSignIn(true, '/blog/a-post/?x=1', settings)).toBe('/dashboard/');
  });

  it('keeps a deep link into the admin', () => {
    expect(nextAfterSignIn(true, '/dashboard/users', settings)).toBe('/dashboard/users');
    expect(nextAfterSignIn(true, '/dashboard/jobs?status=open', settings)).toBe('/dashboard/jobs?status=open');
    expect(nextAfterSignIn(true, '/portal/roles', settings)).toBe('/portal/roles');
  });

  it('leaves everyone else where they were going', () => {
    expect(nextAfterSignIn(false, undefined, settings)).toBe('/dashboard');
    expect(nextAfterSignIn(false, '/jobs/', settings)).toBe('/jobs/');
    expect(nextAfterSignIn(false, '/dashboard/account', settings)).toBe('/dashboard/account');
    expect(nextAfterSignIn(false, undefined, {afterSignInPath: '/members/'})).toBe('/members/');
  });

  it('never leaves the site, admin or not', () => {
    for (const bad of ['https://evil.example', '//evil.example/dashboard/', '/\\evil.example', 'javascript:alert(1)', '/dashboard/\u0000x']) {
      expect(nextAfterSignIn(true, bad, settings)).toBe('/dashboard/');
      expect(nextAfterSignIn(false, bad, settings)).toBe('/dashboard');
    }
  });

  it('counts the admin screens, by any wildcard, and not app permissions', () => {
    expect(opensAdmin(new Set(['*']))).toBe(true);
    expect(opensAdmin(new Set(['site:*']))).toBe(true);
    expect(opensAdmin(new Set(['site:user:*']))).toBe(true);
    expect(opensAdmin(new Set(['site:role:read']))).toBe(true);
    expect(opensAdmin(new Set(['site:audit:read']))).toBe(true);
    expect(opensAdmin(new Set(['site:job:manage', 'site:post:create_own']))).toBe(false);
    expect(opensAdmin(new Set())).toBe(false);
  });
});
