import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import {requireAuth, withDb, withViewer} from '../../platform/guards';
import {currentCursor, EMAIL_MODES, type EmailMode} from '../jobs/notification-email';
import {mailConfigured} from '../mail/send';
import {invalid, objectOf} from '../validation';

/**
 * The signed-in person's own notification email setting (Phase 12). Default `off`. Own row only (`userId` is the viewer's);
 * no address is read or returned here.
 *   GET   /notification-email   {mode, available}   `available` false when the owner has not set up mail
 *   PATCH /notification-email   {mode}              'off' | 'digest' | 'immediate'
 * Switching on from off starts the cursor at the newest notification, so old ones are never mailed. `emailNotifiedAt` is
 * never reset here, so switching off and on cannot dodge the one-email-per-hour limit.
 */
const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

const body = validator('json', (value, c) => {
  const mode = objectOf(value)?.mode;
  if (typeof mode !== 'string' || !(EMAIL_MODES as readonly string[]).includes(mode)) {
    return invalid(c, {mode: {code: 'invalid', message: 'Choose off, digest or immediate.'}});
  }
  return {mode: mode as EmailMode};
});

export const notificationEmailRoutes = new Hono()
  .use('/notification-email', noStore)
  .get('/notification-email', withViewer, requireAuth, withDb, async c => {
    const row = await c.var.db.userProfile.findUnique({where: {userId: c.var.viewer.id!}, select: {emailNotifyMode: true}});
    return c.json({mode: (row?.emailNotifyMode ?? 'off') as EmailMode, available: mailConfigured()});
  })
  .patch('/notification-email', body, withViewer, requireAuth, withDb, async c => {
    const {db, viewer} = c.var;
    const userId = viewer.id!;
    const {mode} = c.req.valid('json');
    const before = await db.userProfile.findUnique({where: {userId}, select: {emailNotifyMode: true}});
    const wasOff = !before || before.emailNotifyMode === 'off';
    const data = mode === 'off' ? {emailNotifyMode: 'off'} : wasOff ? {emailNotifyMode: mode, emailNotifyCursor: await currentCursor(db, userId)} : {emailNotifyMode: mode};
    const row = await db.userProfile.upsert({where: {userId}, create: {userId, ...data}, update: data, select: {emailNotifyMode: true}});
    return c.json({mode: row.emailNotifyMode as EmailMode, available: mailConfigured()});
  });
