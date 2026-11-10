import {describe, expect, it} from 'vitest';

import {CARDS_PER_PAGE, KEEP_DAYS, reminderWindow} from '../src/server/jobs/due-reminders';

describe('due reminders: the date rule (UTC days)', () => {
  it('looks at today and tomorrow, in UTC', () => {
    expect(reminderWindow(new Date('2026-11-04T00:00:00.000Z'))).toMatchObject({today: '2026-11-04', tomorrow: '2026-11-05'});
    expect(reminderWindow(new Date('2026-11-04T23:59:59.999Z'))).toMatchObject({today: '2026-11-04', tomorrow: '2026-11-05'});
  });
  it('looks at a wider band of due days for timed cards (a 2-day reminder in any time zone)', () => {
    expect(reminderWindow(new Date('2026-11-04T10:00:00.000Z'))).toMatchObject({from: '2026-11-03', until: '2026-11-07'});
  });
  it('rolls over month and year ends', () => {
    expect(reminderWindow(new Date('2026-12-31T10:00:00.000Z'))).toMatchObject({today: '2026-12-31', tomorrow: '2027-01-01'});
    expect(reminderWindow(new Date('2028-02-28T10:00:00.000Z'))).toMatchObject({tomorrow: '2028-02-29'});
  });
  it('forgets reminder keys a week after the due day', () => {
    expect(KEEP_DAYS).toBe(7);
    expect(reminderWindow(new Date('2026-11-04T10:00:00.000Z')).prune).toBe('2026-10-28');
  });
  it('pages in small keyset steps', () => {
    expect(CARDS_PER_PAGE).toBe(25);
  });
});
