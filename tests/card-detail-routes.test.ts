import {beforeAll, describe, expect, it} from 'vitest';

import {app} from '../src/server/app';
import {Browser, configureEnv} from './integration/support/harness';

/** No database needed: every card-detail route is mounted and refuses a signed-out visitor. */
describe('card detail routes (signed out)', () => {
  beforeAll(configureEnv);
  const reads = ['/cards/1/detail', '/cards/1/activity', '/cards/1/people', '/cards/1/comments', '/attachments/1/view'];
  for (const path of reads) {
    it(`GET ${path} is 401`, async () => {
      expect((await new Browser(app).get(`/site-api${path}`)).status).toBe(401);
    });
  }
  it('writes are refused before they reach a handler', async () => {
    const browser = new Browser(app);
    const writes = [
      ['PATCH', '/cards/1/details'],
      ['POST', '/boards/1/labels'],
      ['PATCH', '/labels/1'],
      ['DELETE', '/labels/1'],
      ['PUT', '/cards/1/labels/1'],
      ['PUT', '/cards/1/members/1'],
      ['POST', '/cards/1/checklists'],
      ['PATCH', '/checklists/1'],
      ['DELETE', '/checklists/1'],
      ['POST', '/checklists/1/items'],
      ['PATCH', '/checklist-items/1'],
      ['DELETE', '/checklist-items/1'],
      ['POST', '/cards/1/comments'],
      ['PATCH', '/comments/1'],
      ['DELETE', '/comments/1'],
      ['POST', '/cards/1/attachments/link'],
      ['POST', '/cards/1/attachments/upload'],
      ['POST', '/attachments/1/complete'],
      ['PATCH', '/attachments/1'],
      ['DELETE', '/attachments/1'],
      ['PUT', '/cards/1/cover'],
      ['POST', '/boards/1/fields'],
      ['PUT', '/boards/1/fields/order'],
      ['PATCH', '/fields/1'],
      ['DELETE', '/fields/1'],
      ['POST', '/fields/1/options'],
      ['PATCH', '/field-options/1'],
      ['DELETE', '/field-options/1'],
      ['PUT', '/cards/1/fields/1'],
      ['POST', '/cards/1/copy'],
    ] as const;
    for (const [method, path] of writes) {
      const res = await browser.request(method, `/site-api${path}`, {title: 'x'});
      expect([401, 422], `${method} ${path}`).toContain(res.status);
    }
  });
});
