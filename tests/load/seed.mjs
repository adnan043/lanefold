// Test data for the load tests: made-up accounts, workspaces, boards, cards and board chats, ALL marked so
// cleanup.mjs can remove them (emails @loadtest.example.com, workspace names starting "LT-").
//
//   node --env-file=.env --import ./tests/load/lib/ts-hook.mjs tests/load/seed.mjs
//   USERS=500 BASE_URL=http://localhost:4321 …   (defaults shown)
//
// Accounts go in with SQL (sign-up is limited to a few per IP an hour, on purpose), with ONE password hash made by
// the platform's own hashPassword(). Everything else goes through the site's real API (workspaces, boards, lanes,
// cards, join links, joining, board chats), so the data is what the app itself writes.
// Writes tests/load/.fixtures.json (git-ignored) for the k6 scripts.
//
// Layout:
//   hot     one workspace "LT-hot" with EVERY test user, one board (4 lanes x 25 cards), its board chat
//   spread  one workspace per 10 users "LT-spread-NNN" (owned by the group's first user), 2 boards each
//           (4 lanes x 10 cards), board chats
import {writeFileSync} from 'node:fs';
import pg from 'pg';

import {hashPassword} from '../../src/platform/auth/password.ts';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:4321').replace(/\/+$/, '');
const N = Number(process.env.USERS || 500);
const GROUP = 10;
export const PASSWORD = 'LoadTest-Only-2026!x';
const CONCURRENCY = Number(process.env.SEED_CONCURRENCY || 6);

const local = u => /^(postgres(ql)?|https?):\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(u);
if (!local(BASE_URL)) throw new Error(`Refusing to seed a non-local site (${BASE_URL}).`);
if (!process.env.DATABASE_URL || !local(process.env.DATABASE_URL)) throw new Error('Refusing: DATABASE_URL must be a local database.');
if (!(Number.isInteger(N) && N >= 10 && N <= 500)) throw new Error('USERS must be 10..500 (a workspace holds up to 500 members).');

const email = i => `loadtest_user_${String(i).padStart(4, '0')}@loadtest.example.com`;

/* ---------------------------------------------------------------- tiny HTTP client with a cookie jar */
class Client {
  constructor() {
    this.jar = new Map();
  }
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  keep(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      this.jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
    }
  }
  async req(method, path, body) {
    const headers = {Origin: BASE_URL, Cookie: this.cookieHeader()};
    if (method !== 'GET') headers['x-csrf-token'] = this.jar.get('site_csrf') || '';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE_URL}/site-api${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
    this.keep(res);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return {status: res.status, json, text};
  }
  async ok(method, path, body) {
    const r = await this.req(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${r.text.slice(0, 200)}`);
    return r.json;
  }
  async signIn(address) {
    await this.req('GET', '/auth/csrf');
    for (let tries = 0; ; tries++) {
      const r = await this.req('POST', '/auth/login', {email: address, password: PASSWORD});
      if (r.status === 200) return this;
      if (r.status === 429 && tries < 20) {
        await new Promise(res => setTimeout(res, 500 + Math.random() * 1500));
        continue;
      }
      throw new Error(`sign-in ${address} → ${r.status} ${r.text.slice(0, 200)}`);
    }
  }
}

async function pool(items, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({length: CONCURRENCY}, run));
}

/* ---------------------------------------------------------------- 1. accounts (SQL) */
const db = new pg.Client({connectionString: process.env.DATABASE_URL});
await db.connect();
const existing = await db.query(`SELECT count(*)::int AS n FROM workspaces WHERE name LIKE 'LT-%'`);
if (existing.rows[0].n > 0) throw new Error('Load-test data is already there: run cleanup.mjs first.');

console.log(`hashing one password, inserting ${N} accounts…`);
const hash = await hashPassword(PASSWORD);
const emails = Array.from({length: N}, (_, k) => email(k + 1));
await db.query(
  `INSERT INTO users (email, password_hash, name, email_verified_at, updated_at)
   SELECT e, $2, 'LT ' || split_part(e, '@', 1), now(), now() FROM unnest($1::text[]) AS e
   ON CONFLICT (email) DO NOTHING`,
  [emails, hash]
);
const ids = new Map((await db.query(`SELECT id, email FROM users WHERE email = ANY($1::text[])`, [emails])).rows.map(r => [r.email, r.id]));

/** The plan the test workspaces are on: `team` (500 members, the most any workspace may have). */
const teamPlan = id => db.query(`UPDATE workspaces SET plan = 'team', member_limit = 500 WHERE id = $1 AND name LIKE 'LT-%'`, [id]);

/* ---------------------------------------------------------------- 2. workspaces, boards, cards (API) */
async function makeBoard(owner, workspaceId, name, cardsPerLane) {
  const {board} = await owner.ok('POST', `/workspaces/${workspaceId}/boards`, {name, lanes: ['To do', 'Doing', 'Review', 'Done']});
  const full = await owner.ok('GET', `/boards/${board.id}`);
  const lanes = full.lanes.map(l => l.id);
  for (const laneId of lanes) {
    for (let made = 0; made < cardsPerLane; made += 20) {
      const titles = Array.from({length: Math.min(20, cardsPerLane - made)}, (_, k) => `LT seed card ${made + k + 1}`);
      await owner.ok('POST', `/lanes/${laneId}/cards`, {titles});
    }
  }
  const conv = await owner.ok('POST', `/boards/${board.id}/conversation`);
  return {id: board.id, lanes, conversationId: conv.conversation.id};
}

async function joinLinks(owner, workspaceId, people) {
  const tokens = [];
  for (let k = 0; k < Math.ceil(people / 100); k++) {
    tokens.push((await owner.ok('POST', `/workspaces/${workspaceId}/join-links`, {role: 'member', expiresInDays: 1, maxUses: 100})).token);
  }
  return tokens;
}

console.log('hot workspace…');
const hotOwner = await new Client().signIn(email(1));
const hotWs = (await hotOwner.ok('POST', '/workspaces', {name: 'LT-hot'})).workspace.id;
await teamPlan(hotWs);
const hotBoard = await makeBoard(hotOwner, hotWs, 'LT-hot-board', 25);
const hotTokens = await joinLinks(hotOwner, hotWs, N - 1);

console.log(`spread workspaces (${Math.ceil(N / GROUP)})…`);
const groups = [];
for (let g = 0; g * GROUP < N; g++) groups.push(g);
const spread = new Array(groups.length);
await pool(groups, async g => {
  const owner = await new Client().signIn(email(g * GROUP + 1));
  const ws = (await owner.ok('POST', '/workspaces', {name: `LT-spread-${String(g + 1).padStart(3, '0')}`})).workspace.id;
  await teamPlan(ws);
  const boards = [await makeBoard(owner, ws, 'LT-board-A', 10), await makeBoard(owner, ws, 'LT-board-B', 10)];
  spread[g] = {workspaceId: ws, boards, token: (await joinLinks(owner, ws, GROUP))[0]};
});

/* ---------------------------------------------------------------- 3. everyone joins (API) */
console.log('members join with the links…');
let joined = 0;
await pool(emails, async (address, k) => {
  const i = k + 1;
  const g = Math.floor(k / GROUP);
  const c = await new Client().signIn(address);
  if (i !== 1) await c.ok('POST', '/invites/accept', {token: hotTokens[Math.floor((i - 2) / 100)]});
  if (k % GROUP !== 0) await c.ok('POST', '/invites/accept', {token: spread[g].token});
  if (++joined % 50 === 0) console.log(`  ${joined}/${N}`);
});

/* ---------------------------------------------------------------- 4. fixtures for k6 */
const users = emails.map((address, k) => {
  const g = Math.floor(k / GROUP);
  return {email: address, id: ids.get(address), spread: {workspaceId: spread[g].workspaceId, boards: spread[g].boards}};
});
const fixtures = {baseUrl: BASE_URL, password: PASSWORD, hot: {workspaceId: hotWs, board: hotBoard}, users};
writeFileSync(new URL('./.fixtures.json', import.meta.url), JSON.stringify(fixtures, null, 1));
await db.end();
console.log(`done: ${N} users, hot workspace ${hotWs}, ${spread.length} spread workspaces → tests/load/.fixtures.json`);
