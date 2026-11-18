import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {cleanupOld} from '../../src/server/jobs/sweeps';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn} from './support/harness';

type J = Record<string, any>;

/**
 * Files sent in chat: upload (three steps), send with a message, view through the conversation's access, delete with
 * the message (bytes given back, stored file queued), unsent files removed or swept (real Postgres; the platform's
 * file API is answered here).
 */
describe.skipIf(!DATABASE_URL)('chat files (integration, real Postgres)', () => {
  let ann: Browser; // owner of A
  let mia: Browser; // member of A
  let vic: Browser; // viewer of A
  let bob: Browser; // owner of B, nothing in A
  let wsA: number;
  let channel: number;
  let ids: Record<string, number>;

  // The platform's file API: grants, confirms and short links (what src/platform/files.ts calls).
  const harnessFetch = globalThis.fetch;
  let fileSeq = 0;
  const platform = {completed: [] as string[], deleted: [] as string[]};
  beforeAll(() => {
    configureEnv();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const hit = /\/api\/site\/v1\/files(\/.*)?$/.exec(url.split('?')[0]!);
      if (!hit) return harnessFetch(input, init);
      const path = hit[1] ?? '';
      const ok = (data: unknown, status = 200) => new Response(JSON.stringify({data}), {status, headers: {'content-type': 'application/json'}});
      if (path === '/uploads') {
        const body = JSON.parse(String(init?.body)) as {name: string; contentType: string; size: number};
        const id = `file_${String(++fileSeq).padStart(26, '0')}`;
        const file = {id, ...body, visibility: 'private', status: 'pending'};
        return ok({file, upload: {method: 'PUT', url: `https://store.example/${id}`, headers: {'Content-Type': body.contentType}, expiresAt: ''}}, 201);
      }
      const done = /^\/(file_[0-9a-z]+)\/complete$/.exec(path);
      if (done) {
        platform.completed.push(done[1]!);
        return ok({file: {id: done[1], status: 'ready'}});
      }
      const link = /^\/(file_[0-9a-z]+)\/url$/.exec(path);
      if (link) return ok({url: `https://store.example/${link[1]}?signed`, expiresAt: ''});
      const gone = /^\/(file_[0-9a-z]+)$/.exec(path);
      if (gone && init?.method === 'DELETE') {
        platform.deleted.push(gone[1]!);
        return ok({deleted: true});
      }
      return new Response('{}', {status: 404});
    }) as typeof fetch;
  });
  afterAll(async () => {
    globalThis.fetch = harnessFetch;
    await db.$disconnect();
  });
  afterEach(() => {
    platform.completed = [];
    platform.deleted = [];
  });
  beforeEach(async () => {
    await resetDatabase();
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.51');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.52');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.53');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.54');
    wsA = (await ann.post('/site-api/workspaces', {name: 'Alpha'})).json.workspace.id;
    await bob.post('/site-api/workspaces', {name: 'Beta'});
    const users = await db.user.findMany({select: {id: true, email: true}});
    ids = Object.fromEntries(users.map(u => [u.email.split('@')[0]!, u.id]));
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: ids.mia!, role: 'member'}});
    await db.workspaceMember.create({data: {workspaceId: wsA, userId: ids.vic!, role: 'viewer'}});
    channel = (await ann.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'channel', name: 'general'})).json.conversation.id;
  });

  const PDF = 'application/pdf';
  /** Steps 1 and 3 (the browser's PUT goes straight to the storage, never through the Site API). */
  const upload = async (b: Browser, conv = channel, name = 'plan.pdf', contentType = PDF, size = 1000) => {
    const grant = await b.post(`/site-api/conversations/${conv}/attachments`, {name, contentType, size});
    expect(grant.status, JSON.stringify(grant.json)).toBe(201);
    const done = await b.post(`/site-api/chat/attachments/${grant.json.attachmentId}/complete`, {});
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    return done.json.attachment as J;
  };
  const send = (b: Browser, body: string, attachmentIds: number[], conv = channel) =>
    b.post(`/site-api/conversations/${conv}/messages`, {body, clientId: `c-${Math.random().toString(36).slice(2, 12)}`, attachmentIds});
  const used = async () => Number((await db.workspace.findUniqueOrThrow({where: {id: wsA}, select: {storageUsedBytes: true}})).storageUsedBytes);

  it('uploads, sends with no text, and shows the file to whoever reads the conversation', async () => {
    const file = await upload(mia);
    expect(file).toMatchObject({name: 'plan.pdf', contentType: PDF, size: 1000, isImage: false});
    expect(file).not.toHaveProperty('fileId');
    expect(await used()).toBe(1000);

    const sent = await send(mia, '', [file.id]);
    expect(sent.status, JSON.stringify(sent.json)).toBe(201);
    expect(sent.json.message.body).toBe('');
    expect(sent.json.message.files).toEqual([{id: file.id, name: 'plan.pdf', contentType: PDF, size: 1000, isImage: false}]);
    const page = await ann.get(`/site-api/conversations/${channel}/messages`);
    expect((page.json.items as J[]).at(-1)!.files).toHaveLength(1);

    // A viewer reads the channel, so sees the file; another workspace never does.
    for (const reader of [ann, mia, vic]) {
      const view = await reader.get(`/site-api/chat/attachments/${file.id}/view`);
      expect(view.status).toBe(302);
      expect(view.headers.get('location')).toContain('store.example');
    }
    expect((await bob.get(`/site-api/chat/attachments/${file.id}/view`)).status).toBe(404);
    expect(JSON.stringify(page.json)).not.toContain('file_');
  });

  it('a picture is marked as one; every view is checked again (never cached)', async () => {
    const pic = await upload(mia, channel, 'shot.png', 'image/png', 500);
    expect(pic.isImage).toBe(true);
    const doc = await upload(mia, channel, 'notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 700);
    expect((await send(mia, 'two files', [pic.id, doc.id])).status).toBe(201);
    for (const f of [pic, doc]) {
      const view = await ann.get(`/site-api/chat/attachments/${f.id}/view`);
      expect(view.status).toBe(302);
      // Never cached: every view checks access again.
      expect(view.headers.get('cache-control')).toContain('no-store');
    }
  });

  it('a member removed between the link and the confirm: the file never counts and is dropped', async () => {
    const grant = await mia.post(`/site-api/conversations/${channel}/attachments`, {name: 'plan.pdf', contentType: PDF, size: 1000});
    expect(grant.status).toBe(201);
    await db.workspaceMember.deleteMany({where: {workspaceId: wsA, userId: ids.mia!}});
    expect((await mia.post(`/site-api/chat/attachments/${grant.json.attachmentId}/complete`, {})).status).toBe(404);
    expect(await used()).toBe(0);
    expect(await db.attachment.count({where: {id: grant.json.attachmentId}})).toBe(0);
  });

  it('refuses what the rules do not allow', async () => {
    const post = (b: Browser, body: J, conv = channel) => b.post(`/site-api/conversations/${conv}/attachments`, body);
    expect((await post(mia, {name: 'x.html', contentType: 'text/html', size: 10})).status).toBe(422);
    expect((await post(mia, {name: 'x.svg', contentType: 'image/svg+xml', size: 10})).status).toBe(422);
    expect((await post(mia, {name: 'x.pdf', contentType: PDF, size: 0})).status).toBe(422);
    expect((await post(mia, {name: 'x.pdf', contentType: PDF, size: 100 * 1024 * 1024 + 1})).status).toBe(422);
    // Over the plan's file size (the free plan allows less than the chat's own cap).
    expect((await post(mia, {name: 'x.pdf', contentType: PDF, size: 50 * 1024 * 1024})).status).toBe(413);
    // A viewer cannot send here; another workspace does not see the conversation.
    expect((await post(vic, {name: 'x.pdf', contentType: PDF, size: 10})).status).toBe(403);
    expect((await post(bob, {name: 'x.pdf', contentType: PDF, size: 10})).status).toBe(404);
    // Without text, a message needs a file.
    expect((await send(mia, '', [])).status).toBe(422);
    expect((await send(mia, '', Array.from({length: 11}, (_, i) => i + 1))).status).toBe(422);
  });

  it('only my own, confirmed, unsent files of this workspace can be sent', async () => {
    const annFile = await upload(ann);
    expect((await send(mia, 'not mine', [annFile.id])).status).toBe(422);
    // Not confirmed yet (step 3 not done).
    const pending = await mia.post(`/site-api/conversations/${channel}/attachments`, {name: 'p.pdf', contentType: PDF, size: 10});
    expect((await send(mia, 'too soon', [pending.json.attachmentId])).status).toBe(422);
    // Sent once: not again.
    const file = await upload(mia);
    expect((await send(mia, 'first', [file.id])).status).toBe(201);
    expect((await send(mia, 'again', [file.id])).status).toBe(422);
    // Someone else cannot confirm or remove my unsent file.
    expect((await ann.post(`/site-api/chat/attachments/${pending.json.attachmentId}/complete`, {})).status).toBe(404);
    expect((await ann.request('DELETE', `/site-api/chat/attachments/${pending.json.attachmentId}`)).status).toBe(404);
    // A sent file is not removed through the composer route (delete the message).
    expect((await mia.request('DELETE', `/site-api/chat/attachments/${file.id}`)).status).toBe(404);
  });

  it('confirming twice counts the bytes once', async () => {
    const file = await upload(mia);
    expect((await mia.post(`/site-api/chat/attachments/${file.id}/complete`, {})).status).toBe(200);
    expect(await used()).toBe(1000);
  });

  it('removing an unsent file gives its bytes back and queues the stored file', async () => {
    const file = await upload(mia);
    const row = await db.attachment.findUniqueOrThrow({where: {id: file.id}, select: {fileId: true}});
    expect((await mia.request('DELETE', `/site-api/chat/attachments/${file.id}`)).status).toBe(200);
    expect(await used()).toBe(0);
    expect(await db.fileDeletion.count({where: {fileId: row.fileId!}})).toBe(1);
  });

  it('deleting the message deletes its files, and the link stops working', async () => {
    const file = await upload(mia);
    const msg = (await send(mia, 'with a file', [file.id])).json.message.id;
    const row = await db.attachment.findUniqueOrThrow({where: {id: file.id}, select: {fileId: true}});
    expect((await mia.request('DELETE', `/site-api/messages/${msg}`)).status).toBe(200);
    expect(await db.attachment.count({where: {id: file.id}})).toBe(0);
    expect(await used()).toBe(0);
    expect(await db.fileDeletion.count({where: {fileId: row.fileId!}})).toBe(1);
    expect((await ann.get(`/site-api/chat/attachments/${file.id}/view`)).status).toBe(404);
    const page = await ann.get(`/site-api/conversations/${channel}/messages`);
    expect((page.json.items as J[]).find(m => m.id === msg)!.files).toEqual([]);
  });

  it('a DM file is for the two people only', async () => {
    const dm = (await mia.post(`/site-api/workspaces/${wsA}/conversations`, {kind: 'dm', userIds: [ids.ann!]})).json.conversation.id;
    const file = await upload(mia, dm);
    expect((await send(mia, 'just for you', [file.id], dm)).status).toBe(201);
    expect((await ann.get(`/site-api/chat/attachments/${file.id}/view`)).status).toBe(302);
    expect((await vic.get(`/site-api/chat/attachments/${file.id}/view`)).status).toBe(404);
  });

  it('the daily sweep removes files never sent after a day, never sent ones', async () => {
    const stale = await upload(mia);
    const kept = await upload(mia);
    expect((await send(mia, 'sent', [kept.id])).status).toBe(201);
    const old = new Date(Date.now() - 25 * 3_600_000);
    await db.attachment.updateMany({where: {id: {in: [stale.id, kept.id]}}, data: {createdAt: old}});
    const fresh = await upload(mia);
    await cleanupOld(db, {});
    expect(await db.attachment.count({where: {id: stale.id}})).toBe(0);
    expect(await db.attachment.count({where: {id: kept.id}})).toBe(1);
    expect(await db.attachment.count({where: {id: fresh.id}})).toBe(1);
  });
});
