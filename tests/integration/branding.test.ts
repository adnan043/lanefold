import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {invalidateAppSettings} from '../../src/server/entitlements';
import {type Browser, configureEnv, DATABASE_URL, db, ownerSignedIn, resetDatabase, signedIn, userId} from './support/harness';

/** The brand colour (/dashboard Branding): owners only, validated, audited, served to everyone as brand.css. */

async function setRoles(email: string, ...slugs: string[]) {
  const id = await userId(email);
  const roles = await db.role.findMany({where: {slug: {in: slugs}}, select: {id: true}});
  await db.userRole.deleteMany({where: {userId: id}});
  await db.userRole.createMany({data: roles.map(role => ({userId: id, roleId: role.id}))});
}

async function clearBrand() {
  await db.appSettings.upsert({where: {id: 1}, create: {id: 1}, update: {brandColor: null}, select: {id: true}});
  await invalidateAppSettings();
}

describe.skipIf(!DATABASE_URL)('branding (integration, real Postgres)', () => {
  let owner: Browser;
  let admin: Browser;
  let member: Browser;

  beforeAll(configureEnv);
  afterAll(async () => {
    await clearBrand();
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetDatabase();
    await clearBrand();
    // The site owner: only the platform's "View as admin" makes one (an `owner` role set by hand is removed).
    owner = await ownerSignedIn(app, undefined, '203.0.113.71');
    admin = await signedIn(app, 'brand-admin@example.test', undefined, '203.0.113.72');
    member = await signedIn(app, 'brand-member@example.test', undefined, '203.0.113.73');
    await setRoles('brand-admin@example.test', 'admin');
    await setRoles('brand-member@example.test', 'member');
  });

  it('refuses everyone but owners, reading and writing', async () => {
    for (const who of [admin, member]) {
      expect((await who.get('/site-api/branding')).status).toBe(403);
      expect((await who.request('PUT', '/site-api/branding', {brandColor: '#1d4ed8'})).status).toBe(403);
    }
    expect((await db.appSettings.findUniqueOrThrow({where: {id: 1}})).brandColor).toBeNull();
  });

  it('validates the colour: #rrggbb or null, nothing else', async () => {
    for (const brandColor of ['red', '#fff', '#12345g', '#123456;}', 42, '']) {
      const res = await owner.request('PUT', '/site-api/branding', {brandColor});
      expect(res.status).toBe(422);
    }
    expect((await owner.request('PUT', '/site-api/branding', {})).status).toBe(422);
  });

  it('saves, audits, serves brand.css to anyone, and resets', async () => {
    expect((await owner.get('/site-api/brand.css')).json.text ?? '').toBe('');

    const saved = await owner.request('PUT', '/site-api/branding', {brandColor: '#1D4ED8'});
    expect(saved.status).toBe(200);
    expect(saved.json).toEqual({brandColor: '#1d4ed8'});
    expect((await owner.get('/site-api/branding')).json).toEqual({brandColor: '#1d4ed8'});
    expect(await db.auditEvent.count({where: {action: 'branding.color_changed'}})).toBe(1);

    // Public: a signed-in member (and any visitor) gets the same sheet; it holds nothing personal.
    const css = await member.get('/site-api/brand.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.headers.get('cache-control')).toContain('public');
    expect(css.json.text).toContain('--accent: #1d4ed8;');
    // Revalidated on every load: the same colour is a bodiless 304, a new colour a new ETag (instant everywhere).
    expect(css.headers.get('cache-control')).toContain('no-cache');
    const etag = css.headers.get('etag')!;
    expect((await member.request('GET', '/site-api/brand.css', undefined, {'If-None-Match': etag})).status).toBe(304);
    await owner.request('PUT', '/site-api/branding', {brandColor: '#be123c'});
    const changed = await member.request('GET', '/site-api/brand.css', undefined, {'If-None-Match': etag});
    expect(changed.status).toBe(200);
    expect(changed.json.text).toContain('--accent: #be123c;');

    expect((await owner.request('PUT', '/site-api/branding', {brandColor: null})).json).toEqual({brandColor: null});
    expect((await member.get('/site-api/brand.css')).json.text ?? '').toBe('');
  });
});
