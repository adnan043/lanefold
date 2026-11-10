import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {app} from '../../src/server/app';
import {cleanupDeletedFiles, MAX_FILE_ATTEMPTS} from '../../src/server/jobs/files';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

/**
 * Deleting an account (platform route `POST /site-api/auth/delete-account`, managed) cleans up Lanefold's data
 * through foreign keys and the `lanefold_before_user_delete` trigger (migration account_deletion_cleanup).
 * docs/product/delete-account-design.md, recommended answers.
 */
const PASSWORD = 'a long test passphrase';
const remove = (b: Browser) =>
  b.post('/site-api/auth/delete-account', {
    password: PASSWORD,
    confirm: 'DELETE',
  });

describe.skipIf(!DATABASE_URL)('delete account cleanup (integration, real Postgres)', () => {
  let ann: Browser;
  let bob: Browser;
  let annId: number;
  let bobId: number;
  let catId: number;

  beforeAll(configureEnv);
  afterAll(() => db.$disconnect());

  beforeEach(async () => {
    await resetDatabase();
    await db.$executeRaw`TRUNCATE "file_deletions" RESTART IDENTITY`;
    await signedIn(app, 'root@example.test', undefined, '203.0.113.40'); // first account = the platform owner
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.41');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.42');
    await signedIn(app, 'cat@example.test', undefined, '203.0.113.43');
    annId = await userId('ann@example.test');
    bobId = await userId('bob@example.test');
    catId = await userId('cat@example.test');
  });

  /** A workspace with a board, a lane and a chat channel; the given members. */
  async function workspace(slug: string, members: {userId: number; role: string}[], plan = 'free') {
    const ws = await db.workspace.create({
      data: {
        name: slug,
        slug,
        plan,
        createdBy: members[0]!.userId,
        memberCount: members.length,
        members: {create: members},
      },
    });
    const board = await db.board.create({
      data: {workspaceId: ws.id, name: 'B', createdBy: members[0]!.userId},
    });
    const lane = await db.lane.create({
      data: {
        boardId: board.id,
        workspaceId: ws.id,
        name: 'L',
        position: 'a0',
      },
    });
    return {ws, board, lane};
  }

  /** Everything Ann owns or touched in a shared workspace (with Bob and Cat), plus her Inbox. */
  async function seedShared() {
    const {ws, board, lane} = await workspace('shared', [
      {userId: annId, role: 'owner'},
      {userId: bobId, role: 'owner'},
      {userId: catId, role: 'member'},
    ]);
    const card = await db.card.create({
      data: {
        boardId: board.id,
        laneId: lane.id,
        workspaceId: ws.id,
        title: 'T',
        position: 'a0',
        createdBy: annId,
        coverFileId: 'cover-shared',
      },
    });
    const annComment = await db.comment.create({
      data: {
        cardId: card.id,
        workspaceId: ws.id,
        authorId: annId,
        bodyMd: 'from ann',
      },
    });
    const bobComment = await db.comment.create({
      data: {
        cardId: card.id,
        workspaceId: ws.id,
        authorId: bobId,
        bodyMd: 'from bob @ann',
      },
    });
    await db.commentMention.create({
      data: {commentId: bobComment.id, userId: annId},
    });
    await db.cardMember.createMany({
      data: [annId, bobId].map(userId => ({
        cardId: card.id,
        userId,
        workspaceId: ws.id,
      })),
    });
    await db.cardWatcher.createMany({
      data: [annId, bobId].map(userId => ({cardId: card.id, userId})),
    });
    await db.boardStar.createMany({
      data: [annId, bobId].map(userId => ({userId, boardId: board.id})),
    });
    await db.boardMember.create({
      data: {
        boardId: board.id,
        userId: annId,
        workspaceId: ws.id,
        role: 'admin',
      },
    });
    await db.savedFilter.createMany({
      data: [annId, bobId].map(userId => ({
        userId,
        workspaceId: ws.id,
        boardId: board.id,
        name: 'f',
        filter: {},
      })),
    });
    await db.userProfile.createMany({
      data: [{userId: annId}, {userId: bobId}],
    });
    const conv = await db.conversation.create({
      data: {
        workspaceId: ws.id,
        kind: 'channel',
        name: 'general',
        createdBy: annId,
      },
    });
    await db.conversationMember.createMany({
      data: [annId, bobId].map(userId => ({
        conversationId: conv.id,
        userId,
        workspaceId: ws.id,
      })),
    });
    const annMsg = await db.message.create({
      data: {
        conversationId: conv.id,
        workspaceId: ws.id,
        seq: 1,
        senderId: annId,
        bodyMd: 'hi',
        clientId: 'c1',
      },
    });
    const bobMsg = await db.message.create({
      data: {
        conversationId: conv.id,
        workspaceId: ws.id,
        seq: 2,
        senderId: bobId,
        bodyMd: 'yo @ann',
        clientId: 'c2',
      },
    });
    await db.messageReaction.createMany({
      data: [
        {messageId: bobMsg.id, userId: annId, emoji: 'x'},
        {messageId: bobMsg.id, userId: bobId, emoji: 'x'},
      ],
    });
    await db.messageMention.create({
      data: {messageId: bobMsg.id, userId: annId},
    });
    await db.activity.create({
      data: {
        workspaceId: ws.id,
        boardId: board.id,
        cardId: card.id,
        actorId: annId,
        kind: 'card.created',
      },
    });
    await db.notification.createMany({
      data: [
        {
          userId: annId,
          workspaceId: ws.id,
          kind: 'comment',
          actorId: bobId,
        },
        {
          userId: bobId,
          workspaceId: ws.id,
          kind: 'comment',
          actorId: annId,
        },
      ],
    });
    await db.attachment.create({
      data: {
        workspaceId: ws.id,
        cardId: card.id,
        name: 'a.png',
        fileId: 'file-shared',
        size: 400,
        uploadedBy: annId,
        ready: true,
      },
    });
    await db.workspaceInvite.create({
      data: {
        workspaceId: ws.id,
        tokenHash: 'i'.repeat(64),
        role: 'member',
        expiresAt: new Date(Date.now() + 1e9),
        createdBy: annId,
      },
    });
    await db.workspaceJoinLink.create({
      data: {
        workspaceId: ws.id,
        tokenHash: 'j'.repeat(64),
        role: 'member',
        expiresAt: new Date(Date.now() + 1e9),
        maxUses: 5,
        createdBy: annId,
      },
    });
    // Ann's personal Inbox board with a card and a file.
    const inbox = await db.board.create({
      data: {
        workspaceId: ws.id,
        name: 'Inbox',
        inboxOf: annId,
        createdBy: annId,
      },
    });
    const inboxLane = await db.lane.create({
      data: {
        boardId: inbox.id,
        workspaceId: ws.id,
        name: 'Inbox',
        position: 'a0',
      },
    });
    const inboxCard = await db.card.create({
      data: {
        boardId: inbox.id,
        laneId: inboxLane.id,
        workspaceId: ws.id,
        title: 'private',
        position: 'a0',
        createdBy: annId,
      },
    });
    await db.attachment.create({
      data: {
        workspaceId: ws.id,
        cardId: inboxCard.id,
        name: 'p.png',
        fileId: 'file-inbox',
        size: 600,
        uploadedBy: annId,
        ready: true,
      },
    });
    await db.workspace.update({where: {id: ws.id}, data: {storageUsedBytes: 1000}});
    await db.order.create({
      data: {
        checkoutId: 'pcs_ann',
        priceKey: 'pro',
        status: 'paid',
        amountCents: 900,
        currency: 'usd',
        email: 'ann@example.test',
        userId: annId,
      },
    });
    await db.membership.create({
      data: {
        subscriptionId: 'sub_ann',
        priceKey: 'pro',
        status: 'active',
        email: 'ann@example.test',
        userId: annId,
      },
    });
    await db.order.create({
      data: {
        checkoutId: 'pcs_bob',
        priceKey: 'pro',
        status: 'paid',
        amountCents: 900,
        currency: 'usd',
        email: 'bob@example.test',
        userId: bobId,
      },
    });
    return {
      ws,
      board,
      card,
      annComment,
      bobComment,
      annMsg,
      bobMsg,
      conv,
      inbox,
      inboxCard,
    };
  }

  const countFor = async (id: number) => ({
    profile: await db.userProfile.count({where: {userId: id}}),
    wsMember: await db.workspaceMember.count({where: {userId: id}}),
    boardMember: await db.boardMember.count({where: {userId: id}}),
    star: await db.boardStar.count({where: {userId: id}}),
    cardMember: await db.cardMember.count({where: {userId: id}}),
    watcher: await db.cardWatcher.count({where: {userId: id}}),
    commentMention: await db.commentMention.count({where: {userId: id}}),
    convMember: await db.conversationMember.count({where: {userId: id}}),
    reaction: await db.messageReaction.count({where: {userId: id}}),
    messageMention: await db.messageMention.count({where: {userId: id}}),
    notification: await db.notification.count({where: {userId: id}}),
    savedFilter: await db.savedFilter.count({where: {userId: id}}),
  });

  it('removes personal data, anonymises authored content, queues files, and leaves other people untouched', async () => {
    const s = await seedShared();
    // A second workspace where Ann is the only member and that is empty (a board without cards): it goes with her.
    const solo = await workspace('solo', [{userId: annId, role: 'owner'}]);
    const bobBefore = await countFor(bobId);
    const catBefore = await countFor(catId);

    const res = await remove(ann);
    expect(res.status).toBe(200);
    expect(await db.user.count({where: {id: annId}})).toBe(0);

    // Personal rows: gone.
    expect(Object.values(await countFor(annId)).every(n => n === 0)).toBe(true);

    // Authored content: kept, author null.
    expect((await db.comment.findUniqueOrThrow({where: {id: s.annComment.id}})).authorId).toBeNull();
    expect((await db.comment.findUniqueOrThrow({where: {id: s.annComment.id}})).bodyMd).toBe('from ann');
    expect((await db.message.findUniqueOrThrow({where: {id: s.annMsg.id}})).senderId).toBeNull();
    expect((await db.card.findUniqueOrThrow({where: {id: s.card.id}})).createdBy).toBeNull();
    expect((await db.board.findUniqueOrThrow({where: {id: s.board.id}})).createdBy).toBeNull();
    expect((await db.conversation.findUniqueOrThrow({where: {id: s.conv.id}})).createdBy).toBeNull();
    expect((await db.workspace.findUniqueOrThrow({where: {id: s.ws.id}})).createdBy).toBeNull();
    expect(
      await db.activity.count({
        where: {workspaceId: s.ws.id, actorId: null},
      })
    ).toBe(1);
    expect(
      (
        await db.attachment.findUniqueOrThrow({
          where: {fileId: 'file-shared'},
        })
      ).uploadedBy
    ).toBeNull();
    expect(
      await db.workspaceInvite.count({
        where: {workspaceId: s.ws.id, createdBy: null},
      })
    ).toBe(1);
    expect(
      await db.workspaceJoinLink.count({
        where: {workspaceId: s.ws.id, createdBy: null},
      })
    ).toBe(1);
    // A notification Ann caused for Bob stays, with no actor.
    expect(
      await db.notification.count({
        where: {userId: bobId, actorId: null},
      })
    ).toBe(1);

    // Inbox board and its card are gone; the solo workspace too.
    expect(await db.board.count({where: {id: s.inbox.id}})).toBe(0);
    expect(await db.card.count({where: {id: s.inboxCard.id}})).toBe(0);
    expect(await db.workspace.count({where: {id: solo.ws.id}})).toBe(0);
    expect(await db.board.count({where: {workspaceId: solo.ws.id}})).toBe(0);

    // Storage: the Inbox file's bytes went back (the shared file stays).
    expect(Number((await db.workspace.findUniqueOrThrow({where: {id: s.ws.id}})).storageUsedBytes)).toBe(400);

    // Seats: the shared workspace had 3, now 2, and it matches the rows.
    const shared = await db.workspace.findUniqueOrThrow({
      where: {id: s.ws.id},
    });
    expect(shared.memberCount).toBe(2);
    expect(shared.memberCount).toBe(await db.workspaceMember.count({where: {workspaceId: s.ws.id}}));

    // Files of deleted rows are queued (not the shared one that stays), no more.
    const queued = (await db.fileDeletion.findMany({select: {fileId: true}})).map(r => r.fileId).sort();
    expect(queued).toEqual(['file-inbox']);

    // Paid history stays, with no user and no email; Bob's order is untouched.
    const order = await db.order.findUniqueOrThrow({
      where: {checkoutId: 'pcs_ann'},
    });
    expect(order.userId).toBeNull();
    expect(order.email).toBeNull();
    const sub = await db.membership.findUniqueOrThrow({
      where: {subscriptionId: 'sub_ann'},
    });
    expect(sub.userId).toBeNull();
    expect(sub.email).toBeNull();
    expect(await db.order.findUniqueOrThrow({where: {checkoutId: 'pcs_bob'}})).toMatchObject({userId: bobId, email: 'bob@example.test'});

    // Other people: same rows as before, and their content is intact.
    expect(await countFor(catId)).toEqual(catBefore);
    const bobAfter = await countFor(bobId);
    expect(bobAfter).toEqual(bobBefore);
    expect((await db.comment.findUniqueOrThrow({where: {id: s.bobComment.id}})).authorId).toBe(bobId);
    expect((await db.message.findUniqueOrThrow({where: {id: s.bobMsg.id}})).senderId).toBe(bobId);
    expect(await db.user.count({where: {id: {in: [bobId, catId]}}})).toBe(2);

    // The card still loads for Bob through the API, with the author shown as nobody ("Deleted user").
    const detail = await bob.get(`/site-api/cards/${s.card.id}/detail`);
    expect(detail.status).toBe(200);
    const body = JSON.stringify(detail.json);
    expect(body).toContain('from ann');
    expect(body).not.toContain('ann@example.test');
    const mine = (
      detail.json as {
        comments?: {items: {id: number; authorName: string | null}[]};
      }
    ).comments?.items.find(c => c.id === s.annComment.id);
    expect(mine?.authorName ?? null).toBeNull();
  });

  it('blocks the only owner of a workspace that has other members; nothing changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const {ws, board, lane} = await workspace('team', [
      {userId: annId, role: 'owner'},
      {userId: bobId, role: 'admin'},
    ]);
    await db.card.create({
      data: {
        boardId: board.id,
        laneId: lane.id,
        workspaceId: ws.id,
        title: 'T',
        position: 'a0',
        createdBy: annId,
      },
    });
    await db.userProfile.create({data: {userId: annId}});

    const res = await remove(ann);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await db.user.count({where: {id: annId}})).toBe(1);
    expect(await db.workspaceMember.count({where: {workspaceId: ws.id}})).toBe(2);
    expect((await db.workspace.findUniqueOrThrow({where: {id: ws.id}})).memberCount).toBe(2);
    expect(
      await db.card.count({
        where: {workspaceId: ws.id, createdBy: annId},
      })
    ).toBe(1);
    expect(await db.userProfile.count({where: {userId: annId}})).toBe(1);

    // Hand the workspace to Bob: now she can leave, and the workspace stays with Bob.
    await db.workspaceMember.update({
      where: {workspaceId_userId: {workspaceId: ws.id, userId: bobId}},
      data: {role: 'owner'},
    });
    expect((await remove(ann)).status).toBe(200);
    expect(await db.workspace.count({where: {id: ws.id}})).toBe(1);
    expect((await db.workspace.findUniqueOrThrow({where: {id: ws.id}})).memberCount).toBe(1);
    expect(await db.card.count({where: {workspaceId: ws.id, createdBy: null}})).toBe(1);
  });

  it('blocks a paid workspace even when the owner is its only member', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const {ws} = await workspace('paid', [{userId: annId, role: 'owner'}], 'pro');
    expect((await remove(ann)).status).toBeGreaterThanOrEqual(400);
    expect(await db.user.count({where: {id: annId}})).toBe(1);
    expect(await db.workspace.count({where: {id: ws.id}})).toBe(1);
    await db.workspace.update({
      where: {id: ws.id},
      data: {plan: 'free'},
    });
    expect((await remove(ann)).status).toBe(200);
    expect(await db.workspace.count({where: {id: ws.id}})).toBe(0);
  });

  it('a co-owner leaving does not touch the other owner or her content', async () => {
    const s = await seedShared();
    const res = await remove(bob); // a co-owner: Ann stays owner
    expect(res.status).toBe(200);
    expect((await db.workspace.findUniqueOrThrow({where: {id: s.ws.id}})).memberCount).toBe(2);
    expect((await db.comment.findUniqueOrThrow({where: {id: s.bobComment.id}})).authorId).toBeNull();
    expect((await db.comment.findUniqueOrThrow({where: {id: s.annComment.id}})).authorId).toBe(annId);
    expect(await db.workspaceMember.count({where: {userId: annId}})).toBe(1);
  });

  it('two co-owners deleting at once: exactly one succeeds, an owner always remains', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const {ws} = await workspace('duo', [
      {userId: annId, role: 'owner'},
      {userId: bobId, role: 'owner'},
    ]);
    await db.workspaceMember.create({
      data: {workspaceId: ws.id, userId: catId, role: 'member'},
    });
    const [a, b] = await Promise.all([remove(ann), remove(bob)]);
    expect([a.status, b.status].filter(s => s === 200)).toHaveLength(1);
    expect(
      await db.workspaceMember.count({
        where: {workspaceId: ws.id, role: 'owner'},
      })
    ).toBe(1);
  });

  it('blocks a solo free workspace that still has cards or files (workspace_needs_action); an empty one goes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const {ws, board, lane} = await workspace('solo-busy', [{userId: annId, role: 'owner'}]);
    await db.card.create({
      data: {boardId: board.id, laneId: lane.id, workspaceId: ws.id, title: 'T', position: 'a0', createdBy: annId},
    });
    expect((await remove(ann)).status).toBeGreaterThanOrEqual(400);
    expect(await db.user.count({where: {id: annId}})).toBe(1);
    expect(await db.workspace.count({where: {id: ws.id}})).toBe(1);
    expect(await db.card.count({where: {workspaceId: ws.id}})).toBe(1);
    await db.card.deleteMany({where: {workspaceId: ws.id}});
    expect((await remove(ann)).status).toBe(200);
    expect(await db.workspace.count({where: {id: ws.id}})).toBe(0);
  });

  it('deleting an attachment row gives its bytes back to the workspace (trigger), never below zero', async () => {
    const {ws} = await workspace('bytes', [{userId: annId, role: 'owner'}]);
    await db.workspace.update({where: {id: ws.id}, data: {storageUsedBytes: 500}});
    const a = await db.attachment.create({data: {workspaceId: ws.id, name: 'a', fileId: 'file-bytes-a', size: 300, ready: true, uploadedBy: annId}});
    const b = await db.attachment.create({data: {workspaceId: ws.id, name: 'b', fileId: 'file-bytes-b', size: 900, ready: true, uploadedBy: annId}});
    const c = await db.attachment.create({data: {workspaceId: ws.id, name: 'c', fileId: 'file-bytes-c', size: 100, ready: false, uploadedBy: annId}});
    await db.attachment.delete({where: {id: a.id}});
    expect(Number((await db.workspace.findUniqueOrThrow({where: {id: ws.id}})).storageUsedBytes)).toBe(200);
    await db.attachment.delete({where: {id: b.id}});
    expect(Number((await db.workspace.findUniqueOrThrow({where: {id: ws.id}})).storageUsedBytes)).toBe(0);
    await db.attachment.delete({where: {id: c.id}}); // not ready: it never counted
    expect(Number((await db.workspace.findUniqueOrThrow({where: {id: ws.id}})).storageUsedBytes)).toBe(0);
  });

  it('the 25 foreign keys to users and the triggers exist in the database', async () => {
    const expected = [
      'activity_actor_id_fkey',
      'attachments_uploaded_by_fkey',
      'board_members_user_id_fkey',
      'board_stars_user_id_fkey',
      'boards_created_by_fkey',
      'card_members_user_id_fkey',
      'card_watchers_user_id_fkey',
      'cards_created_by_fkey',
      'comment_mentions_user_id_fkey',
      'comments_author_id_fkey',
      'conversation_members_user_id_fkey',
      'conversations_created_by_fkey',
      'memberships_user_id_fkey',
      'message_mentions_user_id_fkey',
      'message_reactions_user_id_fkey',
      'messages_sender_id_fkey',
      'notifications_actor_id_fkey',
      'notifications_user_id_fkey',
      'orders_user_id_fkey',
      'saved_filters_user_id_fkey',
      'user_profiles_user_id_fkey',
      'workspace_invites_created_by_fkey',
      'workspace_join_links_created_by_fkey',
      'workspace_members_user_id_fkey',
      'workspaces_created_by_fkey',
    ];
    const fks = await db.$queryRaw<{conname: string; convalidated: boolean}[]>`
      SELECT conname, convalidated FROM pg_constraint WHERE contype = 'f' AND confrelid = 'users'::regclass`;
    const ours = fks.filter(f => expected.includes(f.conname));
    expect(ours).toHaveLength(25);
    expect(ours.every(f => f.convalidated)).toBe(true);
    const triggers = (
      await db.$queryRaw<{tgname: string}[]>`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'lanefold\_%' ESCAPE '\'`
    ).map(t => t.tgname);
    expect(triggers).toEqual(
      expect.arrayContaining(['lanefold_before_user_delete', 'lanefold_attachment_file', 'lanefold_attachment_storage', 'lanefold_card_cover_file', 'lanefold_board_bg_file'])
    );
  });

  it('a call that throws counts as a failed attempt and a 5xx or unreachable platform does not', async () => {
    await db.fileDeletion.createMany({data: [{fileId: 'poison'}, {fileId: 'down'}, {fileId: 'bad-request'}, {fileId: 'other-404'}]});
    const stub = async (id: string) => {
      if (id === 'poison') throw new Error('Not a file id.');
      if (id === 'down') return {ok: false, status: 0, code: 'E_PLATFORM_UNREACHABLE'};
      if (id === 'other-404') return {ok: false, status: 404, code: 'HTTP_404'};
      return {ok: false, status: 400, code: 'E_ID'};
    };
    await cleanupDeletedFiles(db, stub);
    const attempts = async (fileId: string) => (await db.fileDeletion.findUniqueOrThrow({where: {fileId}})).attempts;
    expect(await attempts('poison')).toBe(1);
    expect(await attempts('down')).toBe(0);
    expect(await attempts('bad-request')).toBe(1);
    expect(await attempts('other-404')).toBe(1);
  });

  describe('file-cleanup job', () => {
    it('deletes queued files, treats 404 as done, retries a failure, and is safe to repeat', async () => {
      await db.fileDeletion.createMany({
        data: [{fileId: 'ok-file'}, {fileId: 'gone-file'}, {fileId: 'bad-file'}],
      });
      const seen: string[] = [];
      const stub = async (id: string) => {
        seen.push(id);
        return id === 'ok-file' ? {ok: true} : id === 'gone-file' ? {ok: false, status: 404, code: 'E_FILE_NOT_FOUND'} : {ok: false, status: 400};
      };
      const first = await cleanupDeletedFiles(db, stub);
      expect(first).toEqual({deleted: 2, failed: 1, gaveUp: 0});
      const second = await cleanupDeletedFiles(db, stub);
      expect(second.deleted).toBe(0);
      expect(seen.filter(id => id === 'ok-file')).toHaveLength(1); // a finished file is never called again
      expect(seen.filter(id => id === 'bad-file')).toHaveLength(2);
      expect(
        (
          await db.fileDeletion.findUniqueOrThrow({
            where: {fileId: 'bad-file'},
          })
        ).attempts
      ).toBe(2);
      await db.fileDeletion.update({
        where: {fileId: 'bad-file'},
        data: {attempts: MAX_FILE_ATTEMPTS - 1},
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await cleanupDeletedFiles(db, stub)).gaveUp).toBe(1);
      expect(await db.fileDeletion.count({where: {doneAt: null}})).toBe(0);
    });
  });
});
