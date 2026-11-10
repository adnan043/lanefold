import {Hono} from 'hono';
import {validator} from 'hono/validator';

import {audit} from '../../platform/auth';
import {requireAuth, requirePermission, withDb, withViewer} from '../../platform/guards';
import {normalizeHex} from '../../portal/ui/contrast';
import {brandCss} from '../../lib/brand';
import {getAppSettings, invalidateAppSettings} from '../entitlements';
import {PERMISSIONS} from '../permissions';
import {invalid, objectOf} from '../validation';

/**
 * The site's brand colour (one value in `app_settings`, read through the Site Cache by `getAppSettings`).
 *
 *   GET /site-api/brand.css   public: the accent tokens for that colour ('' when none), revalidated on every load
 *                             (ETag), so a change is instant. Linked from every layout
 *                             (Base, App), so the website, the dashboard and the app follow it. Holds nothing
 *                             personal, never reads the visitor: shared caching is fine.
 * `site:branding:manage` (/dashboard Branding):
 *   GET /site-api/branding    {brandColor}
 *   PUT /site-api/branding    {brandColor: '#rrggbb' | null}  null = back to the default green
 */

/**
 * brand.css is revalidated on every page load (`no-cache` + an ETag of the colour), so a saved colour shows at
 * once everywhere; an unchanged colour costs a bodiless 304.
 */
const CSS_CACHE = 'public, no-cache';
const etagOf = (brandColor: string | null) => `"brand-${brandColor ? brandColor.slice(1) : 'default'}"`;

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
    const etag = etagOf(brandColor);
    const headers = {'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': CSS_CACHE, ETag: etag};
    if (c.req.header('If-None-Match') === etag) return c.body(null, 304, headers);
    return c.body(brandCss(brandColor), 200, headers);
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
