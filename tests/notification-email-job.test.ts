import {beforeEach, describe, expect, it, vi} from 'vitest';

const cfg = vi.hoisted(() => ({jwtSecret: 'x'.repeat(40) as string | null, siteUrl: 'https://lane.test/' as string | null}));
vi.mock('../src/platform/config', () => ({config: cfg}));
const creds = vi.hoisted(() => ({value: {apiKey: 'k', from: 'f'} as {apiKey: string; from: string} | null}));
vi.mock('../src/server/mail/send', () => ({mailCredentials: () => creds.value, sendMail: vi.fn(), mailConfigured: () => !!creds.value}));

import {gapPassed, renderNotificationEmail, runNotificationEmails} from '../src/server/jobs/notification-email';

const job = {attempt: 1, maxAttempts: 3};
const NOW = new Date('2026-11-04T12:00:00Z');

function makeDb(opts: {due?: any[]; tallies?: any[]; users?: any[]; claim?: number} = {}) {
  const queries: any[] = [];
  const $queryRaw = vi.fn(async (...args: any[]) => {
    queries.push(args);
    return queries.length === 1 ? (opts.due ?? []) : (opts.tallies ?? []);
  });
  const updateMany = vi.fn(async () => ({count: opts.claim ?? 1}));
  return {$queryRaw, user: {findMany: vi.fn(async () => opts.users ?? [])}, userProfile: {updateMany}, updateMany};
}

beforeEach(() => {
  creds.value = {apiKey: 'k', from: 'f'};
  cfg.siteUrl = 'https://lane.test/';
});

describe('notification email rendering', () => {
  it('names counts only and links to the settings page, never a person or address', () => {
    const m = renderNotificationEmail({mentions: 2, assigned: 1}, 'https://lane.test/app/');
    expect(m.subject).toBe('You have 2 mentions and 1 new assignment on Lanefold');
    expect(m.text).toContain('https://lane.test/app/settings/notifications');
    expect(m.html).toContain('Switch them off');
    expect(m.text + m.html).not.toMatch(/@/);
  });

  it('uses the person language from their profile, English by default', () => {
    expect(renderNotificationEmail({mentions: 1, assigned: 0}, 'https://lane.test/app/', 'es').subject).toBe('Tienes 1 mención en Lanefold');
    expect(renderNotificationEmail({mentions: 1, assigned: 0}, 'https://lane.test/app/').subject).toBe('You have 1 mention on Lanefold');
  });
});

describe('gapPassed', () => {
  it('limits immediate to one an hour and digest to about a day; off never', () => {
    expect(gapPassed('immediate', new Date(NOW.getTime() - 30 * 60_000), NOW)).toBe(false);
    expect(gapPassed('immediate', new Date(NOW.getTime() - 61 * 60_000), NOW)).toBe(true);
    expect(gapPassed('digest', new Date(NOW.getTime() - 5 * 3600_000), NOW)).toBe(false);
    expect(gapPassed('digest', null, NOW)).toBe(true);
    expect(gapPassed('off', null, NOW)).toBe(false);
  });
});

describe('runNotificationEmails', () => {
  it('does nothing without mail credentials', async () => {
    creds.value = null;
    const db = makeDb();
    await runNotificationEmails(db as any, job, {send: vi.fn(), now: () => NOW});
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('mails one email per due person, claims the cursor first, and sends no address in the idempotency key', async () => {
    const db = makeDb({
      due: [{user_id: 7, mode: 'immediate', cursor: 5n}],
      tallies: [{user_id: 7, kind: 'mentioned', c: 2, m: 9n}, {user_id: 7, kind: 'assigned', c: 1, m: 11n}],
      users: [{id: 7, email: 'ann@example.com'}],
    });
    const send = vi.fn(async () => ({kind: 'sent', id: null}) as const);
    await runNotificationEmails(db as any, job, {send, now: () => NOW});
    expect(send).toHaveBeenCalledTimes(1);
    const [msg] = send.mock.calls[0] as any[];
    expect(msg.to).toBe('ann@example.com');
    expect(msg.idempotencyKey).toBe('notif-7-11');
    expect(db.updateMany).toHaveBeenCalledWith({where: {userId: 7, emailNotifyMode: 'immediate', emailNotifyCursor: 5n}, data: {emailNotifyCursor: 11n, emailNotifiedAt: NOW}});
  });

  it('skips a person whose claim was lost (a repeat run or switched off)', async () => {
    const db = makeDb({due: [{user_id: 7, mode: 'digest', cursor: 0n}], tallies: [{user_id: 7, kind: 'mentioned', c: 1, m: 3n}], users: [{id: 7, email: 'a@b.co'}], claim: 0});
    const send = vi.fn();
    await runNotificationEmails(db as any, job, {send, now: () => NOW});
    expect(send).not.toHaveBeenCalled();
  });

  it('never mails a suspended or unverified person (not in the user lookup)', async () => {
    const db = makeDb({due: [{user_id: 7, mode: 'digest', cursor: 0n}], tallies: [{user_id: 7, kind: 'mentioned', c: 1, m: 3n}], users: []});
    const send = vi.fn();
    await runNotificationEmails(db as any, job, {send, now: () => NOW});
    expect(send).not.toHaveBeenCalled();
  });

  it('gives the claim back and throws on a retryable failure, but not on the last try', async () => {
    const mk = () => makeDb({due: [{user_id: 7, mode: 'immediate', cursor: 5n}], tallies: [{user_id: 7, kind: 'assigned', c: 1, m: 8n}], users: [{id: 7, email: 'a@b.co'}]});
    const send = vi.fn(async () => ({kind: 'retry', status: 503}) as const);
    const db = mk();
    await expect(runNotificationEmails(db as any, job, {send, now: () => NOW})).rejects.toThrow();
    expect(db.updateMany).toHaveBeenLastCalledWith({where: {userId: 7, emailNotifyCursor: 8n}, data: {emailNotifyCursor: 5n, emailNotifiedAt: null}});
    const db2 = mk();
    await expect(runNotificationEmails(db2 as any, {attempt: 3, maxAttempts: 3}, {send, now: () => NOW})).resolves.toBeUndefined();
  });

  it('never logs an address or body when delivery is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = makeDb({due: [{user_id: 7, mode: 'immediate', cursor: 0n}], tallies: [{user_id: 7, kind: 'assigned', c: 1, m: 8n}], users: [{id: 7, email: 'secret@example.com'}]});
    await runNotificationEmails(db as any, job, {send: vi.fn(async () => ({kind: 'failed', status: 422}) as const), now: () => NOW});
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret@example.com');
    warn.mockRestore();
  });
});
