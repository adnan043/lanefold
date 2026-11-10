import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import {audit} from '../../platform/auth';
import {problem, requireAuth, withDb, withViewer} from '../../platform/guards';
import {invalid, LOCALES, idOf, objectOf, textField, type FieldError} from '../validation';
import {notFound, requireWorkspaceRole} from '../workspaces';

/**
 * Workspace settings and the viewer's preferences.
 *   PATCH /workspaces/:id            {name}      rename (admin+, audited)
 *   POST  /workspaces/:id/transfer   {userId}    hand ownership to an existing member (owner only, one transaction)
 *   GET   /preferences                           the viewer's locale, theme, density (user_profiles; defaults when none)
 *   PATCH /preferences               {locale?, themeMode?, density?, fontScale?, radius?, reduceMotion?}   saved for the signed-in user only
 *   GET   /workspaces/archived                  my archived workspaces (owner only)
 *   POST  /workspaces/:id/archive    {confirmName}  hide and close it (owner only, typed name; reversible, nothing deleted)
 *   POST  /workspaces/:id/restore                   open it again (owner only)
 * There is no hard delete: only 4 of the ~20 tables that hang off a workspace have a foreign key, so a delete
 * would orphan rows. Archive is the owner's "delete" (owner-actions.md decision 4); membership() answers 404
 * for an archived workspace to everyone, so every other route is closed by the same query.
 */

export const THEMES = ['light', 'dark', 'system', 'contrast'] as const;
export const DENSITIES = ['compact', 'comfortable', 'spacious'] as const;
export const RADII = ['sharp', 'soft', 'round'] as const;
export const FONT_SCALES = [100, 112, 125, 150] as const;
const PREF_SELECT = {locale: true, themeMode: true, density: true, fontScale: true, radius: true, reduceMotion: true} as const;
const DEFAULT_PREFS = {locale: 'en', themeMode: 'system', density: 'comfortable', fontScale: 100, radius: 'soft', reduceMotion: false};

const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

class Refuse extends Error {
  constructor(readonly status: 403 | 404 | 409, readonly code: string, message: string) {
    super(message);
  }
}

const renameBody = validator('json', (value, c) => {
  const name = textField(objectOf(value)?.name, 1, 80);
  if (!name.ok) return invalid(c, {name: name.error});
  return {name: name.value};
});

const transferBody = validator('json', (value, c) => {
  const raw = objectOf(value)?.userId;
  const userId = typeof raw === 'number' && Number.isSafeInteger(raw) ? idOf(String(raw)) : undefined;
  if (!userId) return invalid(c, {userId: {code: 'invalid', message: 'Choose a member of this workspace.'}});
  return {userId};
});

const archiveBody = validator('json', (value, c) => {
  const name = textField(objectOf(value)?.confirmName, 1, 80);
  if (!name.ok) return invalid(c, {confirmName: name.error});
  return {confirmName: name.value};
});

const prefsBody = validator('json', (value, c) => {
  const body = objectOf(value) ?? {};
  const errors: Record<string, FieldError> = {};
  const out: {locale?: string; themeMode?: string; density?: string; fontScale?: number; radius?: string; reduceMotion?: boolean} = {};
  if (body.locale !== undefined) {
    if (typeof body.locale === 'string' && (LOCALES as readonly string[]).includes(body.locale)) out.locale = body.locale;
    else errors.locale = {code: 'invalid', message: 'Choose one of the available languages.'};
  }
  if (body.themeMode !== undefined) {
    if (typeof body.themeMode === 'string' && (THEMES as readonly string[]).includes(body.themeMode)) out.themeMode = body.themeMode;
    else errors.themeMode = {code: 'invalid', message: 'Choose light, dark, system or contrast.'};
  }
  if (body.density !== undefined) {
    if (typeof body.density === 'string' && (DENSITIES as readonly string[]).includes(body.density)) out.density = body.density;
    else errors.density = {code: 'invalid', message: 'Choose compact, comfortable or spacious.'};
  }
  if (body.fontScale !== undefined) {
    if (typeof body.fontScale === 'number' && (FONT_SCALES as readonly number[]).includes(body.fontScale)) out.fontScale = body.fontScale;
    else errors.fontScale = {code: 'invalid', message: 'Choose a text size from the list.'};
  }
  if (body.radius !== undefined) {
    if (typeof body.radius === 'string' && (RADII as readonly string[]).includes(body.radius)) out.radius = body.radius;
    else errors.radius = {code: 'invalid', message: 'Choose sharp, soft or round.'};
  }
  if (body.reduceMotion !== undefined) {
    if (typeof body.reduceMotion === 'boolean') out.reduceMotion = body.reduceMotion;
    else errors.reduceMotion = {code: 'invalid', message: 'Choose on or off.'};
  }
  if (Object.keys(errors).length) return invalid(c, errors);
  if (Object.keys(out).length === 0) return invalid(c, {input: {code: 'required', message: 'Choose something to change.'}});
  return out;
});

export const workspaceSettingsRoutes = new Hono()
  .use('/workspaces/*', noStore)
  .use('/preferences', noStore)

  .patch('/workspaces/:id', renameBody, withViewer, requireAuth, withDb, requireWorkspaceRole('admin'), async c => {
    const {db, workspaceId, viewer} = c.var;
    const {name} = c.req.valid('json');
    const row = await db.workspace.update({where: {id: workspaceId}, data: {name}, select: {id: true, name: true, slug: true}});
    await audit(db, {actorUserId: viewer.id, action: 'workspace.renamed', target: ['workspace', workspaceId], meta: {}});
    return c.json({workspace: row});
  })

  .post('/workspaces/:id/transfer', transferBody, withViewer, requireAuth, withDb, requireWorkspaceRole('owner'), async c => {
    const {db, workspaceId, viewer} = c.var;
    const {userId: targetId} = c.req.valid('json');
    if (targetId === viewer.id) return c.json(problem('invalid_target', 'You already own this workspace.'), 409);
    try {
      await db.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
        // Both writes are conditional on the roles we expect, inside the lock: a concurrent change is a 409.
        const target = await tx.workspaceMember.updateMany({where: {workspaceId, userId: targetId}, data: {role: 'owner'}});
        if (target.count === 0) throw new Refuse(404, 'not_found', 'No such member.');
        const me = await tx.workspaceMember.updateMany({where: {workspaceId, userId: viewer.id!, role: 'owner'}, data: {role: 'admin'}});
        if (me.count === 0) throw new Refuse(409, 'conflict', 'Ownership changed. Reload and try again.');
      });
    } catch (err) {
      if (err instanceof Refuse) return c.json(problem(err.code, err.message), err.status as 404 | 409);
      throw err;
    }
    await audit(db, {actorUserId: viewer.id, action: 'workspace.ownership_transferred', target: ['workspace', workspaceId], meta: {to: targetId}});
    return c.json({workspaceId, ownerId: targetId, yourRole: 'admin'});
  })

  // Registered before any `/workspaces/:id` GET. The owner's own archived workspaces only (the role is in the where).
  .get('/workspaces/archived', withViewer, requireAuth, withDb, async c => {
    const rows = await c.var.db.workspaceMember.findMany({
      where: {userId: c.var.viewer.id!, role: 'owner', workspace: {archivedAt: {not: null}}},
      select: {workspace: {select: {id: true, name: true, archivedAt: true}}},
      orderBy: {workspaceId: 'asc'},
      take: 50,
    });
    return c.json({items: rows.map(r => ({id: r.workspace.id, name: r.workspace.name, archivedAt: r.workspace.archivedAt!.toISOString()}))});
  })

  .post('/workspaces/:id/archive', archiveBody, withViewer, requireAuth, withDb, requireWorkspaceRole('owner'), async c => {
    const {db, workspaceId, viewer} = c.var;
    const ws = await db.workspace.findFirst({where: {id: workspaceId, archivedAt: null}, select: {name: true}});
    if (!ws) return notFound(c);
    if (c.req.valid('json').confirmName.trim() !== ws.name) {
      return invalid(c, {confirmName: {code: 'invalid', message: 'Type the workspace name exactly to confirm.'}});
    }
    // The owner check is IN the update's where, not only in the guard: a role that changed meanwhile updates nothing.
    const {count} = await db.workspace.updateMany({
      where: {id: workspaceId, archivedAt: null, members: {some: {userId: viewer.id!, role: 'owner'}}},
      data: {archivedAt: new Date(), archivedBy: viewer.id!},
    });
    if (count === 0) return notFound(c);
    await audit(db, {actorUserId: viewer.id, action: 'workspace.archived', target: ['workspace', workspaceId], meta: {}});
    return c.json({workspaceId, archived: true});
  })

  // Not behind requireWorkspaceRole (it hides archived workspaces): the owner role and the archived state are in the where.
  .post('/workspaces/:id/restore', withViewer, requireAuth, withDb, async c => {
    const {db, viewer} = c.var;
    const workspaceId = idOf(c.req.param('id'));
    if (!workspaceId) return notFound(c);
    const {count} = await db.workspace.updateMany({
      where: {id: workspaceId, archivedAt: {not: null}, members: {some: {userId: viewer.id!, role: 'owner'}}},
      data: {archivedAt: null, archivedBy: null},
    });
    if (count === 0) return notFound(c);
    await audit(db, {actorUserId: viewer.id, action: 'workspace.restored', target: ['workspace', workspaceId], meta: {}});
    return c.json({workspaceId, archived: false});
  })

  .get('/preferences', withViewer, requireAuth, withDb, async c => {
    const row = await c.var.db.userProfile.findUnique({where: {userId: c.var.viewer.id!}, select: PREF_SELECT});
    return c.json({preferences: row ?? DEFAULT_PREFS});
  })

  .patch('/preferences', prefsBody, withViewer, requireAuth, withDb, async c => {
    const userId = c.var.viewer.id!;
    const data = c.req.valid('json');
    const row = await c.var.db.userProfile.upsert({where: {userId}, create: {userId, ...data}, update: data, select: PREF_SELECT});
    return c.json({preferences: row});
  });

