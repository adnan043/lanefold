import {readFileSync} from 'node:fs';

import {env} from 'cloudflare:workers';
import {afterEach, describe, expect, it} from 'vitest';

// @ts-expect-error: a plain Node script, no type declarations.
import {catalogueEntries, DEMO_ROLE, demoLoginSql, demoPasswordHash} from '../scripts/platform.mjs';
import {config} from '../src/platform/config';
import {verifyPassword} from '../src/platform/auth/password';

const sources = [
  readFileSync(new URL('../src/platform/auth/codenames.ts', import.meta.url), 'utf8'),
  readFileSync(new URL('../src/server/permissions.ts', import.meta.url), 'utf8'),
];

describe('npm run platform -- demo-login (docs/agent/store-apps.md)', () => {
  it('hashes the password the way the sign-in checks it', async () => {
    const hash = await demoPasswordHash('a long demo password');
    expect(hash).toMatch(/^scrypt\$v1\$16384\$8\$5\$/);
    expect(await verifyPassword('a long demo password', hash)).toEqual({ok: true, needsRehash: false});
    expect((await verifyPassword('another password', hash)).ok).toBe(false);
  });

  it('reads the catalogue: every codename, with its title, group and default roles', () => {
    const entries = catalogueEntries(sources);
    const byCode = new Map(entries.map((e: {codename: string}) => [e.codename, e]));
    expect(byCode.get('site:user:read')).toMatchObject({title: 'See users', group: 'Users'});
    expect(byCode.get('site:workspace:read')).toMatchObject({title: 'See workspaces', group: 'Workspaces', roles: ['admin']}); // Lanefold: no sample jobs
    expect(byCode.has('*')).toBe(true);
  });

  it('gives the demo role read and view permissions only, and the user that role', async () => {
    const sql = demoLoginSql({email: 'demo@example.com', passwordHash: await demoPasswordHash('a long demo password'), entries: catalogueEntries(sources)});
    const granted = /[J]OIN "permissions" p ON p\."codename" IN \(([^)]*)\)\nWHERE r\."slug" = 'demo-read-only'/.exec(sql)?.[1] ?? '';
    expect(granted).toContain("'site:user:read'");
    expect(granted).toContain("'site:role:read'");
    expect(granted).toContain("'site:audit:read'");
    expect(granted).not.toMatch(/manage|update|\*'/);
    expect(sql).toContain(`'${DEMO_ROLE.slug}'`);
    expect(sql).toContain("'demo@example.com'");
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
    // Data only: never anything the platform refuses in this file.
    const code = sql.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");
    expect(code).not.toMatch(/\b(CREATE|ALTER|DROP|TRUNCATE|DELETE|GRANT|COPY|WITH|EXECUTE)\b/i);
    expect(code).not.toMatch(/\$\$/);
    for (const statement of code.split(';').map(s => s.trim()).filter(Boolean)) {
      expect(statement).toMatch(/^(BEGIN|COMMIT|INSERT INTO [\s\S]*ON CONFLICT|UPDATE )/);
    }
  });

  it('refuses a catalogue with nothing to read', () => {
    expect(() => demoLoginSql({email: 'demo@example.com', passwordHash: 'x', entries: []})).toThrow(/no read or view/);
  });
});

describe('config.demoLogin (SITE_DEMO_LOGIN, the store previews only)', () => {
  afterEach(() => {
    delete env.SITE_DEMO_LOGIN;
  });
  it('is null when unset: a real install shows nothing', () => {
    expect(config.demoLogin).toBeNull();
  });
  it('reads {email, password}', () => {
    env.SITE_DEMO_LOGIN = JSON.stringify({email: 'demo@example.com', password: 'a long demo password'});
    expect(config.demoLogin).toEqual({email: 'demo@example.com', password: 'a long demo password'});
  });
  it('ignores anything else', () => {
    for (const value of ['not json', '{"email":1,"password":"x"}', '{"email":"no-at","password":"x"}', '{"email":"a@b.c","password":""}', 'null']) {
      env.SITE_DEMO_LOGIN = value;
      expect(config.demoLogin, value).toBeNull();
    }
  });
});
