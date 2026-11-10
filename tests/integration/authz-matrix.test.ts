import {afterAll, beforeAll, describe, expect, it} from 'vitest';

import {app} from '../../src/server/app';
import {Browser, configureEnv, DATABASE_URL, db, resetDatabase, signedIn, userId} from './support/harness';

/**
 * Adversarial AUTHORIZATION matrix over EVERY route the Site API mounts (docs/agent/review.md, step 1).
 *
 * Two workspaces: A (owner ann, admin adm, member mia, viewer vic, member nick) and B (owner bob).
 * Each has a workspace-visible board, a card set, a chat conversation and an invite; A also has a PRIVATE
 * board that only mia (a board member) can see, with its own cards and board chat. Every row of the table
 * below states one route: its method, path template (the way `app.routes` lists it), who may call it and
 * what everybody else must get. The checks, per row:
 *
 *   - signed out ........................ 401 (an invalid body may answer 422 first: validators run before guards)
 *   - a user of ANOTHER workspace ....... 404 (never 403 or 200), and no data of the other workspace in the body
 *   - a role below the route's minimum .. 403 (a few message / attachment routes answer 404 by design)
 *   - a non-member of the private board . 404 on the board, its cards, labels, comments, attachments, chat
 *   - site-permission routes ............ 403 for a signed-in user without that permission
 *   - EVERY response ..................... no e-mail address, no `passwordHash`
 *
 * Writes that must be refused never change anything, so the fixtures are built once. A final block puts ids
 * of workspace B in the bodies and params of workspace A's routes. A meta-test fails when a route of the
 * Hono app is missing from the table.
 *
 * Needs TEST_DATABASE_URL (a throwaway Postgres; the tables are emptied), like the other integration files.
 */

type J = Record<string, any>;
type Role = 'viewer' | 'member' | 'admin' | 'owner';
const RANK: Record<Role, number> = {viewer: 1, member: 2, admin: 3, owner: 4};
const ROLES: Role[] = ['viewer', 'member', 'admin', 'owner'];

/** The ids of one workspace's resources (all strings, ready for a URL). */
type RS = {
  ws: string;
  board: string;
  lane1: string;
  lane2: string;
  card: string;
  card2: string;
  label: string;
  field: string;
  option: string;
  checklist: string;
  item: string;
  comment: string;
  attach: string;
  conv: string;
  msg: string;
  invite: string;
  link: string;
  inboxCard: string;
  flow: string;
  template: string; // a card template authored by the workspace owner
};
type Fx = {
  pub: RS; // workspace A, board visible to its members
  priv: RS; // workspace A, private board (mia only), board chat
  other: RS; // workspace B
  u: Record<'ann' | 'adm' | 'mia' | 'vic' | 'nick' | 'bob', number>;
  notifA: string; // a notification of ann
  notifB: string; // a notification of bob
  attachB: string; // an image attachment on a card of B
};

type Kind = 'resource' | 'self' | 'perm' | 'public' | 'platform';
type Row = {
  key: string;
  kind: Kind;
  /** Path (with query) for one resource set; resource and self rows. */
  path?: (r: RS, f: Fx) => string;
  body?: (r: RS, f: Fx) => unknown;
  /** Lowest workspace role the route accepts (default viewer: any member). */
  min?: Role;
  /** The route also reaches boards / board chats: the private variant must be 404 for non-board-members. */
  priv?: boolean;
  /** Statuses a role below `min` gets (default 403; some message and attachment routes say 404 on purpose). */
  below?: number[];
  /** A GET that needs more than a seat to answer 200 (redirects, files): skip the "allowed" check. */
  noPositive?: boolean;
  /** priv GET whose allowed readers on the private board are admins only (a board member without admin gets 403): check ann and adm, not mia. */
  privAdminOnly?: boolean;
  /** A body route whose validator may answer 422 before the guard does. */
  lenient?: boolean;
  /** Signed-out status for platform rows (default: not checked). */
  signedOut?: number[];
  note?: string;
};

const row = (spec: string, kind: Kind, o: Omit<Row, 'key' | 'kind'> = {}): Row => ({key: `${spec.split(' ')[0]} /site-api${spec.slice(spec.indexOf(' ') + 1)}`, kind, ...o});

const BODY_FOR_SIGNED_OUT = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/* ------------------------------------------------------------------------------- the table */

const TABLE: Row[] = [
  // ---- boards.ts ---------------------------------------------------------------------------
  row('GET /workspaces', 'self'),
  row('POST /workspaces', 'self', {path: () => '/workspaces', body: () => ({name: 'ZQXNEW workspace'})}),
  row('GET /workspaces/:id/boards', 'resource', {path: r => `/workspaces/${r.ws}/boards`}),
  row('POST /workspaces/:id/boards', 'resource', {path: r => `/workspaces/${r.ws}/boards`, body: () => ({name: 'x'}), min: 'member'}),
  // ---- board-extras.ts ---------------------------------------------------------------------
  row('GET /workspaces/:id/boards/archived', 'resource', {path: r => `/workspaces/${r.ws}/boards/archived`}),
  row('GET /boards/:id/archived-lanes', 'resource', {path: r => `/boards/${r.board}/archived-lanes`, priv: true}),
  row('GET /boards/:id/archived-cards', 'resource', {path: r => `/boards/${r.board}/archived-cards`, priv: true}),
  row('POST /boards/:id/duplicate', 'resource', {path: r => `/boards/${r.board}/duplicate`, body: () => ({}), min: 'member', priv: true}),
  // ---- board-share.ts: board admin (workspace admin and up here) + site:board:share (every default member holds it) ----
  row('GET /boards/:id/share', 'resource', {path: r => `/boards/${r.board}/share`, min: 'admin', priv: true, noPositive: true}),
  row('POST /boards/:id/share', 'resource', {path: r => `/boards/${r.board}/share`, body: () => ({}), min: 'admin', priv: true}),
  row('DELETE /boards/:id/share', 'resource', {path: r => `/boards/${r.board}/share`, min: 'admin', priv: true}),
  // ---- board-stale.ts: the stale card warning setting, board admin only (no site permission) ----
  row('GET /boards/:id/stale-days', 'resource', {path: r => `/boards/${r.board}/stale-days`, min: 'admin', priv: true, privAdminOnly: true}),
  row('PUT /boards/:id/stale-days', 'resource', {path: r => `/boards/${r.board}/stale-days`, body: () => ({staleDays: null}), min: 'admin', priv: true}),
  // ---- board-background.ts: the board's photo; changing it is for board admins, seeing it for anyone who sees the board ----
  row('POST /boards/:id/background/upload', 'resource', {
    path: r => `/boards/${r.board}/background/upload`,
    body: () => ({name: 'x.png', contentType: 'image/png', size: 100}),
    min: 'admin',
    priv: true,
  }),
  row('POST /boards/:id/background/:uploadId/complete', 'resource', {path: r => `/boards/${r.board}/background/${r.attach}/complete`, body: () => ({}), min: 'admin', priv: true}),
  row('GET /boards/:id/background', 'resource', {path: r => `/boards/${r.board}/background`, priv: true, noPositive: true}),
  row('DELETE /boards/:id/background', 'resource', {path: r => `/boards/${r.board}/background`, min: 'admin', priv: true}),
  row('GET /boards/:id', 'resource', {path: r => `/boards/${r.board}`, priv: true}),
  row('PATCH /boards/:id', 'resource', {path: r => `/boards/${r.board}`, body: () => ({name: 'x'}), min: 'member', priv: true}),
  row('PUT /boards/:id/star', 'resource', {path: r => `/boards/${r.board}/star`, body: () => ({}), priv: true}),
  row('DELETE /boards/:id/star', 'resource', {path: r => `/boards/${r.board}/star`, priv: true}),
  row('GET /boards/:id/rev', 'resource', {path: r => `/boards/${r.board}/rev`, priv: true}),
  row('GET /boards/:id/changes', 'resource', {path: r => `/boards/${r.board}/changes?since=0`, priv: true}),
  row('POST /boards/:id/lanes', 'resource', {path: r => `/boards/${r.board}/lanes`, body: () => ({name: 'x'}), min: 'member', priv: true}),
  row('PATCH /lanes/:id', 'resource', {path: r => `/lanes/${r.lane1}`, body: () => ({name: 'x'}), min: 'member', priv: true}),
  row('POST /lanes/:id/move', 'resource', {path: r => `/lanes/${r.lane1}/move`, body: () => ({afterId: null}), min: 'member', priv: true}),
  row('POST /lanes/:id/archive', 'resource', {path: r => `/lanes/${r.lane1}/archive`, body: () => ({}), min: 'member', priv: true}),
  // ---- lane-actions.ts: the "Lane actions" menu. Writes need a member; pin / watch are personal (any reader) ----
  row('POST /lanes/:id/copy', 'resource', {path: r => `/lanes/${r.lane1}/copy`, body: () => ({name: 'Copy'}), min: 'member', priv: true}),
  row('POST /lanes/:id/move-cards', 'resource', {path: r => `/lanes/${r.lane1}/move-cards`, body: r => ({toLaneId: Number(r.lane2)}), min: 'member', priv: true}),
  row('POST /lanes/:id/archive-cards', 'resource', {path: r => `/lanes/${r.lane1}/archive-cards`, body: () => ({}), min: 'member', priv: true}),
  row('POST /lanes/:id/sort', 'resource', {path: r => `/lanes/${r.lane1}/sort`, body: () => ({by: 'name'}), min: 'member', priv: true}),
  row('PUT /lanes/:id/prefs', 'resource', {path: r => `/lanes/${r.lane1}/prefs`, body: () => ({pinned: true}), priv: true}),
  row('POST /lanes/:id/restore', 'resource', {path: r => `/lanes/${r.lane1}/restore`, body: () => ({}), min: 'member', priv: true}),
  row('GET /lanes/:id/cards', 'resource', {path: r => `/lanes/${r.lane1}/cards`, priv: true}),
  row('POST /lanes/:id/cards', 'resource', {path: r => `/lanes/${r.lane1}/cards`, body: () => ({title: 'x'}), min: 'member', priv: true}),
  row('PATCH /cards/:id', 'resource', {path: r => `/cards/${r.card}`, body: () => ({title: 'x'}), min: 'member', priv: true}),
  row('POST /cards/:id/move', 'resource', {path: r => `/cards/${r.card}/move`, body: r => ({laneId: Number(r.lane2), afterId: null}), min: 'member', priv: true}),
  // ---- card-detail.ts: following a card is personal, reading it is enough (viewers may) ----
  row('PUT /cards/:id/watch', 'resource', {path: r => `/cards/${r.card}/watch`, body: () => ({}), priv: true}),
  row('DELETE /cards/:id/watch', 'resource', {path: r => `/cards/${r.card}/watch`, priv: true}),
  // ---- card-move-board.ts: to another board of the same workspace (the target needs write too) ----
  row('POST /cards/:id/move-to-board', 'resource', {path: r => `/cards/${r.card}/move-to-board`, body: r => ({boardId: Number(r.board), laneId: Number(r.lane2)}), min: 'member', priv: true}),
  row('POST /cards/:id/copy-to-board', 'resource', {path: r => `/cards/${r.card}/copy-to-board`, body: r => ({boardId: Number(r.board), laneId: Number(r.lane2)}), min: 'member', priv: true}),
  // ---- card-bulk.ts: bulk actions on the cards of one board (all ids must be live cards of THIS board) ----
  row('GET /boards/:id/labels', 'resource', {path: r => `/boards/${r.board}/labels`, priv: true}),
  // ---- board-workload.ts: who has how much open work on one board (read access) ----
  row('GET /boards/:id/workload', 'resource', {path: r => `/boards/${r.board}/workload`, priv: true}),
  // ---- board-people.ts: everyone on one board, names and board roles (read access) ----
  row('GET /boards/:id/people', 'resource', {path: r => `/boards/${r.board}/people`, priv: true}),
  // ---- board-members.ts --------------------------------------------------------------------
  row('GET /boards/:id/members', 'resource', {path: r => `/boards/${r.board}/members`, priv: true}),
  row('GET /boards/:id/members/candidates', 'resource', {path: r => `/boards/${r.board}/members/candidates`, min: 'admin', priv: true, privAdminOnly: true}),
  row('PUT /boards/:id/members/:userId', 'resource', {path: (r, f) => `/boards/${r.board}/members/${f.u.nick}`, body: () => ({role: 'member'}), min: 'admin', priv: true}),
  row('DELETE /boards/:id/members/:userId', 'resource', {path: r => `/boards/${r.board}/members/999999`, min: 'admin', priv: true}),
  row('POST /boards/:id/join', 'resource', {path: r => `/boards/${r.board}/join`, body: () => ({}), priv: true}),
  row('PATCH /boards/:id/sharing', 'resource', {path: r => `/boards/${r.board}/sharing`, body: () => ({selfJoin: true}), min: 'admin', priv: true}),
  row('GET /boards/:id/invites', 'resource', {path: r => `/boards/${r.board}/invites`, min: 'admin', priv: true, privAdminOnly: true}),
  row('POST /boards/:id/invites', 'resource', {path: r => `/boards/${r.board}/invites`, body: () => ({email: 'zqx-guest@example.test', role: 'member'}), min: 'admin', priv: true}),
  row('DELETE /boards/:id/invites/:inviteId', 'resource', {path: r => `/boards/${r.board}/invites/${r.invite}`, min: 'admin', priv: true}),
  row('GET /boards/:id/invite-link', 'resource', {path: r => `/boards/${r.board}/invite-link`, min: 'admin', priv: true, privAdminOnly: true}),
  row('POST /boards/:id/invite-link', 'resource', {path: r => `/boards/${r.board}/invite-link`, body: () => ({role: 'member'}), min: 'admin', priv: true}),
  row('DELETE /boards/:id/invite-link', 'resource', {path: r => `/boards/${r.board}/invite-link`, min: 'admin', priv: true}),
  row('GET /guest-boards', 'self'),
  row('POST /boards/:id/cards/bulk', 'resource', {path: r => `/boards/${r.board}/cards/bulk`, body: r => ({cardIds: [Number(r.card)], action: 'set_priority', priority: 'low'}), min: 'member', priv: true}),
  row('POST /cards/:id/archive', 'resource', {path: r => `/cards/${r.card}/archive`, body: () => ({}), min: 'member', priv: true}),
  row('POST /cards/:id/restore', 'resource', {path: r => `/cards/${r.card}/restore`, body: () => ({}), min: 'member', priv: true}),

  // ---- card-detail.ts ----------------------------------------------------------------------
  row('GET /cards/:id/detail', 'resource', {path: r => `/cards/${r.card}/detail`, priv: true}),
  row('PATCH /cards/:id/details', 'resource', {path: r => `/cards/${r.card}/details`, body: () => ({title: 'x'}), min: 'member', priv: true}),
  row('GET /cards/:id/activity', 'resource', {path: r => `/cards/${r.card}/activity`, priv: true}),
  row('GET /cards/:id/people', 'resource', {path: r => `/cards/${r.card}/people`, priv: true}),
  row('POST /boards/:id/labels', 'resource', {path: r => `/boards/${r.board}/labels`, body: () => ({name: 'x', colorHex: '#5B5BD6'}), min: 'member', priv: true}),
  row('PATCH /labels/:id', 'resource', {path: r => `/labels/${r.label}`, body: () => ({name: 'x'}), min: 'member', priv: true}),
  row('DELETE /labels/:id', 'resource', {path: r => `/labels/${r.label}`, min: 'member', priv: true}),
  // ---- card-fields.ts: custom fields and copy ----------------------------------------------
  row('GET /boards/:id/field-values', 'resource', {path: r => `/boards/${r.board}/field-values`, priv: true}),
  row('POST /boards/:id/fields', 'resource', {path: r => `/boards/${r.board}/fields`, body: () => ({name: 'ZQXF', type: 'text'}), min: 'member', priv: true}),
  row('PUT /boards/:id/fields/order', 'resource', {path: r => `/boards/${r.board}/fields/order`, body: r => ({ids: [Number(r.field)]}), min: 'member', priv: true}),
  row('PATCH /fields/:id', 'resource', {path: r => `/fields/${r.field}`, body: () => ({name: 'ZQXF2'}), min: 'member', priv: true}),
  row('DELETE /fields/:id', 'resource', {path: r => `/fields/${r.field}`, min: 'member', priv: true}),
  row('POST /fields/:id/options', 'resource', {path: r => `/fields/${r.field}/options`, body: () => ({name: 'ZQXO', colorHex: '#112233'}), min: 'member', priv: true}),
  row('PATCH /field-options/:id', 'resource', {path: r => `/field-options/${r.option}`, body: () => ({name: 'ZQXO2'}), min: 'member', priv: true}),
  row('DELETE /field-options/:id', 'resource', {path: r => `/field-options/${r.option}`, min: 'member', priv: true}),
  row('PUT /cards/:id/fields/:fieldId', 'resource', {path: r => `/cards/${r.card}/fields/${r.field}`, body: () => ({value: null}), min: 'member', priv: true}),
  row('POST /cards/:id/copy', 'resource', {path: r => `/cards/${r.card}/copy`, body: () => ({}), min: 'member', priv: true}),
  row('PUT /cards/:id/labels/:labelId', 'resource', {path: r => `/cards/${r.card}/labels/${r.label}`, body: () => ({}), min: 'member', priv: true}),
  row('DELETE /cards/:id/labels/:labelId', 'resource', {path: r => `/cards/${r.card}/labels/${r.label}`, min: 'member', priv: true}),
  row('PUT /cards/:id/members/:userId', 'resource', {path: (r, f) => `/cards/${r.card}/members/${f.u.mia}`, body: () => ({}), min: 'member', priv: true}),
  row('DELETE /cards/:id/members/:userId', 'resource', {path: (r, f) => `/cards/${r.card}/members/${f.u.mia}`, min: 'member', priv: true}),
  row('POST /cards/:id/checklists', 'resource', {path: r => `/cards/${r.card}/checklists`, body: () => ({title: 'x'}), min: 'member', priv: true}),
  row('PATCH /checklists/:id', 'resource', {path: r => `/checklists/${r.checklist}`, body: () => ({title: 'x'}), min: 'member', priv: true}),
  row('DELETE /checklists/:id', 'resource', {path: r => `/checklists/${r.checklist}`, min: 'member', priv: true}),
  row('POST /checklists/:id/items', 'resource', {path: r => `/checklists/${r.checklist}/items`, body: () => ({text: 'x'}), min: 'member', priv: true}),
  row('PATCH /checklist-items/:id', 'resource', {path: r => `/checklist-items/${r.item}`, body: () => ({done: true}), min: 'member', priv: true}),
  row('DELETE /checklist-items/:id', 'resource', {path: r => `/checklist-items/${r.item}`, min: 'member', priv: true}),
  row('GET /cards/:id/comments', 'resource', {path: r => `/cards/${r.card}/comments`, priv: true}),
  row('POST /cards/:id/comments', 'resource', {path: r => `/cards/${r.card}/comments`, body: () => ({body: 'x'}), min: 'member', priv: true}),
  row('PATCH /comments/:id', 'resource', {path: r => `/comments/${r.comment}`, body: () => ({body: 'x'}), min: 'member', priv: true, below: [403, 404]}),
  row('DELETE /comments/:id', 'resource', {path: r => `/comments/${r.comment}`, min: 'member', priv: true, below: [403, 404]}),
  row('PUT /comments/:id/reactions', 'resource', {path: r => `/comments/${r.comment}/reactions`, body: () => ({emoji: '👍'}), min: 'member', priv: true, below: [403, 404]}),
  row('DELETE /comments/:id/reactions', 'resource', {path: r => `/comments/${r.comment}/reactions`, body: () => ({emoji: '👍'}), min: 'member', priv: true, below: [403, 404]}),
  row('POST /cards/:id/attachments/link', 'resource', {path: r => `/cards/${r.card}/attachments/link`, body: () => ({url: 'https://example.test/x'}), min: 'member', priv: true}),
  row('POST /cards/:id/attachments/upload', 'resource', {
    path: r => `/cards/${r.card}/attachments/upload`,
    body: () => ({name: 'x.png', contentType: 'image/png', size: 100}),
    min: 'member',
    priv: true,
  }),
  row('POST /attachments/:id/complete', 'resource', {path: r => `/attachments/${r.attach}/complete`, body: () => ({}), min: 'member', priv: true, below: [403, 404]}),
  row('GET /attachments/:id/view', 'resource', {path: r => `/attachments/${r.attach}/view`, priv: true, noPositive: true}),
  row('PATCH /attachments/:id', 'resource', {path: r => `/attachments/${r.attach}`, body: () => ({name: 'x'}), min: 'member', priv: true, below: [403, 404]}),
  row('DELETE /attachments/:id', 'resource', {path: r => `/attachments/${r.attach}`, min: 'member', priv: true, below: [403, 404]}),
  row('PUT /cards/:id/cover', 'resource', {path: r => `/cards/${r.card}/cover`, body: () => ({attachmentId: null}), min: 'member', priv: true}),

  // ---- card-recurrence.ts: through the card (cardCtx): a viewer may read, writing needs a member ----
  row('GET /cards/:id/recurrence', 'resource', {path: r => `/cards/${r.card}/recurrence`, priv: true}),
  row('PUT /cards/:id/recurrence', 'resource', {
    path: r => `/cards/${r.card}/recurrence`,
    body: () => ({frequency: 'weekly', interval: 1, startOn: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), endsOn: null}),
    min: 'member',
    priv: true,
  }),
  row('DELETE /cards/:id/recurrence', 'resource', {path: r => `/cards/${r.card}/recurrence`, min: 'member', priv: true}),
  // ---- card-templates.ts: reading is any seat; saving needs a member; deleting the author or a workspace admin (the fixture's author is the owner) ----
  row('GET /workspaces/:id/card-templates', 'resource', {path: r => `/workspaces/${r.ws}/card-templates`}),
  row('POST /workspaces/:id/card-templates', 'resource', {path: r => `/workspaces/${r.ws}/card-templates`, body: () => ({name: 'ZQXT', payload: {title: 'x'}}), min: 'member'}),
  row('POST /cards/:id/save-template', 'resource', {path: r => `/cards/${r.card}/save-template`, body: () => ({name: 'ZQXT'}), min: 'member', priv: true}),
  row('POST /cards/:id/apply-template', 'resource', {path: r => `/cards/${r.card}/apply-template`, body: r => ({templateId: Number(r.template)}), min: 'member', priv: true}),
  row('DELETE /card-templates/:id', 'resource', {path: r => `/card-templates/${r.template}`, min: 'admin'}),
  // ---- flows.ts: site:board:flows (every default member holds it) + board admin (workspace admin and up here); a non-seat on a private board gets 404 ----
  row('GET /boards/:id/flows', 'resource', {path: r => `/boards/${r.board}/flows`, min: 'admin', priv: true, privAdminOnly: true}),
  row('POST /boards/:id/flows', 'resource', {
    path: r => `/boards/${r.board}/flows`,
    body: () => ({name: 'ZQXFLOW', trigger: {kind: 'card_created'}, actions: [{type: 'comment', body: 'x'}]}),
    min: 'admin',
    priv: true,
  }),
  row('PATCH /flows/:id', 'resource', {path: r => `/flows/${r.flow}`, body: () => ({name: 'ZQXFLOW2'}), min: 'admin', priv: true}),
  row('DELETE /flows/:id', 'resource', {path: r => `/flows/${r.flow}`, min: 'admin', priv: true}),

  // ---- chat.ts / chat-extras.ts ------------------------------------------------------------
  row('GET /chat/pulse', 'self'),
  row('GET /workspaces/:id/conversations', 'resource', {path: r => `/workspaces/${r.ws}/conversations`}),
  row('POST /workspaces/:id/conversations', 'resource', {path: r => `/workspaces/${r.ws}/conversations`, body: () => ({kind: 'channel', name: 'x'}), min: 'member'}),
  row('GET /boards/:id/conversation', 'resource', {path: r => `/boards/${r.board}/conversation`, priv: true}),
  row('GET /conversations/:id/messages', 'resource', {path: r => `/conversations/${r.conv}/messages`, priv: true}),
  row('POST /conversations/:id/messages', 'resource', {path: r => `/conversations/${r.conv}/messages`, body: () => ({body: 'x', clientId: 'authz-client-1'}), min: 'member', priv: true}),
  row('POST /conversations/:id/read', 'resource', {path: r => `/conversations/${r.conv}/read`, body: () => ({seq: 0}), priv: true}),
  row('PUT /conversations/:id/mute', 'resource', {path: r => `/conversations/${r.conv}/mute`, body: () => ({}), priv: true}),
  row('DELETE /conversations/:id/mute', 'resource', {path: r => `/conversations/${r.conv}/mute`, priv: true}),
  row('PATCH /messages/:id', 'resource', {path: r => `/messages/${r.msg}`, body: () => ({body: 'x'}), min: 'member', priv: true, below: [403, 404]}),
  row('DELETE /messages/:id', 'resource', {path: r => `/messages/${r.msg}`, min: 'member', priv: true, below: [403, 404]}),
  row('PUT /messages/:id/reactions', 'resource', {path: r => `/messages/${r.msg}/reactions`, body: () => ({emoji: '👍'}), min: 'member', priv: true}),
  row('DELETE /messages/:id/reactions', 'resource', {path: r => `/messages/${r.msg}/reactions`, body: () => ({emoji: '👍'}), priv: true}),
  row('PUT /messages/:id/pin', 'resource', {path: r => `/messages/${r.msg}/pin`, body: () => ({}), min: 'admin', priv: true}),
  row('DELETE /messages/:id/pin', 'resource', {path: r => `/messages/${r.msg}/pin`, min: 'admin', priv: true}),
  row('POST /messages/:id/card', 'resource', {path: r => `/messages/${r.msg}/card`, body: r => ({laneId: Number(r.lane1)}), min: 'member', priv: true, below: [403, 404]}),
  row('GET /conversations/:id', 'resource', {path: r => `/conversations/${r.conv}`, priv: true}),
  row('GET /cards/refs', 'self', {path: (_r, f) => `/cards/refs?ids=${f.pub.card},${f.priv.card},${f.other.card}`}),
  row('GET /workspaces/:id/members/search', 'resource', {path: r => `/workspaces/${r.ws}/members/search?q=zq`}),

  // ---- branding.ts -------------------------------------------------------------------------
  row('GET /brand.css', 'public', {path: () => '/brand.css', note: 'the brand colour as CSS; nothing personal'}),
  row('GET /branding', 'perm', {path: () => '/branding'}),
  row('PUT /branding', 'perm', {path: () => '/branding', body: () => ({brandColor: null}), lenient: true}),
  // ---- billing.ts --------------------------------------------------------------------------
  row('GET /workspaces/:id/billing', 'resource', {path: r => `/workspaces/${r.ws}/billing`}),
  row('POST /workspaces/:id/billing/checkout', 'resource', {path: r => `/workspaces/${r.ws}/billing/checkout`, body: () => ({plan: 'pro'}), min: 'admin'}),
  row('GET /billing/public-plans', 'public', {path: () => '/billing/public-plans', note: 'the public pricing table; plan numbers only'}),
  row('GET /billing/mine', 'self'),
  row('GET /billing/settings', 'perm', {path: () => '/billing/settings'}),
  row('PUT /billing/settings', 'perm', {path: () => '/billing/settings', body: () => ({billingMode: 'PAID', graceDays: 7}), lenient: true}),
  row('GET /billing/plans', 'perm', {path: () => '/billing/plans'}),
  row('PATCH /billing/plans/:plan', 'perm', {
    path: () => '/billing/plans/free',
    body: () => ({maxMembers: 5, maxFileMb: 5, storageGb: 1, maxFlows: 1, auditLog: false}),
    lenient: true,
  }),
  row('GET /billing/workspaces', 'perm', {path: () => '/billing/workspaces'}),

  // ---- members.ts --------------------------------------------------------------------------
  row('GET /workspaces/:id/members', 'resource', {path: r => `/workspaces/${r.ws}/members`}),
  row('PATCH /workspaces/:id/members/:userId', 'resource', {path: (r, f) => `/workspaces/${r.ws}/members/${f.u.nick}`, body: () => ({role: 'viewer'}), min: 'admin'}),
  row('DELETE /workspaces/:id/members/:userId', 'resource', {path: (r, f) => `/workspaces/${r.ws}/members/${f.u.nick}`, min: 'admin'}),
  row('POST /workspaces/:id/leave', 'resource', {path: r => `/workspaces/${r.ws}/leave`, body: () => ({})}),
  row('GET /workspaces/:id/join-links', 'resource', {path: r => `/workspaces/${r.ws}/join-links`, min: 'admin'}),
  row('POST /workspaces/:id/join-links', 'resource', {path: r => `/workspaces/${r.ws}/join-links`, body: () => ({}), min: 'admin'}),
  row('DELETE /workspaces/:id/join-links/:linkId', 'resource', {path: r => `/workspaces/${r.ws}/join-links/${r.link}`, min: 'admin'}),
  row('GET /workspaces/:id/invites', 'resource', {path: r => `/workspaces/${r.ws}/invites`, min: 'admin'}),
  row('POST /workspaces/:id/invites', 'resource', {path: r => `/workspaces/${r.ws}/invites`, body: () => ({}), min: 'admin'}),
  row('DELETE /workspaces/:id/invites/:inviteId', 'resource', {path: r => `/workspaces/${r.ws}/invites/${r.invite}`, min: 'admin'}),
  row('POST /workspaces/:id/invites/:inviteId/email', 'resource', {path: r => `/workspaces/${r.ws}/invites/${r.invite}/email`, body: () => ({email: 'zqx-nobody@example.test'}), min: 'admin'}),
  row('POST /invites/accept', 'self', {path: () => '/invites/accept', body: () => ({token: `iv_${'A'.repeat(43)}`}), lenient: true}),

  // ---- workspace-audit.ts ------------------------------------------------------------------
  row('GET /workspaces/:id/audit', 'resource', {path: r => `/workspaces/${r.ws}/audit`, min: 'admin'}),

  // ---- workspace-settings.ts ---------------------------------------------------------------
  row('PATCH /workspaces/:id', 'resource', {path: r => `/workspaces/${r.ws}`, body: () => ({name: 'x'}), min: 'admin'}),
  row('POST /workspaces/:id/transfer', 'resource', {path: r => `/workspaces/${r.ws}/transfer`, body: (_r, f) => ({userId: f.u.nick}), min: 'owner'}),
  // A wrong confirmName: the owner gets 422 and nothing is archived, so later rows keep their fixtures.
  row('POST /workspaces/:id/archive', 'resource', {path: r => `/workspaces/${r.ws}/archive`, body: () => ({confirmName: 'zqx-not-the-name'}), min: 'owner', lenient: true}),
  // Not behind the workspace guard (it hides archived ones): everyone but an owner of an archived workspace gets 404.
  row('POST /workspaces/:id/restore', 'resource', {path: r => `/workspaces/${r.ws}/restore`, body: () => ({}), min: 'owner', below: [404], lenient: true}),
  row('GET /workspaces/archived', 'self'),
  row('GET /preferences', 'self'),
  // account-preflight.ts: the viewer's own blockers only (the session id is the only id used)
  row('GET /account/delete-preflight', 'self'),
  row('PATCH /preferences', 'self', {path: () => '/preferences', body: () => ({density: 'comfortable'}), lenient: true}),

  // ---- notifications.ts --------------------------------------------------------------------
  row('GET /notifications', 'self'),
  row('GET /notifications/unread-count', 'self'),
  row('POST /notifications/read-all', 'self', {path: () => '/notifications/read-all', body: () => ({})}),
  row('POST /notifications/:id/read', 'self', {path: (_r, f) => `/notifications/${f.notifA}/read`, body: () => ({})}),

  // ---- search.ts ---------------------------------------------------------------------------
  row('GET /workspaces/:id/search', 'resource', {path: r => `/workspaces/${r.ws}/search?q=zqx`}),
  row('GET /my-day', 'self'),
  row('GET /workspaces/:id/inbox', 'resource', {path: r => `/workspaces/${r.ws}/inbox`}),
  row('POST /workspaces/:id/inbox/cards', 'resource', {path: r => `/workspaces/${r.ws}/inbox/cards`, body: () => ({title: 'x'}), min: 'member'}),
  row('POST /inbox/cards/:id/triage', 'resource', {path: r => `/inbox/cards/${r.inboxCard}/triage`, body: r => ({laneId: Number(r.lane1)}), min: 'member', below: [403, 404]}),

  // ---- saved-filters.ts: personal; an id that is not mine (here a card id) is a 404 for everybody ---------------
  row('GET /boards/:id/saved-filters', 'resource', {path: r => `/boards/${r.board}/saved-filters`, priv: true}),
  row('POST /boards/:id/saved-filters', 'resource', {path: r => `/boards/${r.board}/saved-filters`, body: () => ({name: 'zqx', filter: {priority: 'high'}}), priv: true}),
  row('PATCH /saved-filters/:id', 'resource', {path: r => `/saved-filters/${r.card}`, body: () => ({name: 'x'}), lenient: true}),
  row('DELETE /saved-filters/:id', 'resource', {path: r => `/saved-filters/${r.card}`}),

  // ---- import-export.ts: import needs a seat that can write; export needs board admin (workspace admin and up here) ---
  row('POST /workspaces/:id/import/trello/dry-run', 'resource', {
    path: r => `/workspaces/${r.ws}/import/trello/dry-run`,
    body: () => ({lanes: 1, labels: 0, cards: 1, maxLaneCards: 1, checklists: 0, comments: 0}),
    min: 'member',
  }),
  row('POST /workspaces/:id/import/trello/start', 'resource', {
    path: r => `/workspaces/${r.ws}/import/trello/start`,
    body: () => ({importId: 'authz-matrix-import', name: 'ZQX import', lanes: [{ext: 'l1', name: 'Todo'}], labels: [], totalCards: 1}),
    min: 'member',
  }),
  row('POST /boards/:id/import/trello/cards', 'resource', {
    path: r => `/boards/${r.board}/import/trello/cards`,
    body: () => ({
      importId: 'authz-matrix-import',
      cards: [{ext: 'c1', lane: 'l1', title: 'x', desc: '', due: null, done: false, labels: [], checklists: [], comments: [], links: []}],
    }),
    min: 'member',
    priv: true,
  }),
  row('GET /boards/:id/export.json', 'resource', {path: r => `/boards/${r.board}/export.json`, min: 'admin', priv: true, noPositive: true}),
  row('GET /boards/:id/export.csv', 'resource', {path: r => `/boards/${r.board}/export.csv`, min: 'admin', priv: true, noPositive: true}),

  // ---- checkout.ts: guests may start a checkout; the platform decides (payments.md) ---------
  row('POST /checkout', 'platform', {note: 'guest checkout, own formCsrf; the amount comes from the catalogue'}),
  row('GET /checkout/gateways', 'public', {path: () => '/checkout/gateways?price=none'}),
  row('GET /checkout/:id', 'public', {path: () => '/checkout/chk_unknown', note: 'unauthenticated by design; id is the capability'}),
  // ---- files.ts: dev-only stand-in for the platform's upload URL (404s unless no Site Key + dev build); the id is the capability
  row('PUT /dev-files/:id', 'public', {path: () => '/dev-files/file_unknown'}),
  row('GET /dev-files/:id', 'public', {path: () => '/dev-files/file_unknown'}),
  row('GET /memberships', 'self'),
  row('POST /memberships/:id/cancel', 'self', {path: () => '/memberships/sub_zqx/cancel', body: () => ({})}),

  // ---- app.ts ------------------------------------------------------------------------------
  row('GET /health', 'public', {path: () => '/health'}),
  row('GET /me', 'platform', {signedOut: [200]}),
  row('GET /site', 'public', {path: () => '/site'}),
  row('GET /public/boards/:token', 'public', {path: () => `/public/boards/${'A'.repeat(43)}`, note: 'the share token is the capability; unknown token answers 404'}),
  row('GET /notification-email', 'self'),
  row('PATCH /notification-email', 'self', {path: () => '/notification-email', body: () => ({mode: 'off'})}),
  row('GET /morning-digest', 'self'),
  row('PATCH /morning-digest', 'self', {path: () => '/morning-digest', body: () => ({hour: null})}),

  // ---- /admin (src/platform/auth/admin.ts, site permissions) -------------------------------
  row('GET /admin/users', 'perm', {path: () => '/admin/users'}),
  row('GET /admin/users/:id', 'perm', {path: (_r, f) => `/admin/users/${f.u.mia}`}),
  row('PATCH /admin/users/:id', 'perm', {path: (_r, f) => `/admin/users/${f.u.mia}`, body: () => ({name: 'x'}), lenient: true}),
  row('PUT /admin/users/:id/roles', 'perm', {path: (_r, f) => `/admin/users/${f.u.mia}/roles`, body: () => ({roles: ['user']}), lenient: true}),
  row('POST /admin/users/:id/sessions/revoke', 'perm', {path: (_r, f) => `/admin/users/${f.u.mia}/sessions/revoke`, body: () => ({}), lenient: true}),
  row('POST /admin/users/:id/two-factor/disable', 'perm', {path: (_r, f) => `/admin/users/${f.u.mia}/two-factor/disable`, body: () => ({}), lenient: true}),
  row('GET /admin/roles', 'perm', {path: () => '/admin/roles'}),
  row('GET /admin/permissions', 'perm', {path: () => '/admin/permissions'}),
  row('POST /admin/roles', 'perm', {path: () => '/admin/roles', body: () => ({slug: 'zqx-role', name: 'Zqx role', permissions: []}), lenient: true}),
  row('PATCH /admin/roles/:slug', 'perm', {path: () => '/admin/roles/zqx-role', body: () => ({name: 'x'}), lenient: true}),
  row('DELETE /admin/roles/:slug', 'perm', {path: () => '/admin/roles/zqx-role'}),
  row('GET /admin/audit', 'perm', {path: () => '/admin/audit'}),

  // ---- /auth (src/platform/auth/routes.ts: the platform's sign-in system, tested in auth*.test.ts) ----
  row('GET /auth/owner', 'platform'),
  row('POST /auth/owner', 'platform'),
  row('POST /auth/code', 'platform'),
  row('POST /auth/code/verify', 'platform'),
  row('POST /auth/login/two-factor', 'platform'),
  row('GET /auth/two-factor', 'platform', {signedOut: [401]}),
  row('POST /auth/two-factor/setup', 'platform'),
  row('POST /auth/two-factor/enable', 'platform'),
  row('POST /auth/two-factor/disable', 'platform'),
  row('POST /auth/two-factor/recovery-codes', 'platform'),
  row('POST /auth/email', 'platform'),
  row('POST /auth/email/confirm', 'platform'),
  row('POST /auth/email/cancel', 'platform'),
  row('GET /auth/sessions', 'platform', {signedOut: [401]}),
  row('DELETE /auth/sessions/:id', 'platform', {signedOut: [401]}),
  row('POST /auth/delete-account', 'platform'),
  row('GET /auth/csrf', 'platform', {signedOut: [200]}),
  row('POST /auth/register', 'platform'),
  row('POST /auth/register/verify', 'platform'),
  row('POST /auth/verify-email', 'platform'),
  row('POST /auth/resend-verification', 'platform'),
  row('POST /auth/login', 'platform'),
  row('POST /auth/refresh', 'platform'),
  row('POST /auth/logout', 'platform'),
  row('POST /auth/logout-all', 'platform'),
  row('GET /auth/me', 'platform', {signedOut: [401]}),
  row('PATCH /auth/me', 'platform'),
  row('POST /auth/forgot-password', 'platform'),
  row('POST /auth/reset-password', 'platform'),
  row('POST /auth/change-password', 'platform'),
];

/* ------------------------------------------------------------------------------- meta-test */

describe('authz matrix: coverage', () => {
  it('lists every route of the Hono app, and nothing that is gone', () => {
    // `ALL` entries are middleware (`.use('/chat/*', …)`), not routes.
    const mounted = new Set(app.routes.filter(r => r.method !== 'ALL').map(r => `${r.method} ${r.path}`));
    const listed = new Set(TABLE.map(r => r.key));
    expect(TABLE.length, 'duplicate rows').toBe(listed.size);
    expect([...mounted].filter(k => !listed.has(k)).sort(), 'routes missing from the table').toEqual([]);
    expect([...listed].filter(k => !mounted.has(k)).sort(), 'table rows without a route').toEqual([]);
  });

  it('gives every resource, self and permission row a path (or a plain GET)', () => {
    for (const r of TABLE) {
      if (r.kind === 'platform') continue;
      if (!r.path) expect(r.key.startsWith('GET '), r.key).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------------------- fixtures */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const SECRET_RE = /password_?hash/i;
const SEEDED = ['ann', 'adm', 'mia', 'vic', 'nick', 'bob'].map(n => `${n}@example.test`);

const A_MARK = /ZQXALPHA|ZQXPRIV/; // everything of workspace A
const PRIV_MARK = /ZQXPRIV/; // the private board and its chat
const B_MARK = /ZQXBETA/; // everything of workspace B

describe.skipIf(!DATABASE_URL)('authz matrix (integration, real Postgres)', () => {
  let anon: Browser;
  let siteOwner: Browser; // the SITE owner (first account), holds site permissions; none of the six do
  let ann: Browser; // owner of A
  let adm: Browser; // admin of A
  let mia: Browser; // member of A, and a member of the private board
  let vic: Browser; // viewer of A
  let nick: Browser; // member of A, NOT on the private board
  let bob: Browser; // owner of B
  let f: Fx;

  beforeAll(async () => {
    configureEnv();
    await resetDatabase();
    anon = new Browser(app, '203.0.113.50');
    // In this harness there is no SITE_OWNER_EMAILS and the build is not production, so the platform's
    // `first` owner mode (src/platform/auth/settings.ts ownerClaimMode) makes the FIRST account to register the
    // SITE owner. That must be a dedicated account, never one of the six workspace users below, or the
    // "no site permission" rows would test a site owner. (Live, with no owner address, the mode is `off`.)
    siteOwner = await signedIn(app, 'root@example.test', undefined, '203.0.113.49');
    ann = await signedIn(app, 'ann@example.test', undefined, '203.0.113.51');
    adm = await signedIn(app, 'adm@example.test', undefined, '203.0.113.52');
    mia = await signedIn(app, 'mia@example.test', undefined, '203.0.113.53');
    vic = await signedIn(app, 'vic@example.test', undefined, '203.0.113.54');
    nick = await signedIn(app, 'nick@example.test', undefined, '203.0.113.55');
    bob = await signedIn(app, 'bob@example.test', undefined, '203.0.113.56');
    const u = {
      ann: await userId('ann@example.test'),
      adm: await userId('adm@example.test'),
      mia: await userId('mia@example.test'),
      vic: await userId('vic@example.test'),
      nick: await userId('nick@example.test'),
      bob: await userId('bob@example.test'),
    };

    const wsA = (await ann.post('/site-api/workspaces', {name: 'ZQXALPHA workspace'})).json.workspace.id as number;
    const wsB = (await bob.post('/site-api/workspaces', {name: 'ZQXBETA workspace'})).json.workspace.id as number;
    for (const [id, role] of [[u.adm, 'admin'], [u.mia, 'member'], [u.vic, 'viewer'], [u.nick, 'member']] as const) {
      await db.workspaceMember.create({data: {workspaceId: wsA, userId: id, role}});
    }

    const make = async (owner: Browser, ownerId: number, workspaceId: number, tag: string, visibility: 'workspace' | 'private'): Promise<RS> => {
      const made = await owner.post(`/site-api/workspaces/${workspaceId}/boards`, {
        name: `ZQX${tag} board`,
        visibility,
        lanes: [`ZQX${tag} todo`, `ZQX${tag} doing`],
      });
      if (made.status !== 201) throw new Error(`board ${made.status} ${JSON.stringify(made.json)}`);
      const boardId = made.json.board.id as number;
      const got = await owner.get(`/site-api/boards/${boardId}`);
      const [lane1, lane2] = [got.json.lanes[0].id as number, got.json.lanes[1].id as number];
      const cards = await owner.post(`/site-api/lanes/${lane1}/cards`, {titles: [`ZQX${tag} card one`, `ZQX${tag} card two`]});
      if (cards.status !== 201) throw new Error(`cards ${cards.status} ${JSON.stringify(cards.json)}`);
      const [card, card2] = [cards.json.items[0].id as number, cards.json.items[1].id as number];
      const label = await db.label.create({data: {boardId, workspaceId, name: `ZQX${tag} label`, colorHex: '#5B5BD6'}, select: {id: true}});
      const field = await db.customField.create({data: {boardId, workspaceId, name: `ZQX${tag} field`, type: 'dropdown'}, select: {id: true}});
      const option = await db.customFieldOption.create({data: {fieldId: field.id, workspaceId, name: `ZQX${tag} option`, colorHex: '#5B5BD6'}, select: {id: true}});
      const checklist = await db.checklist.create({data: {cardId: card, workspaceId, title: `ZQX${tag} checklist`, position: 'a0'}, select: {id: true}});
      const item = await db.checklistItem.create({data: {checklistId: checklist.id, workspaceId, text: `ZQX${tag} item`, position: 'a0'}, select: {id: true}});
      const comment = await db.comment.create({data: {cardId: card, workspaceId, authorId: ownerId, bodyMd: `ZQX${tag} comment`}, select: {id: true}});
      const attach = await db.attachment.create({
        data: {workspaceId, cardId: card, url: 'https://example.test/zqx', name: `ZQX${tag} attachment`, ready: true, uploadedBy: ownerId},
        select: {id: true},
      });
      const conv =
        visibility === 'private'
          ? await db.conversation.create({data: {workspaceId, boardId, kind: 'board', createdBy: ownerId, lastSeq: 1n}, select: {id: true}})
          : await db.conversation.create({data: {workspaceId, kind: 'channel', name: `ZQX${tag} channel`, createdBy: ownerId, lastSeq: 1n}, select: {id: true}});
      const msg = await db.message.create({
        data: {conversationId: conv.id, workspaceId, seq: 1n, senderId: ownerId, bodyMd: `ZQX${tag} message`, clientId: `seed-${tag}-0001`},
        select: {id: true},
      });
      const invite = await db.workspaceInvite.create({
        data: {workspaceId, tokenHash: `${tag.toLowerCase()}${'0'.repeat(64)}`.slice(0, 64), role: 'member', expiresAt: new Date(Date.now() + 86_400_000), createdBy: ownerId},
        select: {id: true},
      });
      const link = await db.workspaceJoinLink.create({
        data: {workspaceId, tokenHash: `${tag.toLowerCase()}${'1'.repeat(64)}`.slice(0, 64), role: 'viewer', expiresAt: new Date(Date.now() + 86_400_000), maxUses: 5, createdBy: ownerId},
        select: {id: true},
      });
      await owner.post(`/site-api/workspaces/${workspaceId}/inbox/cards`, {title: `ZQX${tag} inbox`});
      const inbox = await db.card.findFirst({where: {workspaceId, board: {inboxOf: ownerId}}, select: {id: true}});
      if (!inbox) throw new Error(`no inbox card for ${tag}`);
      const flow = await db.flow.create({
        data: {
          boardId,
          workspaceId,
          name: `ZQX${tag} flow`,
          triggerKind: 'card_created',
          config: {trigger: {kind: 'card_created', laneId: null}, conditions: {labelId: null}, actions: [{type: 'comment', body: `ZQX${tag} flow comment`}]},
          createdBy: ownerId,
        },
        select: {id: true},
      });
      const template = await db.cardTemplate.create({
        data: {workspaceId, kind: 'card', name: `ZQX${visibility === 'private' ? 'ALPHA' : tag} template`, payload: {title: 'template card'}, createdBy: ownerId},
        select: {id: true},
      });
      return {
        flow: String(flow.id),
        template: String(template.id),
        ws: String(workspaceId),
        board: String(boardId),
        lane1: String(lane1),
        lane2: String(lane2),
        card: String(card),
        card2: String(card2),
        label: String(label.id),
        field: String(field.id),
        option: String(option.id),
        checklist: String(checklist.id),
        item: String(item.id),
        comment: String(comment.id),
        attach: String(attach.id),
        conv: String(conv.id),
        msg: String(msg.id),
        invite: String(invite.id),
        link: String(link.id),
        inboxCard: String(inbox.id),
      };
    };

    const pub = await make(ann, u.ann, wsA, 'ALPHA', 'workspace');
    const priv = await make(ann, u.ann, wsA, 'PRIV', 'private');
    const other = await make(bob, u.bob, wsB, 'BETA', 'workspace');
    // Only mia has a seat on the private board; admins and owners see it through their role.
    await db.boardMember.create({data: {boardId: Number(priv.board), userId: u.mia, workspaceId: wsA, role: 'member'}});

    const notifA = await db.notification.create({data: {userId: u.ann, workspaceId: wsA, kind: 'comment', boardId: Number(pub.board), cardId: Number(pub.card)}, select: {id: true}});
    const notifB = await db.notification.create({data: {userId: u.bob, workspaceId: wsB, kind: 'comment', boardId: Number(other.board), cardId: Number(other.card)}, select: {id: true}});
    const attachB = await db.attachment.create({
      data: {workspaceId: wsB, cardId: Number(other.card), url: 'https://example.test/zqxbeta.png', name: 'ZQXBETA image', contentType: 'image/png', ready: true, uploadedBy: u.bob},
      select: {id: true},
    });
    f = {pub, priv, other, u, notifA: String(notifA.id), notifB: String(notifB.id), attachB: String(attachB.id)};
  });
  afterAll(() => db.$disconnect());

  /* --------------------------------------------------------------------------- helpers */

  type Actor = {name: string; b: Browser; forbid: RegExp};
  const actors = (): Record<'anon' | 'ann' | 'adm' | 'mia' | 'vic' | 'nick' | 'bob', Actor> => ({
    anon: {name: 'signed-out', b: anon, forbid: /ZQX/},
    ann: {name: 'owner A', b: ann, forbid: B_MARK},
    adm: {name: 'admin A', b: adm, forbid: B_MARK},
    mia: {name: 'member A (board member)', b: mia, forbid: B_MARK},
    vic: {name: 'viewer A', b: vic, forbid: /ZQXPRIV|ZQXBETA/},
    nick: {name: 'member A (not on private board)', b: nick, forbid: /ZQXPRIV|ZQXBETA/},
    bob: {name: 'owner B', b: bob, forbid: A_MARK},
  });
  const ROLE_ACTOR = {viewer: 'vic', member: 'nick', admin: 'adm', owner: 'ann'} as const;

  /** One request; records every violation of the "no secrets, no foreign data" rules in `problems`. */
  async function hit(problems: string[], who: Actor, method: string, path: string, body?: unknown) {
    const res = await who.b.request(method, `/site-api${path}`, BODY_FOR_SIGNED_OUT.has(method) ? (body ?? {}) : undefined);
    const text = JSON.stringify(res.json);
    const label = `${who.name} ${method} ${path}`;
    const email = text.match(EMAIL_RE);
    if (email) problems.push(`${label}: response contains an e-mail address (${email[0]})`);
    for (const seeded of SEEDED) if (text.toLowerCase().includes(seeded)) problems.push(`${label}: response contains ${seeded}`);
    if (SECRET_RE.test(text)) problems.push(`${label}: response contains a password hash field`);
    if (who.forbid.test(text)) problems.push(`${label}: response (${res.status}) leaks data this user may not see`);
    return res.status;
  }
  const expectIn = (problems: string[], who: Actor, method: string, path: string, got: number, want: number[], why: string) => {
    if (!want.includes(got)) problems.push(`${who.name} ${method} ${path}: ${why}: expected ${want.join('/')}, got ${got}`);
  };

  /* --------------------------------------------------------------------------- the matrix */

  const resourceRows = TABLE.filter(r => r.kind === 'resource');
  const selfRows = TABLE.filter(r => r.kind === 'self');
  const permRows = TABLE.filter(r => r.kind === 'perm');
  const publicRows = TABLE.filter(r => r.kind === 'public');
  const platformRows = TABLE.filter(r => r.kind === 'platform');

  it.each(resourceRows.map(r => [r.key, r] as const))('%s', async (_key, r) => {
    const A = actors();
    const method = r.key.split(' ')[0]!;
    const isRead = method === 'GET';
    const min = r.min ?? 'viewer';
    const problems: string[] = [];
    const pathOf = (rs: RS) => r.path!(rs, f);
    const bodyOf = (rs: RS) => r.body?.(rs, f);
    const call = (who: Actor, rs: RS) => hit(problems, who, method, pathOf(rs), bodyOf(rs));

    // 1. Signed out: 401 (a body validator may answer 422 first).
    let s = await call(A.anon, f.pub);
    expectIn(problems, A.anon, method, pathOf(f.pub), s, r.body ? [401, 422] : [401], 'signed out');

    // 2. A user of another workspace: 404, never 403 or 200, on the workspace and on its private board.
    for (const rs of r.priv ? [f.pub, f.priv] : [f.pub]) {
      s = await call(A.bob, rs);
      expectIn(problems, A.bob, method, pathOf(rs), s, [404], 'outsider (other workspace)');
    }
    // ... and the owner of A is an outsider in B.
    s = await call(A.ann, f.other);
    expectIn(problems, A.ann, method, pathOf(f.other), s, [404], 'A owner on a workspace B resource');
    s = await call(A.vic, f.other);
    expectIn(problems, A.vic, method, pathOf(f.other), s, [404], 'A viewer on a workspace B resource');

    // 3. A role below the route's minimum.
    for (const role of ROLES) {
      if (RANK[role] >= RANK[min]) continue;
      const who = A[ROLE_ACTOR[role]];
      s = await call(who, f.pub);
      expectIn(problems, who, method, pathOf(f.pub), s, r.below ?? [403], `${role} is below ${min}`);
    }

    // 4. The private board: members of the workspace without a seat get 404, on reads AND writes.
    if (r.priv) {
      for (const who of [A.vic, A.nick]) {
        s = await call(who, f.priv);
        expectIn(problems, who, method, pathOf(f.priv), s, [404], 'no seat on the private board');
      }
    }

    // 5. Reads that are allowed answer, and still carry no e-mail, hash or foreign data.
    if (isRead && !r.noPositive) {
      // Only the roles that reach the route's minimum: GET join-links/invites are admin-only (403 below it,
      // asserted in step 3), so "member read" is not expected of a viewer or a member there.
      const reads = {vic: 'viewer', nick: 'member', mia: 'member', adm: 'admin', ann: 'owner'} as const;
      for (const [key, role] of Object.entries(reads) as [keyof typeof reads, Role][]) {
        if (RANK[role] < RANK[min]) continue;
        const who = A[key];
        s = await call(who, f.pub);
        expectIn(problems, who, method, pathOf(f.pub), s, [200], 'member read');
      }
      if (r.priv) {
        for (const who of r.privAdminOnly ? [A.adm, A.ann] : [A.mia, A.adm, A.ann]) {
          s = await call(who, f.priv);
          expectIn(problems, who, method, pathOf(f.priv), s, [200], 'private board read');
        }
      }
      s = await call(A.bob, f.other);
      expectIn(problems, A.bob, method, pathOf(f.other), s, [200], 'own workspace read');
    }
    expect(problems, r.key).toEqual([]);
  });

  it.each(selfRows.map(r => [r.key, r] as const))('%s', async (_key, r) => {
    const A = actors();
    const method = r.key.split(' ')[0]!;
    const problems: string[] = [];
    const path = r.path ? r.path(f.pub, f) : `/${r.key.split(' /site-api/')[1]!}`;
    const body = r.body?.(f.pub, f);
    const s = await hit(problems, A.anon, method, path, body);
    expectIn(problems, A.anon, method, path, s, r.body ? [401, 422] : [401], 'signed out');
    if (method === 'GET') {
      // Own data only: nothing of the other workspace, nothing private for a user without a seat.
      for (const who of [A.bob, A.vic, A.nick, A.ann]) {
        const status = await hit(problems, who, method, path);
        expectIn(problems, who, method, path, status, [200], 'own data');
      }
    }
    expect(problems, r.key).toEqual([]);
  });

  it.each(permRows.map(r => [r.key, r] as const))('%s', async (_key, r) => {
    const A = actors();
    const method = r.key.split(' ')[0]!;
    const problems: string[] = [];
    const path = r.path!(f.pub, f);
    const body = r.body?.(f.pub, f);
    const s = await hit(problems, A.anon, method, path, body);
    expectIn(problems, A.anon, method, path, s, r.lenient ? [401, 422] : [401], 'signed out');
    // None of the six users holds a site permission (only SITE_OWNER_EMAILS accounts and granted roles do).
    for (const who of [A.ann, A.adm, A.vic, A.bob]) {
      const status = await hit(problems, who, method, path, body);
      expectIn(problems, who, method, path, status, r.lenient ? [403, 422] : [403], 'no site permission');
    }
    expect(problems, r.key).toEqual([]);
  });

  it('a workspace owner holds no site role; only the site owner reaches site routes', async () => {
    const roles = async (id: number) => (await db.userRole.findMany({where: {userId: id}, select: {role: {select: {slug: true}}}})).map(x => x.role.slug);
    for (const id of Object.values(f.u)) expect((await roles(id)).filter(r => r !== 'member')).toEqual([]); // 'member' is the default site role: no site permission
    const res = await siteOwner.get('/site-api/admin/users');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).toContain('ann@example.test'); // site:user:read: the one place emails show
    expect((await ann.get('/site-api/admin/users')).status).toBe(403);
  });

  it.each(publicRows.map(r => [r.key, r] as const))('%s', async (_key, r) => {
    const A = actors();
    const method = r.key.split(' ')[0]!;
    const problems: string[] = [];
    const path = r.path ? r.path(f.pub, f) : `/${r.key.split(' /site-api/')[1]!}`;
    // Public: anyone may ask; the answer never carries an e-mail, a hash or workspace data.
    for (const who of [A.anon, A.bob]) {
      const status = await hit(problems, who, method, path);
      if (status >= 500 && status !== 503) problems.push(`${who.name} ${method} ${path}: server error ${status}`);
      if (status === 401 || status === 403) problems.push(`${who.name} ${method} ${path}: a public route answered ${status}`);
    }
    expect(problems, r.key).toEqual([]);
  });

  it.each(platformRows.map(r => [r.key, r] as const))('%s', async (_key, r) => {
    // The platform's own sign-in system (tested in auth*.test.ts). Only what is cheap and safe here.
    if (!r.signedOut) return;
    const problems: string[] = [];
    const method = r.key.split(' ')[0]!;
    const path = `/${r.key.split(' /site-api/')[1]!}`.replace(':id', '1');
    const status = await hit(problems, actors().anon, method, path);
    expectIn(problems, actors().anon, method, path, status, r.signedOut, 'signed out');
    expect(problems, r.key).toEqual([]);
  });

  /* ------------------------------------------------------- ids of workspace B in A's routes */

  describe('ids from workspace B placed in the bodies, params and queries of A', () => {
    const rejectedOrIgnored = (status: number) => status >= 400 || status === 200 || status === 201;

    it('a card cannot be moved into a lane of B, or after a card of B', async () => {
      const before = await db.card.findUniqueOrThrow({where: {id: Number(f.pub.card2)}, select: {laneId: true, boardId: true, workspaceId: true, position: true}});
      const beforeB = await db.card.findUniqueOrThrow({where: {id: Number(f.other.card)}, select: {laneId: true, boardId: true, position: true, updatedRev: true}});
      const lane = await ann.post(`/site-api/cards/${f.pub.card2}/move`, {laneId: Number(f.other.lane1), afterId: null});
      expect(lane.status, 'laneId of B').toBeGreaterThanOrEqual(400);
      const after = await ann.post(`/site-api/cards/${f.pub.card2}/move`, {laneId: Number(f.pub.lane2), afterId: Number(f.other.card)});
      expect(rejectedOrIgnored(after.status)).toBe(true);
      const now = await db.card.findUniqueOrThrow({where: {id: Number(f.pub.card2)}, select: {laneId: true, boardId: true, workspaceId: true}});
      expect(now.boardId).toBe(before.boardId);
      expect(now.workspaceId).toBe(before.workspaceId);
      expect(now.laneId, 'never in a lane of B').not.toBe(Number(f.other.lane1));
      expect(await db.card.findUniqueOrThrow({where: {id: Number(f.other.card)}, select: {laneId: true, boardId: true, position: true, updatedRev: true}})).toEqual(beforeB);
      // put it back for the tests below
      await ann.post(`/site-api/cards/${f.pub.card2}/move`, {laneId: Number(f.pub.lane1), afterId: null});
    });

    it('a lane cannot be moved after a lane of B', async () => {
      const beforeB = await db.lane.findUniqueOrThrow({where: {id: Number(f.other.lane2)}, select: {position: true, boardId: true, updatedRev: true}});
      const res = await ann.post(`/site-api/lanes/${f.pub.lane2}/move`, {afterId: Number(f.other.lane1)});
      expect(rejectedOrIgnored(res.status)).toBe(true);
      expect(await db.lane.findUniqueOrThrow({where: {id: Number(f.other.lane2)}, select: {position: true, boardId: true, updatedRev: true}})).toEqual(beforeB);
      expect((await db.lane.findUniqueOrThrow({where: {id: Number(f.pub.lane2)}, select: {boardId: true}})).boardId).toBe(Number(f.pub.board));
    });

    it('a card of A takes no label of B, no member of B, and no cover from B', async () => {
      const label = await ann.request('PUT', `/site-api/cards/${f.pub.card}/labels/${f.other.label}`, {});
      expect(label.status, 'labelId of B').toBeGreaterThanOrEqual(400);
      const privLabel = await ann.request('PUT', `/site-api/cards/${f.pub.card}/labels/${f.priv.label}`, {});
      expect(privLabel.status, 'label of another board').toBeGreaterThanOrEqual(400);
      expect(await db.cardLabel.count({where: {cardId: Number(f.pub.card), labelId: {in: [Number(f.other.label), Number(f.priv.label)]}}})).toBe(0);

      const member = await ann.request('PUT', `/site-api/cards/${f.pub.card}/members/${f.u.bob}`, {});
      expect(member.status, 'userId of B').toBeGreaterThanOrEqual(400);
      expect(await db.cardMember.count({where: {cardId: Number(f.pub.card), userId: f.u.bob}})).toBe(0);
      // nick has no seat on the private board: not assignable to its cards.
      const noSeat = await ann.request('PUT', `/site-api/cards/${f.priv.card}/members/${f.u.nick}`, {});
      expect(noSeat.status, 'assignee without a seat').toBeGreaterThanOrEqual(400);
      expect(await db.cardMember.count({where: {cardId: Number(f.priv.card), userId: f.u.nick}})).toBe(0);

      const cover = await ann.request('PUT', `/site-api/cards/${f.pub.card}/cover`, {attachmentId: Number(f.attachB)});
      expect(cover.status, 'attachmentId of B').toBeGreaterThanOrEqual(400);
      expect((await db.card.findUniqueOrThrow({where: {id: Number(f.pub.card)}, select: {coverFileId: true}})).coverFileId).toBeNull();
    });

    it('a comment mentions nobody outside the card’s audience', async () => {
      const res = await ann.post(`/site-api/cards/${f.priv.card}/comments`, {body: 'hello ZQXPRIV', mentions: [f.u.bob, f.u.nick, f.u.vic]});
      expect(rejectedOrIgnored(res.status)).toBe(true);
      const mentioned = await db.commentMention.findMany({where: {comment: {cardId: Number(f.priv.card)}}, select: {userId: true}});
      expect(mentioned.map(m => m.userId).filter(id => [f.u.bob, f.u.nick, f.u.vic].includes(id))).toEqual([]);
      expect(await db.notification.count({where: {userId: {in: [f.u.bob, f.u.nick, f.u.vic]}, cardId: Number(f.priv.card)}})).toBe(0);
    });

    it('a message takes no parent, card link or mention from B (or from the private board)', async () => {
      const before = await db.message.findUniqueOrThrow({where: {id: BigInt(f.other.msg)}, select: {replyCount: true}});
      const parent = await ann.post(`/site-api/conversations/${f.pub.conv}/messages`, {body: 'reply', clientId: 'authz-parent-01', parentId: f.other.msg});
      expect(parent.status, 'parentId of B').toBeGreaterThanOrEqual(400);
      const crossConv = await ann.post(`/site-api/conversations/${f.pub.conv}/messages`, {body: 'reply', clientId: 'authz-parent-02', parentId: f.priv.msg});
      expect(crossConv.status, 'parentId of another conversation').toBeGreaterThanOrEqual(400);
      expect((await db.message.findUniqueOrThrow({where: {id: BigInt(f.other.msg)}, select: {replyCount: true}})).replyCount).toBe(before.replyCount);

      const linked = await ann.post(`/site-api/conversations/${f.pub.conv}/messages`, {
        body: 'links',
        clientId: 'authz-links-001',
        cardIds: [Number(f.other.card), Number(f.priv.card)],
        mentions: [f.u.bob, f.u.nick],
      });
      expect(rejectedOrIgnored(linked.status)).toBe(true);
      expect(await db.messageCardRef.count({where: {cardId: {in: [Number(f.other.card)]}}}), 'card of B linked').toBe(0);
      expect(await db.messageMention.count({where: {userId: f.u.bob}}), 'user of B mentioned').toBe(0);
      expect(JSON.stringify(linked.json)).not.toMatch(B_MARK);
      // A viewer without a seat must not even learn the private card's title through a link.
      const asNick = await nick.get(`/site-api/conversations/${f.pub.conv}/messages`);
      expect(JSON.stringify(asNick.json)).not.toMatch(PRIV_MARK);
    });

    it('a conversation cannot be started with a user of B', async () => {
      for (const body of [
        {kind: 'dm', userIds: [f.u.bob]},
        {kind: 'group', name: 'x', userIds: [f.u.bob, f.u.mia]},
      ]) {
        const res = await ann.post(`/site-api/workspaces/${f.pub.ws}/conversations`, body);
        expect(rejectedOrIgnored(res.status)).toBe(true);
      }
      expect(await db.conversationMember.count({where: {userId: f.u.bob, workspaceId: Number(f.pub.ws)}})).toBe(0);
    });

    it('B’s lane, ids and cursors do nothing in A’s inbox, list and board routes', async () => {
      const triage = await ann.post(`/site-api/inbox/cards/${f.pub.inboxCard}/triage`, {laneId: Number(f.other.lane1)});
      expect(triage.status, 'laneId of B').toBeGreaterThanOrEqual(400);
      expect((await db.card.findUniqueOrThrow({where: {id: Number(f.pub.inboxCard)}, select: {workspaceId: true}})).workspaceId).toBe(Number(f.pub.ws));
      const bobsInbox = await ann.post(`/site-api/inbox/cards/${f.other.inboxCard}/triage`, {laneId: Number(f.pub.lane1)});
      expect(bobsInbox.status, 'inbox card of B').toBe(404);

      for (const q of [`before=${f.other.card}`, `after=${f.other.card}`, `before=${f.other.lane1}&after=${f.other.card2}`]) {
        const res = await ann.get(`/site-api/lanes/${f.pub.lane1}/cards?${q}`);
        expect(res.status, q).toBeLessThan(500);
        expect(JSON.stringify(res.json), q).not.toMatch(B_MARK);
      }
      for (const path of [
        `/workspaces/${f.pub.ws}/boards?before=${f.other.board}`,
        `/workspaces/${f.pub.ws}/inbox?before=${f.other.inboxCard}`,
        `/workspaces/${f.pub.ws}/members?after=${f.u.bob}`,
        `/workspaces/${f.pub.ws}/search?q=zqx&before=${f.other.card}`,
        `/conversations/${f.pub.conv}/messages?before=${f.other.msg}`,
        `/boards/${f.pub.board}/changes?since=0&after=${f.other.card}`,
        `/notifications?workspaceId=${f.other.ws}`,
        `/notifications?before=${f.notifB}`,
      ]) {
        const res = await ann.get(`/site-api${path}`);
        expect(res.status, path).toBeLessThan(500);
        expect(JSON.stringify(res.json), path).not.toMatch(B_MARK);
        expect(JSON.stringify(res.json), path).not.toContain(`"id":"${f.notifB}"`);
      }
    });

    it('ids of B in members, transfer and notification routes change nothing', async () => {
      const transfer = await ann.post(`/site-api/workspaces/${f.pub.ws}/transfer`, {userId: f.u.bob});
      expect(transfer.status, 'transfer to a user outside the workspace').toBeGreaterThanOrEqual(400);
      expect((await db.workspaceMember.findUniqueOrThrow({where: {workspaceId_userId: {workspaceId: Number(f.pub.ws), userId: f.u.ann}}, select: {role: true}})).role).toBe('owner');
      for (const [method, body] of [['PATCH', {role: 'admin'}], ['DELETE', undefined]] as const) {
        const res = await ann.request(method, `/site-api/workspaces/${f.pub.ws}/members/${f.u.bob}`, body);
        expect(res.status, `${method} member of B`).toBe(404);
      }
      expect(await db.workspaceMember.count({where: {workspaceId: Number(f.pub.ws), userId: f.u.bob}})).toBe(0);
      // B's invite and join link are not A's to revoke.
      expect((await ann.delete(`/site-api/workspaces/${f.pub.ws}/invites/${f.other.invite}`)).status).toBe(404);
      expect((await ann.delete(`/site-api/workspaces/${f.pub.ws}/join-links/${f.other.link}`)).status).toBe(404);
      expect(await db.workspaceInvite.count({where: {id: Number(f.other.invite)}})).toBe(1);
      expect(await db.workspaceJoinLink.count({where: {id: Number(f.other.link), revokedAt: null}})).toBe(1);
      // Another user's notification is a 404 and stays unread; read-all only touches the caller's own.
      expect((await bob.post(`/site-api/notifications/${f.notifA}/read`)).status).toBe(404);
      await bob.post('/site-api/notifications/read-all', {workspaceId: Number(f.pub.ws)});
      await ann.post('/site-api/notifications/read-all', {workspaceId: Number(f.other.ws)});
      expect((await db.notification.findUniqueOrThrow({where: {id: BigInt(f.notifA)}, select: {readAt: true}})).readAt).toBeNull();
      expect((await db.notification.findUniqueOrThrow({where: {id: BigInt(f.notifB)}, select: {readAt: true}})).readAt).toBeNull();
    });

    it('owner, workspace and board ids in a create body are ignored', async () => {
      const boardsOfB = await db.board.count({where: {workspaceId: Number(f.other.ws)}});
      const made = await ann.post(`/site-api/workspaces/${f.pub.ws}/boards`, {name: 'ZQXALPHA injected', workspaceId: Number(f.other.ws), createdBy: f.u.bob});
      expect(made.status).toBe(201);
      expect(await db.board.count({where: {workspaceId: Number(f.other.ws)}})).toBe(boardsOfB);
      const board = await db.board.findFirstOrThrow({where: {name: 'ZQXALPHA injected'}, select: {workspaceId: true, createdBy: true}});
      expect(board).toEqual({workspaceId: Number(f.pub.ws), createdBy: f.u.ann});

      const cardsOfB = await db.card.count({where: {workspaceId: Number(f.other.ws)}});
      const added = await ann.post(`/site-api/lanes/${f.pub.lane1}/cards`, {title: 'ZQXALPHA injected card', boardId: Number(f.other.board), laneId: Number(f.other.lane1), workspaceId: Number(f.other.ws), createdBy: f.u.bob});
      expect(added.status).toBe(201);
      expect(await db.card.count({where: {workspaceId: Number(f.other.ws)}})).toBe(cardsOfB);
      const card = await db.card.findFirstOrThrow({where: {title: 'ZQXALPHA injected card'}, select: {workspaceId: true, boardId: true, laneId: true, createdBy: true}});
      expect(card).toEqual({workspaceId: Number(f.pub.ws), boardId: Number(f.pub.board), laneId: Number(f.pub.lane1), createdBy: f.u.ann});

      const label = await ann.post(`/site-api/boards/${f.pub.board}/labels`, {name: 'ZQXALPHA injected', colorHex: '#112233', boardId: Number(f.other.board), workspaceId: Number(f.other.ws)});
      expect(rejectedOrIgnored(label.status)).toBe(true);
      expect(await db.label.count({where: {boardId: Number(f.other.board), name: 'ZQXALPHA injected'}})).toBe(0);
    });

    it('search, my day and the inbox never reach across workspaces or into the private board', async () => {
      for (const who of [vic, nick]) {
        for (const path of [`/workspaces/${f.pub.ws}/search?q=zqx`, '/my-day', `/workspaces/${f.pub.ws}/conversations`, '/chat/pulse', '/notifications', `/workspaces/${f.pub.ws}/boards`]) {
          const res = await who.get(`/site-api${path}`);
          expect(res.status, path).toBe(200);
          expect(JSON.stringify(res.json), `${path} as a user without a seat`).not.toMatch(/ZQXPRIV|ZQXBETA/);
        }
      }
      for (const path of [`/workspaces/${f.other.ws}/search?q=zqx`, '/my-day', '/workspaces', '/notifications']) {
        const res = await bob.get(`/site-api${path}`);
        expect(res.status, path).toBe(200);
        expect(JSON.stringify(res.json), `${path} as owner of B`).not.toMatch(A_MARK);
      }
      // Search with the private marker finds it for the board member and for nobody else.
      const seen = async (b: Browser) => JSON.stringify((await b.get(`/site-api/workspaces/${f.pub.ws}/search?q=ZQXPRIV`)).json);
      expect(await seen(mia)).toMatch(PRIV_MARK);
      expect(await seen(nick)).not.toMatch(PRIV_MARK);
      expect(await seen(vic)).not.toMatch(PRIV_MARK);
    });
  });
});
