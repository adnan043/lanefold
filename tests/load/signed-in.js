// A signed-in person using the app: who am I, my workspaces, a workspace's boards, a board.
// Needs a TEST account (never a real person's) without two-step sign-in:
//
//   BASE_URL=http://localhost:4321 LOAD_EMAIL=load@example.test LOAD_PASSWORD=… k6 run tests/load/signed-in.js
//
// Each virtual user signs in ONCE with its own cookie jar, then refreshes its session when the
// 10-minute access token runs out, as a browser does. Successful sign-ins don't count toward the
// rate limits, but a wrong password does: check the account with a smoke run first.
import http from 'k6/http';
import {check, fail, group, sleep} from 'k6';

import {BASE_URL, optionsFor} from './lib/config.js';

const EMAIL = __ENV.LOAD_EMAIL;
const PASSWORD = __ENV.LOAD_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('Set LOAD_EMAIL and LOAD_PASSWORD (a test account, no two-step sign-in).');

export const options = optionsFor(
  {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:api}': ['p(95)<800'],
    'http_req_duration{name:/site-api/boards/:id}': ['p(95)<1200'],
    checks: ['rate>0.99'],
  },
  // k6 empties each user's cookie jar after every iteration by default; a browser keeps its
  // session, so keep it too (otherwise every iteration after the first runs signed out).
  {noCookiesReset: true}
);

// Local hosts get the plain names; everywhere else the __Host- prefixed ones (src/platform/auth/cookies.ts).
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|[^/]*\.localhost)(:|\/|$)/.test(BASE_URL);
const CSRF_COOKIE = LOCAL ? 'site_csrf' : '__Host-site_csrf';

let signedIn = false; // per virtual user

function csrfToken() {
  const jar = http.cookieJar().cookiesForURL(BASE_URL);
  return (jar[CSRF_COOKIE] || [])[0] || '';
}

/** A write the way the site's own pages send it: same origin, CSRF header. */
// Answers the script expects and handles, so they don't count toward `http_req_failed`:
// a busy sign-in (429, retried) and an expired access token (401, refreshed).
const AUTH_OK = http.expectedStatuses({min: 200, max: 299}, 429);
const READ_OK = http.expectedStatuses({min: 200, max: 299}, 401);

function post(path, body) {
  return http.post(`${BASE_URL}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers: {'Content-Type': 'application/json', Origin: BASE_URL, 'x-csrf-token': csrfToken()},
    tags: {kind: 'auth', name: path},
    responseCallback: AUTH_OK,
  });
}

function signIn() {
  http.get(`${BASE_URL}/site-api/auth/csrf`, {tags: {kind: 'auth', name: '/site-api/auth/csrf'}});
  // Every virtual user shares ONE test account, and the site runs one sign-in per account at a
  // time (a busy one answers 429 without counting it): with many users, wait and try again.
  let res = post('/site-api/auth/login', {email: EMAIL, password: PASSWORD});
  for (let tries = 1; res.status === 429 && tries < 30; tries++) {
    sleep(1 + Math.random() * 4);
    res = post('/site-api/auth/login', {email: EMAIL, password: PASSWORD});
  }
  if (res.status === 202) fail('The test account has two-step sign-in on: use one without it.');
  if (!check(res, {'signed in': r => r.status === 200})) fail(`Sign-in failed (${res.status}): ${res.body}`);
  signedIn = true;
}

/** GET as the signed-in user; refreshes the session once if the access token ran out. */
function api(path, name = path) {
  const params = {tags: {kind: 'api', name}};
  let res = http.get(`${BASE_URL}${path}`, {...params, responseCallback: READ_OK});
  if (res.status === 401) {
    const refreshed = post('/site-api/auth/refresh');
    if (refreshed.status !== 200) signIn();
    res = http.get(`${BASE_URL}${path}`, params);
  }
  if (res.status >= 400 && loggedErrors < 5) {
    loggedErrors++; // a few per virtual user: enough to see why, not a flood
    console.warn(`${name} → ${res.status} ${String(res.body).slice(0, 160)}`);
  }
  return res;
}

let loggedErrors = 0; // per virtual user

export default function () {
  if (!signedIn) signIn();

  group('app', () => {
    const me = api('/site-api/me');
    check(me, {'me 200': r => r.status === 200, 'me is a user': r => r.json('viewer.state') === 'user'});

    const ws = api('/site-api/workspaces');
    check(ws, {'workspaces 200': r => r.status === 200});
    const workspaces = ws.status === 200 ? ws.json('items') || [] : [];
    sleep(Math.random() + 0.5);

    if (workspaces.length) {
      const w = workspaces[Math.floor(Math.random() * workspaces.length)];
      const boards = api(`/site-api/workspaces/${w.id}/boards`, '/site-api/workspaces/:id/boards');
      check(boards, {'boards 200': r => r.status === 200});
      const items = boards.status === 200 ? boards.json('items') || [] : [];
      sleep(Math.random() + 0.5);

      if (items.length) {
        const b = items[Math.floor(Math.random() * items.length)];
        check(api(`/site-api/boards/${b.id}`, '/site-api/boards/:id'), {'board 200': r => r.status === 200});
      }
    }
  });

  sleep(Math.random() * 3 + 2); // a person working on a board, not refreshing it nonstop
}
