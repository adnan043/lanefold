import {beforeAll, describe, expect, it} from 'vitest';

import {app} from '../src/server/app';
import {Browser, configureEnv} from './integration/support/harness';

/** No database needed: every board route refuses a signed-out visitor, and the routes are mounted. */
describe('boards routes (signed out)', () => {
  beforeAll(configureEnv);
  const reads = ['/workspaces', '/workspaces/1/boards', '/boards/1', '/boards/1/rev', '/boards/1/changes?since=0', '/lanes/1/cards'];
  for (const path of reads) {
    it(`GET ${path} is 401`, async () => {
      expect((await new Browser(app).get(`/site-api${path}`)).status).toBe(401);
    });
  }
  it('writes are refused before they reach a handler', async () => {
    const browser = new Browser(app);
    for (const [method, path] of [['POST', '/boards/1/lanes'], ['POST', '/cards/1/move'], ['PATCH', '/cards/1'], ['PUT', '/boards/1/star']] as const) {
      const res = await browser.request(method, `/site-api${path}`, {name: 'x'});
      expect([401, 422], `${method} ${path}`).toContain(res.status);
    }
  });
});
