import {DontRetry} from '../../platform/background';
import {getDb} from '../../platform/db';
import {cleanupDeletedFiles} from './files';
import {cleanupOld, sweepEndedMemberships, sweepGrace} from './sweeps';

function database() {
  const db = getDb();
  if (!db) throw new Error('The Site Database is off; trying again later.');
  return db;
}

/** Handlers for the schedules in background.json. Each is safe to repeat. */
export const scheduledJobs = {
  'plan-sweep': async () => {
    await sweepEndedMemberships(database());
  },
  'grace-sweep': async () => {
    await sweepGrace(database());
  },
  'file-cleanup': async () => {
    await cleanupDeletedFiles(database());
  },
  'old-data-cleanup': async (data: unknown) => {
    if (data !== null && data !== undefined && typeof data !== 'object') throw new DontRetry('The cleanup settings must be an object.');
    await cleanupOld(database(), data);
  },
};
