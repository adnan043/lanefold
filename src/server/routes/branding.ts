import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {audit} from '../../platform/auth';
import {getDb} from '../../platform/db';
import {requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {normalizeHex} from '../../portal/ui/contrast';
import {brandCss} from '../../lib/brand';
import {getAppSettings, invalidateAppSettings} from '../entitlements';
import {PERMISSIONS} from '../permissions';
import {invalid, objectOf} from '../validation';

/**
 * The site's brand colour (one value in `app_settings`, read through the Site Cache by `getAppSettings`).
 *
 *   GET /site-api/brand.css   public: the accent tokens for that colour ('' when none). Linked from every layout
 *                             (Base, App), so the website, the dashboard and the app follow it. Holds nothing
 *                             personal, never reads the visitor: shared caching is fine.
 *                             `?v=<version of the sheet>` (`brandCssHref`, pages rendered on request): cached a year,
 *                             immutable, so the page's first paint never waits on it after the first visit; a saved
 *                             colour is a new `v`. Without `v` (prerendered pages, built once): revalidated on every
 *                             load (ETag), so a change still shows at once there.
 * `site:branding:manage` (/dashboard Branding):
 *   GET /site-api/branding    {brandColor}
 *   PUT /site-api/branding    {brandColor: '#rrggbb' | null}  null = back to the default green
 */

/**
 * The unversioned brand.css is revalidated on every page load (`no-cache` + an ETag of the sheet), so a saved colour
 * shows at once everywhere; an unchanged one costs a bodiless 304. The versioned one never changes: a year, immutable.
 */
const CSS_CACHE = 'public, no-cache';
const CSS_CACHE_VERSIONED = 'public, max-age=31536000, immutable';
export const BRAND_CSS_PATH = '/site-api/brand.css';

/** A short, stable version of a stylesheet's text (FNV-1a, 32 bits): the colour AND how tokens are made from it. */
export function brandVersion(css: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < css.length; i++) {
    h ^= css.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The brand.css link for a page rendered on request: `?v=` of the current sheet, so the browser keeps it for good and
 * the page paints without asking the Worker again. One Site Cache read (`getAppSettings`). Never for a prerendered
 * page: its link would be frozen at build time (those link `BRAND_CSS_PATH`, revalidated). Falls back to that same
 * plain link when the settings cannot be read.
 */
export async function brandCssHref(): Promise<string> {
  const db = getDb();
  if (!db) return BRAND_CSS_PATH;
  try {
    const {brandColor} = await getAppSettings(db);
    return `${BRAND_CSS_PATH}?v=${brandVersion(brandCss(brandColor))}`;
  } catch {
    return BRAND_CSS_PATH;
  }
}

const brandingBody = validator('json', (value, c) => {
  const body = objectOf(value);
  if (!body || !('brandColor' in body)) return invalid(c, {brandColor: {code: 'required', message: 'Choose a colour.'}});
  if (body.brandColor === null) return {brandColor: null};
  const hex = normalizeHex(body.brandColor);
  if (!hex) return invalid(c, {brandColor: {code: 'invalid', message: 'Enter a colour as #rrggbb, for example #1d4ed8.'}});
  return {brandColor: hex};
});

export const brandingRoutes = new Hono()
  .get('/brand.css', withDb, async c => {
    let brandColor: string | null;
    try {
      brandColor = (await getAppSettings(c.var.db)).brandColor;
    } catch {
      // Database or cache down: no brand sheet (and no ETag, so nothing stale is kept). The default green stays.
      return c.body('', 200, {'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store'});
    }
    const css = brandCss(brandColor);
    const version = brandVersion(css);
    const etag = `"brand-${version}"`;
    // A `v` that is not the current sheet (a page rendered before the colour changed): today's sheet, revalidated,
    // never stored for a year under the old version.
    const cacheControl = c.req.query('v') === version ? CSS_CACHE_VERSIONED : CSS_CACHE;
    const headers = {'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': cacheControl, ETag: etag};
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers);
    return c.body(css, 200, headers);
  })

  .get('/branding', withViewer, requireAuth, requirePermission(PERMISSIONS.BRANDING_MANAGE), withDb, async c => {
    const {brandColor} = await getAppSettings(c.var.db);
    c.header('Cache-Control', 'private, no-store');
    return c.json({brandColor});
  })

  .put('/branding', brandingBody, withViewer, requireAuth, requirePermission(PERMISSIONS.BRANDING_MANAGE), withDb, async c => {
    const {brandColor} = c.req.valid('json');
    const db = c.var.db;
    const before = await getAppSettings(db);
    await db.appSettings.upsert({where: {id: 1}, create: {id: 1, brandColor}, update: {brandColor}, select: {id: true}});
    await invalidateAppSettings();
    await audit(db, {
      actorUserId: c.var.viewer.id,
      action: 'branding.color_changed',
      target: ['app_settings', 1],
      meta: {from: before.brandColor, to: brandColor},
    });
    c.header('Cache-Control', 'private, no-store');
    return c.json({brandColor});
  });
