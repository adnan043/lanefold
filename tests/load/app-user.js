// A realistic signed-in person on the Kanban + chat app, at the app's OWN polling rhythm.
// Needs tests/load/.fixtures.json from seed.mjs (local only).
//
//   k6 run -e SCENARIO=hot|spread -e VUS=50 [-e RAMP=1m -e HOLD=3m -e CHAT_OPEN=0.5] tests/load/app-user.js
//
// Each virtual user (VU) is one test account, signed in ONCE (its cookie jar kept, refreshed on 401), and runs the
// timers the browser runs (src/app/use-board-sync.ts, src/app/chat/api.ts, src/app/notifications/bell.tsx):
//   board sync   GET /boards/:id/changes?since=rev     every 5 s
//   chat pulse   GET /chat/pulse                       every ~3 s with the chat open (CHAT_OPEN share of VUs), else 30 s
//                + GET /conversations/:id/messages?after=  when the pulse says the open chat moved
//   bell         GET /notifications/unread-count       every 30 s
// plus ONE action every 3-10 s (think time): 70% reads, 20% card writes, 10% chat sends.
//
// Real-time measurements (same machine clock for sender and receiver):
//   board_sync_ms   card title carries "t=<ms> v=<vu>": time from the write to the poll that delivers it to ANOTHER VU
//   chat_delivery_ms message carries "[lt v s t]": time from send to another VU's poll that returns it
//   chat_gap / chat_dup  per-sender sequence numbers: a skipped or repeated message seen by a receiver
import http from 'k6/http';
import exec from 'k6/execution';
import {check, sleep} from 'k6';
import {Counter, Trend} from 'k6/metrics';

const F = JSON.parse(open('./.fixtures.json'));
const BASE = F.baseUrl;
const API = `${BASE}/site-api`;
const SCENARIO = __ENV.SCENARIO || 'spread';
if (!['hot', 'spread'].includes(SCENARIO)) throw new Error('SCENARIO must be hot or spread');
const VUS = Number(__ENV.VUS || 10);
if (VUS > F.users.length) throw new Error(`VUS=${VUS} but only ${F.users.length} test users were seeded`);
const CHAT_OPEN = Number(__ENV.CHAT_OPEN ?? 0.5);

export const options = {
  scenarios: {
    users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        {duration: __ENV.RAMP || '1m', target: VUS},
        {duration: __ENV.HOLD || '3m', target: VUS},
        {duration: '20s', target: 0},
      ],
      gracefulRampDown: '15s',
    },
  },
  noCookiesReset: true,
  discardResponseBodies: false,
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // The first entry of the two http lists is a STOP condition (abort: errors over 5 %, p95 over 3 s, judged after a
  // minute of data); every other entry is a TARGET, reported pass/fail without stopping the run.
  thresholds: {
    'http_req_failed{kind:app}': [{threshold: 'rate<0.05', abortOnFail: true, delayAbortEval: '1m'}, 'rate<0.01'],
    'http_req_duration{kind:app}': [{threshold: 'p(95)<3000', abortOnFail: true, delayAbortEval: '1m'}, 'p(95)<500', 'p(99)<1000'],
    board_sync_ms: ['p(95)<6000'],
    chat_delivery_ms: ['p(95)<4000'],
    chat_gap: ['count==0'],
    chat_dup: ['count==0'],
    'http_reqs{kind:app}': ['count>=0'],
    'http_req_failed{kind:auth}': ['rate>=0'],
    'http_req_duration{kind:auth}': ['max>=0'],
  },
};
// Sub-metrics for the report (always pass): failures by operation, timings by kind of request and by endpoint.
const OPS = ['login', 'read', 'filter', 'sync', 'chat-read', 'chat-send', 'chat-open', 'card-create', 'card-move', 'card-edit', 'card-assign', 'card-archive'];
for (const op of OPS) {
  options.thresholds[`op_failed{op:${op}}`] = ['count>=0'];
  options.thresholds[`http_req_duration{op:${op}}`] = ['max>=0'];
  options.thresholds[`http_reqs{op:${op}}`] = ['count>=0'];
}
for (const name of ['GET /boards/:id', 'GET /boards/:id/changes', 'GET /chat/pulse', 'POST /cards/:id/move', 'POST /lanes/:id/cards', 'PATCH /cards/:id', 'POST /conversations/:id/messages', 'GET /cards/:id/detail', 'GET /workspaces/:id/search']) {
  options.thresholds[`http_req_duration{name:${name}}`] = ['max>=0'];
}

const boardSync = new Trend('board_sync_ms', true);
const chatDelivery = new Trend('chat_delivery_ms', true);
const chatGap = new Counter('chat_gap');
const chatDup = new Counter('chat_dup');
const chatSent = new Counter('chat_sent_ok');
const chatSeen = new Counter('chat_received');
const opFail = new Counter('op_failed');
const cardWrites = new Counter('card_writes_ok');
const laneFull = new Counter('lane_full');
const cardGone = new Counter('card_gone');

/* ------------------------------------------------------------------------------------------- per-VU state */
let me = null; // {email, id, ...}
let ctx = null; // {workspaceId, board: {id, lanes, conversationId}}
let started = 0;
let rev = '0';
let cards = new Map(); // cardId -> laneId
let seenWrites = new Set(); // "<cardId>:<t>"
let lastSeq = 0;
let senders = new Map(); // vu -> last s seen
let seenMsg = new Set(); // "v:s"
let mySeq = 0;
let chatOpen = false;
let logged = 0; // errors printed by this VU (a few, to see why)
const next = {board: 0, pulse: 0, bell: 0, action: 0};

const csrf = () => (http.cookieJar().cookiesForURL(BASE).site_csrf || [])[0] || '';
const OK = http.expectedStatuses({min: 200, max: 299});
const OK_OR_FULL = http.expectedStatuses({min: 200, max: 299}, 409);
// A card another VU just archived answers 404: correct, and what a real board sees in a race. Counted as card_gone.
const CARD_OK = http.expectedStatuses({min: 200, max: 299}, 404);
const CARD_OK_OR_FULL = http.expectedStatuses({min: 200, max: 299}, 404, 409);

function req(method, path, body, name, op, expected = OK) {
  const params = {
    headers: {Origin: BASE, 'x-csrf-token': csrf(), ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
    tags: {kind: 'app', name, op},
    responseCallback: expected,
    timeout: '20s',
  };
  const payload = body === undefined ? null : JSON.stringify(body);
  let res = http.request(method, `${API}${path}`, payload, params);
  if (res.status === 401) {
    // Access token ran out (10 min): refresh once, as the browser does.
    http.post(`${API}/auth/refresh`, null, {headers: {Origin: BASE, 'x-csrf-token': csrf()}, tags: {kind: 'auth', name: 'refresh'}});
    res = http.request(method, `${API}${path}`, payload, params);
  }
  const tolerated = (res.status === 409 && (expected === OK_OR_FULL || expected === CARD_OK_OR_FULL)) || (res.status === 404 && (expected === CARD_OK || expected === CARD_OK_OR_FULL));
  if (res.status === 404 && tolerated) cardGone.add(1);
  if (res.status >= 400 && !tolerated) {
    opFail.add(1, {op});
    if (logged++ < 3) console.warn(`FAIL ${op} ${name} → ${res.status} ${String(res.body || res.error || '').slice(0, 140)}`);
  }
  return res;
}
const json = res => {
  try {
    return res.json();
  } catch {
    return null;
  }
};

function signIn() {
  http.get(`${API}/auth/csrf`, {tags: {kind: 'auth', name: 'csrf'}});
  for (let tries = 0; tries < 20; tries++) {
    const res = http.post(`${API}/auth/login`, JSON.stringify({email: me.email, password: F.password}), {
      headers: {'Content-Type': 'application/json', Origin: BASE, 'x-csrf-token': csrf()},
      tags: {kind: 'auth', name: 'login'},
      responseCallback: http.expectedStatuses(200, 429),
    });
    if (res.status === 200) return true;
    if (res.status !== 429) break;
    sleep(1 + Math.random() * 2);
  }
  opFail.add(1, {op: 'login'});
  return false;
}

/* ------------------------------------------------------------------------------------------- board */
const MARK = /t=(\d{13}) v=(\d+)/;
function note(card, live) {
  cards.set(card.id, card.laneId);
  const m = MARK.exec(card.title || '');
  if (!m) return;
  const key = `${card.id}:${m[1]}`;
  if (seenWrites.has(key)) return;
  if (seenWrites.size > 5000) seenWrites = new Set();
  seenWrites.add(key);
  const t = Number(m[1]);
  // Only another VU's write, made while this VU was already watching.
  if (live && Number(m[2]) !== exec.vu.idInTest && t >= started) boardSync.add(Date.now() - t);
}

function loadBoard() {
  const res = req('GET', `/boards/${ctx.board.id}`, undefined, 'GET /boards/:id', 'read');
  const b = json(res);
  if (res.status !== 200 || !b) return;
  rev = String(b.board?.rev ?? rev);
  cards = new Map();
  for (const lane of b.lanes || []) for (const c of lane.cards || []) note({...c, laneId: lane.id}, false);
}

function pollBoard() {
  const res = req('GET', `/boards/${ctx.board.id}/changes?since=${rev}`, undefined, 'GET /boards/:id/changes', 'sync');
  const d = json(res);
  if (res.status !== 200 || !d) return;
  if (d.truncated) return loadBoard();
  for (const c of d.cards || []) note(c, true);
  for (const id of d.removed || []) cards.delete(id);
  if (BigInt(d.rev) > BigInt(rev)) rev = d.rev;
}

/* ------------------------------------------------------------------------------------------- chat */
const MSG = /\[lt v=(\d+) s=(\d+) t=(\d{13})\]/;
function readMessages() {
  for (let page = 0; page < 5; page++) {
    const res = req('GET', `/conversations/${ctx.board.conversationId}/messages?after=${lastSeq}`, undefined, 'GET /conversations/:id/messages?after', 'chat-read');
    const d = json(res);
    if (res.status !== 200 || !d) return;
    for (const m of d.items || []) {
      lastSeq = Math.max(lastSeq, m.seq);
      const k = MSG.exec(m.body || '');
      if (!k) continue;
      const v = Number(k[1]);
      const s = Number(k[2]);
      if (v === exec.vu.idInTest) continue;
      const key = `${v}:${s}`;
      if (seenMsg.has(key)) {
        chatDup.add(1);
        continue;
      }
      if (seenMsg.size > 20000) seenMsg = new Set();
      seenMsg.add(key);
      chatSeen.add(1);
      const prev = senders.get(v);
      if (prev !== undefined && s > prev + 1) chatGap.add(s - prev - 1);
      if (prev === undefined || s > prev) senders.set(v, s);
      const t = Number(k[3]);
      if (t >= started) chatDelivery.add(Date.now() - t);
    }
    if (!d.more) return;
  }
}

function pulse() {
  const res = req('GET', '/chat/pulse', undefined, 'GET /chat/pulse', 'sync');
  const d = json(res);
  if (res.status !== 200 || !d || !chatOpen) return;
  const mine = (d.items || []).find(i => i.conversationId === ctx.board.conversationId);
  if (mine && mine.lastSeq > lastSeq) readMessages();
}

function sendMessage() {
  mySeq += 1;
  const now = Date.now();
  const others = F.users.length > 1 ? F.users[(exec.vu.idInTest + 7) % Math.min(VUS, F.users.length)] : null;
  const mention = others && others.id !== me.id && Math.random() < 0.3;
  const body = {
    body: `${mention ? '@LT ' : ''}load test message [lt v=${exec.vu.idInTest} s=${mySeq} t=${now}]`,
    clientId: `lt${exec.vu.idInTest}x${mySeq}x${now}`.slice(0, 40),
    lastSeenSeq: lastSeq,
    ...(mention ? {mentions: [others.id]} : {}),
  };
  let res = req('POST', `/conversations/${ctx.board.conversationId}/messages`, body, 'POST /conversations/:id/messages', 'chat-send');
  // A failed send is retried ONCE with the SAME clientId (the server makes it idempotent), like the composer.
  if (res.status >= 500 || res.status === 0) res = req('POST', `/conversations/${ctx.board.conversationId}/messages`, body, 'POST /conversations/:id/messages', 'chat-send');
  if (res.status >= 200 && res.status < 300) chatSent.add(1);
  else mySeq -= 1; // never sent: receivers must not count a gap for it
}

/* ------------------------------------------------------------------------------------------- actions */
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const someCard = () => (cards.size ? pick([...cards.keys()]) : null);
const lanes = () => ctx.board.lanes;
const stamp = () => `t=${Date.now()} v=${exec.vu.idInTest}`;

function readAction() {
  const r = Math.random();
  const card = someCard();
  if (r < 0.25) return loadBoard();
  if (r < 0.6 && card) return req('GET', `/cards/${card}/detail`, undefined, 'GET /cards/:id/detail', 'read', CARD_OK);
  if (r < 0.7) return req('GET', `/workspaces/${ctx.workspaceId}/boards`, undefined, 'GET /workspaces/:id/boards', 'read');
  if (r < 0.8) return req('GET', '/workspaces', undefined, 'GET /workspaces', 'read');
  if (r < 0.9) return req('GET', `/workspaces/${ctx.workspaceId}/search?q=seed`, undefined, 'GET /workspaces/:id/search', 'filter');
  return req('GET', `/lanes/${pick(lanes())}/cards`, undefined, 'GET /lanes/:id/cards', 'read');
}

function writeAction() {
  const r = Math.random();
  const card = someCard();
  let res;
  if (r < 0.2 || !card) {
    res = req('POST', `/lanes/${pick(lanes())}/cards`, {title: `LT card ${stamp()}`}, 'POST /lanes/:id/cards', 'card-create', OK_OR_FULL);
    if (res.status === 409) laneFull.add(1);
    const items = json(res)?.items;
    if (items) for (const c of items) cards.set(c.id, c.laneId);
  } else if (r < 0.5) {
    res = req('POST', `/cards/${card}/move`, {laneId: pick(lanes()), afterId: null}, 'POST /cards/:id/move', 'card-move', CARD_OK_OR_FULL);
    if (res.status === 409) laneFull.add(1);
  } else if (r < 0.7) {
    res = req('PATCH', `/cards/${card}`, {title: `LT edit ${stamp()}`}, 'PATCH /cards/:id', 'card-edit', CARD_OK);
  } else if (r < 0.85) {
    const who = F.users[Math.floor(Math.random() * Math.min(VUS, F.users.length))];
    const sameWs = SCENARIO === 'hot' || who.spread.workspaceId === ctx.workspaceId;
    res = req('PUT', `/cards/${card}/members/${sameWs ? who.id : me.id}`, undefined, 'PUT /cards/:id/members/:userId', 'card-assign', CARD_OK);
  } else {
    res = req('POST', `/cards/${card}/archive`, undefined, 'POST /cards/:id/archive', 'card-archive', CARD_OK);
    if (res.status < 300) cards.delete(card);
  }
  // A 404 on a card someone else just archived is what a real board sees too: drop it locally.
  if (res && res.status === 404 && card) cards.delete(card);
  if (res && res.status < 300) cardWrites.add(1);
}

/* ------------------------------------------------------------------------------------------- the VU loop */
function setup1() {
  me = F.users[(exec.vu.idInTest - 1) % F.users.length];
  ctx =
    SCENARIO === 'hot'
      ? {workspaceId: F.hot.workspaceId, board: F.hot.board}
      : {workspaceId: me.spread.workspaceId, board: me.spread.boards[exec.vu.idInTest % 2]};
  chatOpen = Math.random() < CHAT_OPEN;
  if (!signIn()) return false;
  started = Date.now();
  // Opening the board and its chat, as the page does.
  req('GET', '/me', undefined, 'GET /me', 'read');
  loadBoard();
  req('POST', `/boards/${ctx.board.id}/conversation`, undefined, 'POST /boards/:id/conversation', 'chat-open');
  const first = json(req('GET', `/conversations/${ctx.board.conversationId}/messages`, undefined, 'GET /conversations/:id/messages', 'chat-read'));
  lastSeq = first?.lastSeq ?? 0;
  const t = Date.now();
  next.board = t + 5000 * Math.random();
  next.pulse = t + 3000 * Math.random();
  next.bell = t + 30000 * Math.random();
  next.action = t + 3000 + Math.random() * 7000;
  return true;
}

export default function () {
  if (!me && !setup1()) {
    me = null;
    sleep(5);
    return;
  }
  const wake = Math.min(next.board, next.pulse, next.bell, next.action);
  const wait = (wake - Date.now()) / 1000;
  if (wait > 0) sleep(wait);
  const now = Date.now();
  if (now >= next.board) {
    pollBoard();
    next.board = Date.now() + 5000;
  }
  if (now >= next.pulse) {
    pulse();
    next.pulse = Date.now() + (chatOpen ? 3000 : 30000) + Math.random() * 500;
  }
  if (now >= next.bell) {
    req('GET', '/notifications/unread-count', undefined, 'GET /notifications/unread-count', 'sync');
    next.bell = Date.now() + 30000;
  }
  if (now >= next.action) {
    const r = Math.random();
    if (r < 0.7) readAction();
    else if (r < 0.9) writeAction();
    else sendMessage();
    next.action = Date.now() + 3000 + Math.random() * 7000;
  }
}

export function handleSummary(data) {
  const out = __ENV.OUT || `tests/load/results/${SCENARIO}-${VUS}.json`;
  return {[out]: JSON.stringify(data, null, 1), stdout: ''};
}
