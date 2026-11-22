// What a signed-out visitor loads: the marketing pages, the blog, the sitemap and the
// public Site API reads. Optional: PUBLIC_BOARD_TOKEN=<a shared board's token> adds the
// public board page and its JSON.
//
//   BASE_URL=http://localhost:4321 k6 run tests/load/public.js
import http from 'k6/http';
import {check, group, sleep} from 'k6';

import {BASE_URL, optionsFor} from './lib/config.js';

const BOARD_TOKEN = __ENV.PUBLIC_BOARD_TOKEN || '';

export const options = optionsFor({
  http_req_failed: ['rate<0.01'],
  // Prerendered pages are files: they should be quick.
  'http_req_duration{kind:page}': ['p(95)<500'],
  // Server work (the Site API, the sitemap): a little slack for the database.
  'http_req_duration{kind:api}': ['p(95)<800'],
  checks: ['rate>0.99'],
});

const PAGES = ['/', '/features/', '/pricing/', '/about/', '/blog/'];

function get(path, kind, name = path) {
  return http.get(`${BASE_URL}${path}`, {tags: {kind, name}, redirects: 0});
}

export default function () {
  group('pages', () => {
    for (const path of PAGES) {
      const res = get(path, 'page');
      check(res, {[`${path} 200`]: r => r.status === 200, [`${path} is HTML`]: r => (r.headers['Content-Type'] || '').includes('text/html')});
      sleep(Math.random() * 2 + 0.5); // a person reading, not a bot hammering
    }
  });

  group('site-api', () => {
    const health = get('/site-api/health', 'api');
    check(health, {'health 200': r => r.status === 200, 'health ok': r => r.json('ok') === true});

    const me = get('/site-api/me', 'api');
    check(me, {'me 200 signed out': r => r.status === 200, 'me never cached': r => (r.headers['Cache-Control'] || '').includes('no-store')});

    check(get('/site-api/site', 'api'), {'site 200': r => r.status === 200});
    check(get('/sitemap.xml', 'api'), {'sitemap 200': r => r.status === 200});
  });

  if (BOARD_TOKEN) {
    group('public board', () => {
      check(get(`/b/${BOARD_TOKEN}`, 'api', '/b/:token'), {'board page 200': r => r.status === 200});
      check(get(`/site-api/public/boards/${BOARD_TOKEN}`, 'api', '/site-api/public/boards/:token'), {
        'board json 200': r => r.status === 200,
      });
    });
  }

  sleep(1);
}
