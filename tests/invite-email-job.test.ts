import {beforeEach, describe, expect, it, vi} from 'vitest';

const cfg = vi.hoisted(() => ({jwtSecret: 'x'.repeat(40) as string | null, siteUrl: 'https://lane.test/' as string | null}));
vi.mock('../src/platform/config', () => ({config: cfg}));
const sendJob = vi.hoisted(() => vi.fn());
vi.mock('../src/platform/background', async orig => ({...(await orig<typeof import('../src/platform/background')>()), sendJob: (...a: unknown[]) => sendJob(...a)}));
vi.mock('../src/server/mail/send', () => ({mailCredentials: () => ({apiKey: 'k', from: 'f'}), sendMail: vi.fn()}));

const ent = vi.hoisted(() => ({value: {readOnly: false} as {readOnly: boolean} | null}));
vi.mock('../src/server/entitlements', () => ({getEntitlements: async () => ent.value}));

import {sha256Hex} from '../src/platform/auth/encoding';
import {DontRetry} from '../src/platform/background';
import {enqueueInviteEmails, MAX_BATCH, runInviteEmails, sealInviteItem} from '../src/server/jobs/invite-email';

const job = {attempt: 1, maxAttempts: 3};
const item = (id = 1) => ({id, s: 'v1.a.b'});
const db = (invites: any[] = [], inviter: any = {name: 'Ann'}, member: any = {role: 'admin'}) => {
  const updateMany = vi.fn(async () => ({count: 1}));
  return {
    workspaceMember: {findFirst: vi.fn(async () => member)},
    user: {findUnique: vi.fn(async () => inviter)},
    workspaceInvite: {findMany: vi.fn(async () => invites), updateMany},
    updateMany,
  };
};

beforeEach(() => {
  sendJob.mockReset();
  cfg.jwtSecret = 'x'.repeat(40);
  cfg.siteUrl = 'https://lane.test/';
  ent.value = {readOnly: false};
});

describe('invite-email payload validation', () => {
  const bad: [string, unknown][] = [
    ['null', null],
    ['a string', 'x'],
    ['wrong version', {v: 2, w: 1, by: 1, items: [item()]}],
    ['fractional workspace', {v: 1, w: 1.5, by: 1, items: [item()]}],
    ['no items', {v: 1, w: 1, by: 1, items: []}],
    ['too many items', {v: 1, w: 1, by: 1, items: Array.from({length: MAX_BATCH + 1}, (_, i) => item(i))}],
    ['item without sealed text', {v: 1, w: 1, by: 1, items: [{id: 1}]}],
    ['oversized sealed text', {v: 1, w: 1, by: 1, items: [{id: 1, s: 'a'.repeat(2000)}]}],
    ['one bad item among good', {v: 1, w: 1, by: 1, items: [item(1), {id: 'x', s: 'a'}]}],
  ];
  it.each(bad)('rejects %s with DontRetry (never an endless retry)', async (_n, data) => {
    const d = db();
    await expect(runInviteEmails(d as never, data, job)).rejects.toBeInstanceOf(DontRetry);
    expect(d.workspaceInvite.findMany).not.toHaveBeenCalled();
  });
});

describe('enqueueInviteEmails', () => {
  it('refuses an empty or oversized batch without calling the platform', async () => {
    expect(await enqueueInviteEmails('https://x', 1, 1, [], 'k')).toBe(false);
    expect(await enqueueInviteEmails('https://x', 1, 1, Array.from({length: MAX_BATCH + 1}, (_, i) => item(i)), 'k')).toBe(false);
    expect(sendJob).not.toHaveBeenCalled();
  });
  it('returns false (not a throw) when the platform refuses, and logs only the code', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    sendJob.mockRejectedValueOnce(Object.assign(new Error('has bob@x.com'), {code: 'E_NOPE'}));
    expect(await enqueueInviteEmails('https://x', 1, 1, [item()], 'k')).toBe(false);
    expect(JSON.stringify(err.mock.calls)).not.toContain('bob@x.com');
    err.mockRestore();
  });
  it('sends one job for the whole batch', async () => {
    expect(await enqueueInviteEmails('https://x', 9, 2, [item(1), item(2)], 'k')).toBe(true);
    expect(sendJob).toHaveBeenCalledTimes(1);
    expect(sendJob.mock.calls[0]![2]).toMatchObject({v: 1, w: 9, by: 2});
  });
});

describe('sealInviteItem', () => {
  it('is null without a site secret and never contains the address or token in clear', async () => {
    cfg.jwtSecret = null;
    expect(await sealInviteItem(1, 2, 'a@b.co', 'tok')).toBeNull();
    cfg.jwtSecret = 'x'.repeat(40);
    const sealed = await sealInviteItem(1, 2, 'a@b.co', 'tok');
    expect(sealed!.id).toBe(2);
    expect(sealed!.s).not.toMatch(/a@b\.co|tok/);
  });
});

describe('runInviteEmails', () => {
  const invite = (over: any = {}) => ({id: 1, role: 'member', expiresAt: new Date(Date.now() + 1e6), tokenHash: 'h', emailStatus: 'queued', workspace: {name: 'W', defaultLocale: 'en'}, ...over});

  it('sends nothing when the inviter lost their role, or the workspace is read-only or has no entitlements', async () => {
    const sealed = (await sealInviteItem(1, 1, 'to@x.co', 'rawtoken'))!;
    const hash = await sha256Hex('rawtoken');
    for (const [member, e] of [[null, {readOnly: false}], [{role: 'admin'}, {readOnly: true}], [{role: 'admin'}, null]] as const) {
      ent.value = e as never;
      const send = vi.fn();
      const d = db([invite({tokenHash: hash})], {name: 'Ann'}, member);
      await runInviteEmails(d as never, {v: 1, w: 1, by: 1, items: [sealed]}, job, {send});
      expect(send).not.toHaveBeenCalled();
      expect((d.updateMany.mock.calls[0] as any)[0].data).toEqual({emailStatus: 'failed'});
    }
  });

  it('skips invites that are gone or already sent', async () => {
    const send = vi.fn();
    const d = db([invite({emailStatus: 'sent'})]);
    await runInviteEmails(d as never, {v: 1, w: 1, by: 1, items: [item(1), item(2)]}, job, {send});
    expect(send).not.toHaveBeenCalled();
    expect(d.updateMany).not.toHaveBeenCalled();
  });

  it('skips an invite already settled as failed (a retry for another invite must not mail it again)', async () => {
    const send = vi.fn();
    const d = db([invite({emailStatus: 'failed'})]);
    await runInviteEmails(d as never, {v: 1, w: 1, by: 1, items: [item(1)]}, job, {send});
    expect(send).not.toHaveBeenCalled();
    expect(d.updateMany).not.toHaveBeenCalled();
  });

  it('marks failed (no send, no attempt count) when the sealed text cannot be opened', async () => {
    const send = vi.fn();
    const d = db([invite()]);
    await runInviteEmails(d as never, {v: 1, w: 1, by: 1, items: [item(1)]}, job, {send});
    expect(send).not.toHaveBeenCalled();
    const arg = (d.updateMany.mock.calls[0] as any)[0];
    expect(arg.data).toEqual({emailStatus: 'failed'});
    expect(arg.where.emailStatus).toEqual({not: 'sent'});
  });

  it('sends with the right link, then marks sent; a stale token is skipped', async () => {
    const sealed = (await sealInviteItem(1, 1, 'to@x.co', 'rawtoken'))!;
    const send = vi.fn(async () => ({kind: 'sent'}));
    const d = db([invite({tokenHash: await sha256Hex('rawtoken')})]);
    await runInviteEmails(d as never, {v: 1, w: 1, by: 1, items: [sealed]}, job, {send: send as never});
    const msg = (send.mock.calls[0] as any)[0];
    expect(msg.to).toBe('to@x.co');
    expect(msg.text).toContain('https://lane.test/app/join/rawtoken');
    expect((d.updateMany.mock.calls[0] as any)[0].data).toMatchObject({emailStatus: 'sent', emailAttempts: {increment: 1}});

    const stale = db([invite({tokenHash: 'rotated'})]);
    const send2 = vi.fn();
    await runInviteEmails(stale as never, {v: 1, w: 1, by: 1, items: [sealed]}, job, {send: send2});
    expect(send2).not.toHaveBeenCalled();
    expect(stale.updateMany).not.toHaveBeenCalled();
  });

  it('retries a transient failure by throwing, but fails for good on the last attempt', async () => {
    const sealed = (await sealInviteItem(1, 1, 'to@x.co', 'rawtoken'))!;
    const hash = await sha256Hex('rawtoken');
    const send = vi.fn(async () => ({kind: 'retry', status: 503}));
    const d1 = db([invite({tokenHash: hash})]);
    await expect(runInviteEmails(d1 as never, {v: 1, w: 1, by: 1, items: [sealed]}, job, {send: send as never})).rejects.toThrow(/trying again/);
    expect((d1.updateMany.mock.calls[0] as any)[0].data.emailStatus).toBe('queued');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d2 = db([invite({tokenHash: hash})]);
    await runInviteEmails(d2 as never, {v: 1, w: 1, by: 1, items: [sealed]}, {attempt: 3, maxAttempts: 3}, {send: send as never});
    expect((d2.updateMany.mock.calls[0] as any)[0].data.emailStatus).toBe('failed');
    warn.mockRestore();
  });

  it('marks not_configured without a site origin and does not retry', async () => {
    cfg.siteUrl = null;
    const sealed = (await sealInviteItem(1, 1, 'to@x.co', 'rawtoken'))!;
    const send = vi.fn();
    const d = db([invite({tokenHash: await sha256Hex('rawtoken')})]);
    await runInviteEmails(d as never, {v: 1, w: 1, by: 1, items: [sealed]}, job, {send});
    expect(send).not.toHaveBeenCalled();
    expect((d.updateMany.mock.calls[0] as any)[0].data).toEqual({emailStatus: 'not_configured'});
  });
});
