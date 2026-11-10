import {Hono} from 'hono';
import {createMiddleware} from 'hono/factory';
import {validator} from 'hono/validator';

import {requireAuth, withDb, withViewer} from '../../platform/guards';
import {MAX_HOUR, MIN_HOUR, validTimeZone} from '../jobs/morning-digest';
import {mailConfigured} from '../mail/send';
import {invalid, objectOf} from '../validation';

/**
 * The signed-in person's own morning digest setting (opt-in, default off). Own row only (`userId` is the viewer's);
 * no address is read or returned.
 *   GET   /morning-digest   {hour, timezone, mailConfigured, emailOn}   `hour` null = off; the email part needs mail set up by the owner AND the person's notification emails on
 *   PATCH /morning-digest   {hour: 5..12 | null, timezone?}    null switches it off; `timezone` is the browser's IANA zone (UTC when missing)
 * Switching it off keeps the last day made, so off and on again cannot make a second digest the same local day.
 */
const noStore = createMiddleware(async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

const body = validator('json', (value, c) => {
  const raw = objectOf(value);
  const hour = raw?.hour;
  if (hour !== null && (typeof hour !== 'number' || !Number.isInteger(hour) || hour < MIN_HOUR || hour > MAX_HOUR)) {
    return invalid(c, {hour: {code: 'invalid', message: `Choose a time between ${MIN_HOUR}:00 and ${MAX_HOUR}:00, or off.`}});
  }
  const tz = raw?.timezone;
  if (tz !== undefined && tz !== null && !validTimeZone(tz)) {
    return invalid(c, {timezone: {code: 'invalid', message: 'That time zone is not valid.'}});
  }
  return {hour: hour as number | null, timezone: typeof tz === 'string' ? tz : null};
});

export const morningDigestRoutes = new Hono()
  .use('/morning-digest', noStore)
  .get('/morning-digest', withViewer, requireAuth, withDb, async c => {
    const row = await c.var.db.userProfile.findUnique({where: {userId: c.var.viewer.id!}, select: {digestHour: true, digestTz: true, emailNotifyMode: true}});
    return c.json({hour: row?.digestHour ?? null, timezone: row?.digestTz ?? null, mailConfigured: mailConfigured(), emailOn: (row?.emailNotifyMode ?? 'off') !== 'off'});
  })
  .patch('/morning-digest', body, withViewer, requireAuth, withDb, async c => {
    const {db, viewer} = c.var;
    const userId = viewer.id!;
    const {hour, timezone} = c.req.valid('json');
    const data = hour === null ? {digestHour: null} : {digestHour: hour, digestTz: timezone};
    const row = await db.userProfile.upsert({where: {userId}, create: {userId, ...data}, update: data, select: {digestHour: true, digestTz: true, emailNotifyMode: true}});
    return c.json({hour: row.digestHour, timezone: row.digestTz, mailConfigured: mailConfigured(), emailOn: row.emailNotifyMode !== 'off'});
  });
