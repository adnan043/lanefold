import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

/** Where every sign-in lands (src/platform/auth/after-sign-in.ts), against the real Site API and Postgres. */
const PASSWORD = 'a long test passphrase';

describe.skipIf(!DATABASE_URL)('where a sign-in lands (integration, real Postgres)', () => {
  beforeAll(configureEnv);
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  const login = (browser: Browser, email: string, next?: string) =>
    browser.post('/site-api/auth/login', {email, password: PASSWORD, ...(next === undefined ? {} : {next})});

  async function admin(email: string) {
    const browser = await signedIn(app, email);
    const id = (await db.user.findUniqueOrThrow({where: {email}, select: {id: true}})).id;
    await db.userRole.create({data: {user: {connect: {id}}, role: {connect: {slug: 'admin'}}}});
    await browser.post('/site-api/auth/logout');
    return browser;
  }

  it('an admin goes to the admin home unless next is already in the admin', async () => {
    const browser = await admin('ada@example.com');
    expect((await login(browser, 'ada@example.com')).json.next).toBe('/dashboard/');
    expect((await login(browser, 'ada@example.com', '/dashboard')).json.next).toBe('/dashboard/');
    expect((await login(browser, 'ada@example.com', '/jobs/')).json.next).toBe('/dashboard/');
    expect((await login(browser, 'ada@example.com', '/dashboard/users')).json.next).toBe('/dashboard/users');
    expect((await login(browser, 'ada@example.com', '/portal/roles')).json.next).toBe('/portal/roles');
    expect((await login(browser, 'ada@example.com', 'https://evil.example/')).json.next).toBe('/dashboard/');
  });

  it('a member goes where they were going, as before', async () => {
    const browser = await signedIn(app, 'mo@example.com');
    await browser.post('/site-api/auth/logout');
    expect((await login(browser, 'mo@example.com')).json.next).toBe('/dashboard');
    expect((await login(browser, 'mo@example.com', '/jobs/')).json.next).toBe('/jobs/');
    expect((await login(browser, 'mo@example.com', '//evil.example/')).json.next).toBe('/dashboard');
  });
});
