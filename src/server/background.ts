import {defineBackground} from '../platform/background';
import {getDb} from '../platform/db';
import {scheduledJobs} from './jobs';
import {NOTIFICATION_EMAIL_LIST, runNotificationEmails} from './jobs/notification-email';
import {DUE_REMINDERS_LIST, TIMED_REMINDER_LIST, runDueReminders, runTimedReminder} from './jobs/due-reminders';
import {FLOWS_LIST, runDailyFlows} from './jobs/flows';
import {MORNING_DIGEST_LIST, runMorningDigest} from './jobs/morning-digest';
import {STALE_CARDS_LIST, runStaleCards} from './jobs/stale-cards';
import {INVITE_EMAIL_LIST, runInviteEmails} from './jobs/invite-email';
import {RECURRING_CARDS_LIST, runRecurringCards} from './jobs/recurring-cards';

/**
 * This site's BACKGROUND JOBS: one handler per list (docs/agent/background-jobs.md).
 *
 *   send:      sendJob(c.req.url, 'booking-reminders', {bookingId}, {at, key: `remind-${id}`, label})
 *   schedule:  background.json  {"schedules": {"daily-summary": {"every": "day", "at": "07:00", "tz": "Europe/London"}}}
 *
 * A handler gets the job's data (JSON) and returns when done. Throw to try again later;
 * throw `DontRetry` (from ../platform/background) when trying again cannot help. It may run more
 * than once: make it safe to repeat. Load what you need by id from the Site Database here; never
 * put a whole record (or a secret) in the data.
 */
export const background = defineBackground({
  // 'booking-reminders': async ({bookingId}, job) => { ... },
  [INVITE_EMAIL_LIST]: async (data, job) => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off; trying again later.');
    await runInviteEmails(db, data, job);
  },
  [NOTIFICATION_EMAIL_LIST]: async (_data, job) => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off; trying again later.');
    await runNotificationEmails(db, job);
  },
  [RECURRING_CARDS_LIST]: async () => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off; trying again later.');
    await runRecurringCards(db);
  },
  [DUE_REMINDERS_LIST]: async () => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off; trying again later.');
    await runDueReminders(db);
  },
  [TIMED_REMINDER_LIST]: async data => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off; trying again later.');
    await runTimedReminder(db, data);
  },
  [MORNING_DIGEST_LIST]: async () => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off; trying again later.');
    await runMorningDigest(db);
  },
  [STALE_CARDS_LIST]: async () => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off; trying again later.');
    await runStaleCards(db);
  },
  [FLOWS_LIST]: async () => {
    const db = getDb();
    if (!db) throw new Error('The Site Database is off; trying again later.');
    await runDailyFlows(db);
  },
  'plan-sweep': scheduledJobs['plan-sweep'],
  'grace-sweep': scheduledJobs['grace-sweep'],
  'old-data-cleanup': scheduledJobs['old-data-cleanup'],
  'file-cleanup': scheduledJobs['file-cleanup'],
});
